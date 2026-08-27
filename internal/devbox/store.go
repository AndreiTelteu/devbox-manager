// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

package devbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

var ErrNotFound = errors.New("not found")

// Store is a file-backed inventory under Root:
//
//	hosts.yml          server inventory
//	recipes/*.ts       Bun shell recipe bodies (name = basename)
//	logs/*.json        run records (gitignored)
//
// Root is also a nested git repository, ignored by the parent project repo.
// Host and recipe mutations auto-commit; logs never enter git.
type Store struct {
	Root string
	mu   sync.Mutex
}

type Server struct {
	ID        int64     `json:"id" yaml:"id"`
	Name      string    `json:"name" yaml:"name"`
	Host      string    `json:"host" yaml:"host"`
	Port      int       `json:"port" yaml:"port"`
	Username  string    `json:"username" yaml:"username"`
	CreatedAt time.Time `json:"created_at" yaml:"created_at"`
	UpdatedAt time.Time `json:"updated_at" yaml:"updated_at"`
}

type Recipe struct {
	ID        int64     `json:"id" yaml:"id"`
	Name      string    `json:"name" yaml:"name"`
	Content   string    `json:"content" yaml:"-"`
	CreatedAt time.Time `json:"created_at" yaml:"created_at"`
	UpdatedAt time.Time `json:"updated_at" yaml:"updated_at"`
}

type Run struct {
	ID         int64      `json:"id"`
	RecipeID   int64      `json:"recipe_id"`
	ServerID   *int64     `json:"server_id,omitempty"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	ExitCode   *int       `json:"exit_code,omitempty"`
	Output     string     `json:"output"`
}

type hostsFile struct {
	NextID int64    `yaml:"next_id"`
	Items  []Server `yaml:"hosts"`
}

type recipesIndex struct {
	NextID int64        `yaml:"next_id"`
	Items  []recipeMeta `yaml:"recipes"`
}

type recipeMeta struct {
	ID        int64     `yaml:"id"`
	Name      string    `yaml:"name"`
	CreatedAt time.Time `yaml:"created_at"`
	UpdatedAt time.Time `yaml:"updated_at"`
}

var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func Open(ctx context.Context, root string) (*Store, error) {
	if root == "" {
		root = "data"
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	s := &Store{Root: abs}
	if err := s.ensureLayout(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return nil }

func (s *Store) hostsPath() string  { return filepath.Join(s.Root, "hosts.yml") }
func (s *Store) recipesDir() string { return filepath.Join(s.Root, "recipes") }
func (s *Store) recipesIndexPath() string {
	return filepath.Join(s.Root, "recipes.yml")
}
func (s *Store) logsDir() string { return filepath.Join(s.Root, "logs") }
func (s *Store) recipePath(name string) string {
	return filepath.Join(s.recipesDir(), name+".ts")
}

func (s *Store) ensureLayout() error {
	for _, dir := range []string{s.Root, s.recipesDir(), s.logsDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	logsIgnore := filepath.Join(s.logsDir(), ".gitignore")
	if _, err := os.Stat(logsIgnore); err != nil {
		if err := os.WriteFile(logsIgnore, []byte("*\n!.gitignore\n"), 0o644); err != nil {
			return err
		}
	}
	if _, err := os.Stat(s.hostsPath()); err != nil {
		if err := s.writeHosts(hostsFile{NextID: 1, Items: []Server{}}); err != nil {
			return err
		}
	}
	if _, err := os.Stat(s.recipesIndexPath()); err != nil {
		if err := s.writeRecipesIndex(recipesIndex{NextID: 1, Items: []recipeMeta{}}); err != nil {
			return err
		}
	}
	return s.ensureGit()
}

func (s *Store) ensureGit() error {
	gitDir := filepath.Join(s.Root, ".git")
	if _, err := os.Stat(gitDir); err == nil {
		return nil
	}
	if err := s.git("init"); err != nil {
		return fmt.Errorf("init data git repo: %w", err)
	}
	_ = s.git("config", "user.email", "devbox-manager@local")
	_ = s.git("config", "user.name", "devbox-manager")
	rootIgnore := filepath.Join(s.Root, ".gitignore")
	if _, err := os.Stat(rootIgnore); err != nil {
		// Ignore log payloads but keep logs/.gitignore tracked.
		if err := os.WriteFile(rootIgnore, []byte("logs/*\n!logs/.gitignore\n"), 0o644); err != nil {
			return err
		}
	}
	if err := s.git("add", "--", "hosts.yml", "recipes.yml", "recipes", ".gitignore", "logs/.gitignore"); err != nil {
		return err
	}
	// Initial commit may be empty-ish on first boot after files exist.
	_ = s.git("commit", "-m", "initial data layout")
	return nil
}

func (s *Store) git(args ...string) error {
	cmd := exec.Command("git", append([]string{"-C", s.Root}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s *Store) commit(message string, paths ...string) error {
	for _, p := range paths {
		full := filepath.Join(s.Root, p)
		if _, err := os.Stat(full); os.IsNotExist(err) {
			_ = s.git("rm", "--ignore-unmatch", "--", p)
			continue
		}
		if err := s.git("add", "--", p); err != nil {
			return err
		}
	}
	// Skip empty commits.
	cmd := exec.Command("git", "-C", s.Root, "diff", "--cached", "--quiet")
	if err := cmd.Run(); err == nil {
		return nil
	}
	return s.git("commit", "-m", message)
}

func (s *Store) readHosts() (hostsFile, error) {
	b, err := os.ReadFile(s.hostsPath())
	if err != nil {
		return hostsFile{}, err
	}
	var f hostsFile
	if err := yaml.Unmarshal(b, &f); err != nil {
		return hostsFile{}, err
	}
	if f.Items == nil {
		f.Items = []Server{}
	}
	if f.NextID < 1 {
		f.NextID = 1
		for _, h := range f.Items {
			if h.ID >= f.NextID {
				f.NextID = h.ID + 1
			}
		}
	}
	return f, nil
}

func (s *Store) writeHosts(f hostsFile) error {
	if f.Items == nil {
		f.Items = []Server{}
	}
	b, err := yaml.Marshal(&f)
	if err != nil {
		return err
	}
	return os.WriteFile(s.hostsPath(), b, 0o644)
}

func (s *Store) readRecipesIndex() (recipesIndex, error) {
	b, err := os.ReadFile(s.recipesIndexPath())
	if err != nil {
		return recipesIndex{}, err
	}
	var f recipesIndex
	if err := yaml.Unmarshal(b, &f); err != nil {
		return recipesIndex{}, err
	}
	if f.Items == nil {
		f.Items = []recipeMeta{}
	}
	if f.NextID < 1 {
		f.NextID = 1
		for _, r := range f.Items {
			if r.ID >= f.NextID {
				f.NextID = r.ID + 1
			}
		}
	}
	return f, nil
}

func (s *Store) writeRecipesIndex(f recipesIndex) error {
	if f.Items == nil {
		f.Items = []recipeMeta{}
	}
	b, err := yaml.Marshal(&f)
	if err != nil {
		return err
	}
	return os.WriteFile(s.recipesIndexPath(), b, 0o644)
}

func cleanServer(v Server) (Server, error) {
	v.Name = strings.TrimSpace(v.Name)
	v.Host = strings.TrimSpace(v.Host)
	v.Username = strings.TrimSpace(v.Username)
	if v.Name == "" || v.Host == "" || v.Username == "" {
		return v, errors.New("name, host, and username are required")
	}
	if v.Port == 0 {
		v.Port = 22
	}
	if v.Port < 1 || v.Port > 65535 {
		return v, errors.New("port must be between 1 and 65535")
	}
	return v, nil
}

func cleanRecipe(v Recipe) (Recipe, error) {
	v.Name = strings.TrimSpace(v.Name)
	if v.Name == "" || v.Content == "" {
		return v, errors.New("name and content are required")
	}
	if !safeName.MatchString(v.Name) {
		return v, errors.New("name must match [A-Za-z0-9][A-Za-z0-9._-]*")
	}
	return v, nil
}

func (s *Store) ListServers(ctx context.Context) ([]Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.readHosts()
	if err != nil {
		return nil, err
	}
	out := append([]Server(nil), f.Items...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Store) GetServer(ctx context.Context, id int64) (Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getServerLocked(id)
}

func (s *Store) getServerLocked(id int64) (Server, error) {
	f, err := s.readHosts()
	if err != nil {
		return Server{}, err
	}
	for _, h := range f.Items {
		if h.ID == id {
			return h, nil
		}
	}
	return Server{}, ErrNotFound
}

func (s *Store) CreateServer(ctx context.Context, v Server) (Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := cleanServer(v)
	if err != nil {
		return v, err
	}
	f, err := s.readHosts()
	if err != nil {
		return v, err
	}
	for _, h := range f.Items {
		if strings.EqualFold(h.Name, v.Name) {
			return v, errors.New("UNIQUE constraint failed: name already exists")
		}
	}
	now := time.Now().UTC()
	v.ID = f.NextID
	f.NextID++
	v.CreatedAt = now
	v.UpdatedAt = now
	f.Items = append(f.Items, v)
	if err := s.writeHosts(f); err != nil {
		return v, err
	}
	if err := s.commit(fmt.Sprintf("added %s host", v.Name), "hosts.yml"); err != nil {
		return v, err
	}
	return v, nil
}

func (s *Store) UpdateServer(ctx context.Context, id int64, v Server) (Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := cleanServer(v)
	if err != nil {
		return v, err
	}
	f, err := s.readHosts()
	if err != nil {
		return v, err
	}
	idx := -1
	for i, h := range f.Items {
		if h.ID == id {
			idx = i
		} else if strings.EqualFold(h.Name, v.Name) {
			return v, errors.New("UNIQUE constraint failed: name already exists")
		}
	}
	if idx < 0 {
		return v, ErrNotFound
	}
	prev := f.Items[idx]
	v.ID = id
	v.CreatedAt = prev.CreatedAt
	v.UpdatedAt = time.Now().UTC()
	f.Items[idx] = v
	if err := s.writeHosts(f); err != nil {
		return v, err
	}
	if err := s.commit(fmt.Sprintf("edited %s host", v.Name), "hosts.yml"); err != nil {
		return v, err
	}
	return v, nil
}

func (s *Store) DeleteServer(ctx context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.readHosts()
	if err != nil {
		return err
	}
	idx := -1
	var name string
	for i, h := range f.Items {
		if h.ID == id {
			idx = i
			name = h.Name
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	f.Items = append(f.Items[:idx], f.Items[idx+1:]...)
	if err := s.writeHosts(f); err != nil {
		return err
	}
	return s.commit(fmt.Sprintf("removed %s host", name), "hosts.yml")
}

func (s *Store) ListRecipes(ctx context.Context) ([]Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.readRecipesIndex()
	if err != nil {
		return nil, err
	}
	out := make([]Recipe, 0, len(idx.Items))
	for _, m := range idx.Items {
		content, err := os.ReadFile(s.recipePath(m.Name))
		if err != nil {
			return nil, err
		}
		out = append(out, Recipe{ID: m.ID, Name: m.Name, Content: string(content), CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Store) GetRecipe(ctx context.Context, id int64) (Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getRecipeLocked(id)
}

func (s *Store) getRecipeLocked(id int64) (Recipe, error) {
	idx, err := s.readRecipesIndex()
	if err != nil {
		return Recipe{}, err
	}
	for _, m := range idx.Items {
		if m.ID != id {
			continue
		}
		content, err := os.ReadFile(s.recipePath(m.Name))
		if err != nil {
			return Recipe{}, err
		}
		return Recipe{ID: m.ID, Name: m.Name, Content: string(content), CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt}, nil
	}
	return Recipe{}, ErrNotFound
}

func (s *Store) CreateRecipe(ctx context.Context, v Recipe) (Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := cleanRecipe(v)
	if err != nil {
		return v, err
	}
	idx, err := s.readRecipesIndex()
	if err != nil {
		return v, err
	}
	for _, m := range idx.Items {
		if strings.EqualFold(m.Name, v.Name) {
			return v, errors.New("UNIQUE constraint failed: name already exists")
		}
	}
	now := time.Now().UTC()
	v.ID = idx.NextID
	idx.NextID++
	v.CreatedAt = now
	v.UpdatedAt = now
	if err := os.WriteFile(s.recipePath(v.Name), []byte(v.Content), 0o644); err != nil {
		return v, err
	}
	idx.Items = append(idx.Items, recipeMeta{ID: v.ID, Name: v.Name, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt})
	if err := s.writeRecipesIndex(idx); err != nil {
		return v, err
	}
	if err := s.commit(fmt.Sprintf("added %s.ts recipe", v.Name), "recipes.yml", filepath.Join("recipes", v.Name+".ts")); err != nil {
		return v, err
	}
	return v, nil
}

func (s *Store) UpdateRecipe(ctx context.Context, id int64, v Recipe) (Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := cleanRecipe(v)
	if err != nil {
		return v, err
	}
	idx, err := s.readRecipesIndex()
	if err != nil {
		return v, err
	}
	pos := -1
	var prev recipeMeta
	for i, m := range idx.Items {
		if m.ID == id {
			pos = i
			prev = m
		} else if strings.EqualFold(m.Name, v.Name) {
			return v, errors.New("UNIQUE constraint failed: name already exists")
		}
	}
	if pos < 0 {
		return v, ErrNotFound
	}
	oldPath := s.recipePath(prev.Name)
	newPath := s.recipePath(v.Name)
	if prev.Name != v.Name {
		if err := os.Rename(oldPath, newPath); err != nil {
			return v, err
		}
	}
	if err := os.WriteFile(newPath, []byte(v.Content), 0o644); err != nil {
		return v, err
	}
	v.ID = id
	v.CreatedAt = prev.CreatedAt
	v.UpdatedAt = time.Now().UTC()
	idx.Items[pos] = recipeMeta{ID: v.ID, Name: v.Name, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	if err := s.writeRecipesIndex(idx); err != nil {
		return v, err
	}
	paths := []string{"recipes.yml", filepath.Join("recipes", v.Name+".ts")}
	if prev.Name != v.Name {
		// Stage deletion of old path if rename left git tracking the old name.
		_ = s.git("rm", "--cached", "--ignore-unmatch", filepath.Join("recipes", prev.Name+".ts"))
		paths = append(paths, filepath.Join("recipes", prev.Name+".ts"))
	}
	if err := s.commit(fmt.Sprintf("edited %s.ts recipe", v.Name), paths...); err != nil {
		return v, err
	}
	return v, nil
}

func (s *Store) DeleteRecipe(ctx context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.readRecipesIndex()
	if err != nil {
		return err
	}
	pos := -1
	var name string
	for i, m := range idx.Items {
		if m.ID == id {
			pos = i
			name = m.Name
			break
		}
	}
	if pos < 0 {
		return ErrNotFound
	}
	_ = os.Remove(s.recipePath(name))
	idx.Items = append(idx.Items[:pos], idx.Items[pos+1:]...)
	if err := s.writeRecipesIndex(idx); err != nil {
		return err
	}
	_ = s.git("rm", "--cached", "--ignore-unmatch", filepath.Join("recipes", name+".ts"))
	return s.commit(fmt.Sprintf("removed %s.ts recipe", name), "recipes.yml", filepath.Join("recipes", name+".ts"))
}

func (s *Store) runPath(id int64) string {
	return filepath.Join(s.logsDir(), fmt.Sprintf("%d.json", id))
}

func (s *Store) nextRunIDLocked() (int64, error) {
	entries, err := os.ReadDir(s.logsDir())
	if err != nil {
		return 0, err
	}
	var max int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".json"), 10, 64)
		if err != nil {
			continue
		}
		if n > max {
			max = n
		}
	}
	return max + 1, nil
}

func (s *Store) writeRunLocked(v Run) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.runPath(v.ID), append(b, '\n'), 0o644)
}

func (s *Store) CreateRun(ctx context.Context, recipeID int64, serverID *int64) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.getRecipeLocked(recipeID); err != nil {
		return Run{}, err
	}
	if serverID != nil {
		if _, err := s.getServerLocked(*serverID); err != nil {
			return Run{}, err
		}
	}
	id, err := s.nextRunIDLocked()
	if err != nil {
		return Run{}, err
	}
	v := Run{
		ID:        id,
		RecipeID:  recipeID,
		ServerID:  serverID,
		Status:    "running",
		StartedAt: time.Now().UTC(),
		Output:    "",
	}
	if err := s.writeRunLocked(v); err != nil {
		return Run{}, err
	}
	return v, nil
}

func (s *Store) FinishRun(ctx context.Context, id int64, status string, exit int, output string) error {
	if status != "succeeded" && status != "failed" {
		return fmt.Errorf("invalid run status %q", status)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.getRunLocked(id)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	v.Status = status
	v.FinishedAt = &now
	v.ExitCode = &exit
	v.Output = output
	return s.writeRunLocked(v)
}

func (s *Store) GetRun(ctx context.Context, id int64) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getRunLocked(id)
}

func (s *Store) getRunLocked(id int64) (Run, error) {
	b, err := os.ReadFile(s.runPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return Run{}, ErrNotFound
		}
		return Run{}, err
	}
	var v Run
	if err := json.Unmarshal(b, &v); err != nil {
		return Run{}, err
	}
	return v, nil
}

func (s *Store) ListRuns(ctx context.Context, recipeID int64) ([]Run, error) {
	all, err := s.ListRecentRuns(ctx, 500)
	if err != nil {
		return nil, err
	}
	out := make([]Run, 0)
	for _, r := range all {
		if r.RecipeID == recipeID {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *Store) ListRecentRuns(ctx context.Context, limit int) ([]Run, error) {
	if limit < 1 || limit > 500 {
		limit = 50
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.logsDir())
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".json"), 10, 64)
		if err != nil {
			continue
		}
		ids = append(ids, n)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	if len(ids) > limit {
		ids = ids[:limit]
	}
	out := make([]Run, 0, len(ids))
	for _, id := range ids {
		v, err := s.getRunLocked(id)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}
