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
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
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
	ID        int64             `json:"id" yaml:"id"`
	Name      string            `json:"name" yaml:"name"`
	Host      string            `json:"host" yaml:"host"`
	Port      int               `json:"port" yaml:"port"`
	Username  string            `json:"username" yaml:"username"`
	Secrets   map[string]string `json:"secrets" yaml:"secrets,omitempty"`
	CreatedAt time.Time         `json:"created_at" yaml:"created_at"`
	UpdatedAt time.Time         `json:"updated_at" yaml:"updated_at"`
}

// Recipe is identified by its slash path relative to data/recipes without
// the .ts extension (for example "web/tools/deploy"). Timestamps come from
// the file mtime — the store keeps no separate index.
type Recipe struct {
	Name      string    `json:"name"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Run struct {
	ID         int64      `json:"id"`
	Recipe     string     `json:"recipe"`
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

var safeSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
var safeEnvKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const localServerName = "local"

func isLocalServer(v Server) bool {
	return strings.EqualFold(strings.TrimSpace(v.Name), localServerName)
}

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
	if err := s.ensureLocalServer(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return nil }

func (s *Store) hostsPath() string  { return filepath.Join(s.Root, "hosts.yml") }
func (s *Store) recipesDir() string { return filepath.Join(s.Root, "recipes") }

// helpersDir holds shared helper scripts prepended to every run. The leading
// underscore keeps it out of the recipe scan.
func (s *Store) helpersDir() string { return filepath.Join(s.recipesDir(), "_helpers") }

// recipesIndexPath is the retired recipes.yml index, kept only so Open can
// migrate legacy data dirs away from it.
func (s *Store) recipesIndexPath() string {
	return filepath.Join(s.Root, "recipes.yml")
}
func (s *Store) logsDir() string { return filepath.Join(s.Root, "logs") }
func (s *Store) recipePath(name string) string {
	return filepath.Join(s.recipesDir(), filepath.FromSlash(name)+".ts")
}

// recipeGitPath is the recipe location relative to the data git root.
func (s *Store) recipeGitPath(name string) string { return "recipes/" + name + ".ts" }

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
	if err := s.dropLegacyIndex(); err != nil {
		return err
	}
	return s.ensureGit()
}

// dropLegacyIndex removes the retired recipes.yml id index (recipes are now
// identified by their path). Legacy run logs reference numeric recipe ids
// that no longer resolve, so they are cleared as well. Idempotent: fresh and
// already-migrated stores hit the os.Stat miss and return immediately.
func (s *Store) dropLegacyIndex() error {
	if _, err := os.Stat(s.recipesIndexPath()); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	entries, err := os.ReadDir(s.logsDir())
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
				_ = os.Remove(filepath.Join(s.logsDir(), e.Name()))
			}
		}
	}
	if err := os.Remove(s.recipesIndexPath()); err != nil {
		return err
	}
	return s.commit("dropped recipes.yml index and legacy run logs", "recipes.yml")
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
	if err := s.git("add", "--", "hosts.yml", "recipes", ".gitignore", "logs/.gitignore"); err != nil {
		return err
	}
	// Initial commit may be empty-ish on first boot after files exist.
	_ = s.git("commit", "-m", "initial data layout")
	return nil
}

// ensureLocalServer reserves the first inventory entry for the host running
// devbox-manager. It has no SSH address because recipes run locally with Bun.
func (s *Store) ensureLocalServer() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.readHosts()
	if err != nil {
		return err
	}
	for i := range f.Items {
		if !isLocalServer(f.Items[i]) {
			continue
		}
		local := &f.Items[i]
		if local.Name == localServerName && local.Host == "" && local.Port == 0 && local.Username == "" {
			return nil
		}
		local.Name, local.Host, local.Port, local.Username = localServerName, "", 0, ""
		local.UpdatedAt = time.Now().UTC()
		if err := s.writeHosts(f); err != nil {
			return err
		}
		return s.commit("normalized local host", "hosts.yml")
	}
	now := time.Now().UTC()
	f.Items = append(f.Items, Server{ID: f.NextID, Name: localServerName, CreatedAt: now, UpdatedAt: now})
	f.NextID++
	if err := s.writeHosts(f); err != nil {
		return err
	}
	return s.commit("added local host", "hosts.yml")
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

func cleanServer(v Server) (Server, error) {
	v.Name = strings.TrimSpace(v.Name)
	v.Host = strings.TrimSpace(v.Host)
	v.Username = strings.TrimSpace(v.Username)
	if v.Name == "" {
		return v, errors.New("name is required")
	}
	if isLocalServer(v) {
		v.Name, v.Host, v.Port, v.Username = localServerName, "", 0, ""
	} else if v.Host == "" || v.Username == "" {
		return v, errors.New("name, host, and username are required")
	}
	if !isLocalServer(v) && v.Port == 0 {
		v.Port = 22
	}
	if !isLocalServer(v) && (v.Port < 1 || v.Port > 65535) {
		return v, errors.New("port must be between 1 and 65535")
	}
	if len(v.Secrets) == 0 {
		v.Secrets = nil
		return v, nil
	}
	secrets := make(map[string]string, len(v.Secrets))
	for key, value := range v.Secrets {
		key = strings.TrimSpace(key)
		if !safeEnvKey.MatchString(key) {
			return v, fmt.Errorf("secret key %q must match [A-Za-z_][A-Za-z0-9_]*", key)
		}
		secrets[key] = value
	}
	v.Secrets = secrets
	return v, nil
}

func cleanRecipe(v Recipe) (Recipe, error) {
	name, err := validateRecipeName(v.Name)
	if err != nil {
		return v, err
	}
	v.Name = name
	if v.Content == "" {
		return v, errors.New("content is required")
	}
	return v, nil
}

// validateRecipeName normalizes and validates a recipe or folder path: each
// slash-separated segment must match [A-Za-z0-9][A-Za-z0-9._-]* and may not
// start with an underscore (that prefix is reserved, e.g. recipes/_helpers).
func validateRecipeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	name = strings.Trim(name, "/")
	if name == "" {
		return "", errors.New("name is required")
	}
	if len(name) > 256 {
		return "", errors.New("name is too long")
	}
	for _, seg := range strings.Split(name, "/") {
		if !safeSegment.MatchString(seg) {
			return "", fmt.Errorf("path segment %q must match [A-Za-z0-9][A-Za-z0-9._-]*", seg)
		}
		if strings.HasPrefix(seg, "_") {
			return "", fmt.Errorf("path segment %q may not start with an underscore", seg)
		}
	}
	return name, nil
}

func (s *Store) ListServers(ctx context.Context) ([]Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.readHosts()
	if err != nil {
		return nil, err
	}
	out := append([]Server(nil), f.Items...)
	sort.Slice(out, func(i, j int) bool {
		if isLocalServer(out[i]) != isLocalServer(out[j]) {
			return isLocalServer(out[i])
		}
		return out[i].Name < out[j].Name
	})
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
	if isLocalServer(prev) && !isLocalServer(v) {
		return v, errors.New("the local host name is reserved")
	}
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
	if isLocalServer(f.Items[idx]) {
		return errors.New("the local host cannot be deleted")
	}
	f.Items = append(f.Items[:idx], f.Items[idx+1:]...)
	if err := s.writeHosts(f); err != nil {
		return err
	}
	return s.commit(fmt.Sprintf("removed %s host", name), "hosts.yml")
}

// scanRecipesLocked walks data/recipes collecting *.ts files as recipes.
// Directories starting with "_" (helpers) and non-.ts files (e.g. .gitkeep)
// are skipped; names are slash paths relative to recipesDir without the
// extension. Timestamps come from the file mtime.
func (s *Store) scanRecipesLocked() ([]Recipe, error) {
	var out []Recipe
	err := filepath.WalkDir(s.recipesDir(), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != s.recipesDir() && strings.HasPrefix(d.Name(), "_") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".ts") {
			return nil
		}
		rel, err := filepath.Rel(s.recipesDir(), path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(filepath.ToSlash(rel), ".ts")
		out = append(out, Recipe{Name: name, Content: string(content), CreatedAt: info.ModTime(), UpdatedAt: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Store) ListRecipes(ctx context.Context) ([]Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.scanRecipesLocked()
}

// ListRecipeFolders returns slash-separated recipe directory paths. Helper
// directories are implementation details and are never exposed to the UI.
func (s *Store) ListRecipeFolders(ctx context.Context) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	folders := make([]string, 0)
	err := filepath.WalkDir(s.recipesDir(), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() || path == s.recipesDir() {
			return nil
		}
		if strings.HasPrefix(d.Name(), "_") {
			return fs.SkipDir
		}
		rel, err := filepath.Rel(s.recipesDir(), path)
		if err != nil {
			return err
		}
		folders = append(folders, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(folders)
	return folders, nil
}

func (s *Store) GetRecipe(ctx context.Context, name string) (Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getRecipeLocked(name)
}

func (s *Store) getRecipeLocked(name string) (Recipe, error) {
	name, err := validateRecipeName(name)
	if err != nil {
		return Recipe{}, err
	}
	path := s.recipePath(name)
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Recipe{}, ErrNotFound
		}
		return Recipe{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Recipe{}, err
	}
	return Recipe{Name: name, Content: string(content), CreatedAt: info.ModTime(), UpdatedAt: info.ModTime()}, nil
}

func (s *Store) CreateRecipe(ctx context.Context, v Recipe) (Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := cleanRecipe(v)
	if err != nil {
		return v, err
	}
	if _, err := os.Stat(s.recipePath(v.Name)); err == nil {
		return v, errors.New("UNIQUE constraint failed: name already exists")
	} else if !os.IsNotExist(err) {
		return v, err
	}
	if err := os.MkdirAll(filepath.Dir(s.recipePath(v.Name)), 0o755); err != nil {
		return v, err
	}
	if err := os.WriteFile(s.recipePath(v.Name), []byte(v.Content), 0o644); err != nil {
		return v, err
	}
	if err := s.commit(fmt.Sprintf("added %s.ts recipe", v.Name), s.recipeGitPath(v.Name)); err != nil {
		return v, err
	}
	return s.getRecipeLocked(v.Name)
}

// UpdateRecipe rewrites the recipe at name; a changed v.Name moves the file
// (rename or drag-and-drop between folders).
func (s *Store) UpdateRecipe(ctx context.Context, name string, v Recipe) (Recipe, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	oldName, err := validateRecipeName(name)
	if err != nil {
		return v, err
	}
	if _, err := s.getRecipeLocked(oldName); err != nil {
		return v, err
	}
	if strings.TrimSpace(v.Name) == "" {
		v.Name = oldName
	}
	v, err = cleanRecipe(v)
	if err != nil {
		return v, err
	}
	if v.Name != oldName {
		if _, err := os.Stat(s.recipePath(v.Name)); err == nil {
			return v, errors.New("UNIQUE constraint failed: name already exists")
		} else if !os.IsNotExist(err) {
			return v, err
		}
		if err := os.MkdirAll(filepath.Dir(s.recipePath(v.Name)), 0o755); err != nil {
			return v, err
		}
		if err := os.Rename(s.recipePath(oldName), s.recipePath(v.Name)); err != nil {
			return v, err
		}
	}
	if err := os.WriteFile(s.recipePath(v.Name), []byte(v.Content), 0o644); err != nil {
		return v, err
	}
	paths := []string{s.recipeGitPath(v.Name)}
	if v.Name != oldName {
		paths = append(paths, s.recipeGitPath(oldName))
		s.pruneEmptyDirs(filepath.Dir(s.recipePath(oldName)))
	}
	if err := s.commit(fmt.Sprintf("edited %s.ts recipe", v.Name), paths...); err != nil {
		return v, err
	}
	return s.getRecipeLocked(v.Name)
}

func (s *Store) DeleteRecipe(ctx context.Context, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := validateRecipeName(name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(s.recipePath(name)); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	if err := os.Remove(s.recipePath(name)); err != nil {
		return err
	}
	s.pruneEmptyDirs(filepath.Dir(s.recipePath(name)))
	return s.commit(fmt.Sprintf("removed %s.ts recipe", name), s.recipeGitPath(name))
}

// CreateRecipeFolder creates an (empty) recipe folder. Git cannot track
// empty directories, so a .gitkeep marker keeps it in version control.
func (s *Store) CreateRecipeFolder(ctx context.Context, path string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := validateRecipeName(path)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(s.recipesDir(), filepath.FromSlash(name))
	if info, err := os.Stat(dir); err == nil {
		if !info.IsDir() {
			return "", errors.New("UNIQUE constraint failed: name already exists")
		}
		return name, nil // idempotent
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, ".gitkeep"), []byte(""), 0o644); err != nil {
		return "", err
	}
	if err := s.commit(fmt.Sprintf("added %s folder", name), "recipes/"+name+"/.gitkeep"); err != nil {
		return "", err
	}
	return name, nil
}

// pruneEmptyDirs removes empty recipe folders upwards from dir (stop at
// recipes root). Folders with a .gitkeep marker are never considered empty.
func (s *Store) pruneEmptyDirs(dir string) {
	for dir != s.recipesDir() && strings.HasPrefix(dir, s.recipesDir()+string(os.PathSeparator)) {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) > 0 {
			return
		}
		if err := os.Remove(dir); err != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

func (s *Store) runPath(id int64) string {
	return filepath.Join(s.logsDir(), fmt.Sprintf("%d.json", id))
}

var bunImportLine = regexp.MustCompile(`^import\s+[^;]*\s+from\s+"bun"$`)

// RecipeHelpers concatenates every data/recipes/_helpers/*.ts file (sorted by
// name) into one prologue for recipe runs. Every helper file imports from
// "bun" with its own local alias; those import lines are hoisted and
// deduplicated so the concatenated script stays valid TypeScript.
func (s *Store) RecipeHelpers() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.helpersDir())
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".ts") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	var imports []string
	var bodies []string
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(s.helpersDir(), name))
		if err != nil {
			return "", err
		}
		var kept []string
		for _, line := range strings.Split(string(b), "\n") {
			trimmed := strings.TrimSpace(line)
			if bunImportLine.MatchString(trimmed) {
				if !slices.Contains(imports, trimmed) {
					imports = append(imports, trimmed)
				}
				continue
			}
			kept = append(kept, line)
		}
		if text := strings.TrimSpace(strings.Join(kept, "\n")); text != "" {
			bodies = append(bodies, text)
		}
	}
	if len(bodies) == 0 {
		return "", nil
	}
	prologue := strings.Join(imports, "\n")
	if prologue != "" {
		prologue += "\n\n"
	}
	return prologue + strings.Join(bodies, "\n\n") + "\n", nil
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

func (s *Store) CreateRun(ctx context.Context, recipe string, serverID *int64) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.getRecipeLocked(recipe); err != nil {
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
		Recipe:    recipe,
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

func (s *Store) ListRuns(ctx context.Context, recipe string) ([]Run, error) {
	all, err := s.ListRecentRuns(ctx, 500)
	if err != nil {
		return nil, err
	}
	out := make([]Run, 0)
	for _, r := range all {
		if r.Recipe == recipe {
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
