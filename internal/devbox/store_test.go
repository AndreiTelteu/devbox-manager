// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

package devbox

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, e := Open(context.Background(), t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestServerAndRecipeCRUD(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	server, e := s.CreateServer(ctx, Server{Name: "web-1", Host: "192.0.2.10", Port: 22, Username: "admin"})
	if e != nil {
		t.Fatal(e)
	}
	server.Host = "web.internal"
	if _, e = s.UpdateServer(ctx, server.ID, server); e != nil {
		t.Fatal(e)
	}
	recipe, e := s.CreateRecipe(ctx, Recipe{Name: "hello", Content: "import { $ } from \"bun\"\nawait $`echo hello`\n"})
	if e != nil {
		t.Fatal(e)
	}
	recipe.Content = "import { $ } from \"bun\"\nawait $`echo updated`\n"
	if _, e = s.UpdateRecipe(ctx, recipe.Name, recipe); e != nil {
		t.Fatal(e)
	}
	runs, e := s.ListRuns(ctx, recipe.Name)
	if e != nil || len(runs) != 0 {
		t.Fatalf("runs=%v err=%v", runs, e)
	}
	if e = s.DeleteRecipe(ctx, recipe.Name); e != nil {
		t.Fatal(e)
	}
	if e = s.DeleteServer(ctx, server.ID); e != nil {
		t.Fatal(e)
	}
}

func TestRunnerPersistsFailedExecution(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	recipe, e := s.CreateRecipe(ctx, Recipe{Name: "run", Content: "console.log('test')\n"})
	if e != nil {
		t.Fatal(e)
	}
	run, e := (Runner{Store: s, NixShellExecutable: "/definitely/not-a-command"}).Run(ctx, recipe.Name, nil, 0)
	if e != nil {
		t.Fatal(e)
	}
	if run.Status != "failed" || run.ExitCode == nil {
		t.Fatalf("unexpected run: %+v", run)
	}
	if !strings.Contains(run.Output, "/definitely/not-a-command") {
		t.Fatalf("missing startup error in output: %q", run.Output)
	}
	stored, e := s.GetRun(ctx, run.ID)
	if e != nil || stored.FinishedAt == nil {
		t.Fatalf("stored=%+v err=%v", stored, e)
	}
}

func TestRunnerBuildsRemoteSSHCommand(t *testing.T) {
	s := newTestStore(t)
	server := Server{Host: "mini3", Port: 2222, Username: "andrei", Secrets: map[string]string{"DEPLOY_TOKEN": "top secret"}}
	id := int64(1)
	cmd, e := (Runner{Store: s, SSHExecutable: "ssh-test"}).command(context.Background(), &id, server, "import { $ } from \"bun\"\nawait $`echo hi`\n", 60)
	if e != nil {
		t.Fatal(e)
	}
	if cmd.Path != "ssh-test" {
		t.Fatalf("ssh executable=%q", cmd.Path)
	}
	joined := strings.Join(cmd.Args, " ")
	for _, want := range []string{"-p 2222", "env DBM_REMOTE_COMMAND=", `bash -c 'exec bash <(printf %s "$DBM_REMOTE_COMMAND" | base64 -d)'`} {
		if !strings.Contains(joined, want) {
			t.Fatalf("command %q does not contain %q", joined, want)
		}
	}
	encoded := strings.TrimPrefix(strings.Fields(cmd.Args[len(cmd.Args)-1])[1], "DBM_REMOTE_COMMAND=")
	launcher, e := base64.StdEncoding.DecodeString(encoded)
	if e != nil {
		t.Fatalf("decode launcher: %v", e)
	}
	for _, want := range []string{"mktemp /tmp/devbox-manager.XXXXXX.ts", "log=${recipe%.ts}.log", "lock=/tmp/devbox-manager-bun.lock", "flock -n 9", "another bun run is active", `nix-shell -p bun --run "timeout 60 bun \"$recipe\""`, "devbox-manager: bun pid: $pid", "tail -n +1 -f --pid=\"$pid\" \"$log\" &", "wait \"$tailpid\" || true", "wait \"$pid\""} {
		if !strings.Contains(string(launcher), want) {
			t.Fatalf("launcher %q does not contain %q", launcher, want)
		}
	}
	if strings.Contains(joined, "mgmt") {
		t.Fatalf("remote command unexpectedly mentions mgmt: %q", joined)
	}
	body, e := io.ReadAll(cmd.Stdin)
	if e != nil {
		t.Fatal(e)
	}
	// The store ships without helpers, so the injected body must be exactly
	// the server secrets prologue plus the recipe itself.
	if _, err := os.Stat(filepath.Join(s.Root, "recipes", "_helpers")); !os.IsNotExist(err) {
		t.Fatalf("helpers dir unexpectedly present: %v", err)
	}
	for _, want := range []string{"import { $ } from \"bun\"", "await $`echo hi`"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("injected recipe does not contain %q", want)
		}
	}
	if !strings.Contains(string(body), `Object.assign(process.env, {"DEPLOY_TOKEN":"top secret"})`) {
		t.Fatalf("server secret was not injected into recipe: %q", body)
	}
	if strings.Contains(joined, "top secret") {
		t.Fatalf("remote command exposes secret: %q", joined)
	}
}

func TestLocalServerRunsNativeBunWithSecrets(t *testing.T) {
	s := newTestStore(t)
	local, err := s.ListServers(context.Background())
	if err != nil || len(local) == 0 || local[0].Name != localServerName {
		t.Fatalf("local server=%+v err=%v", local, err)
	}
	server := local[0]
	server.Secrets = map[string]string{"LOCAL_TOKEN": "secret"}
	cmd, err := (Runner{Store: s, BunExecutable: "bun-test"}).command(context.Background(), &server.ID, server, "console.log(process.env.LOCAL_TOKEN)\n", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(cmd.Dir)
	if cmd.Path != "bun-test" {
		t.Fatalf("bun executable=%q", cmd.Path)
	}
	body, err := os.ReadFile(cmd.Args[1])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `Object.assign(process.env, {"LOCAL_TOKEN":"secret"})`) {
		t.Fatalf("local recipe did not receive secrets: %q", body)
	}
}

func TestLocalServerValidation(t *testing.T) {
	clean, err := cleanServer(Server{Name: "LOCAL", Host: "should-not-be-used", Port: 22, Username: "ignored"})
	if err != nil {
		t.Fatal(err)
	}
	if clean.Name != localServerName || clean.Host != "" || clean.Port != 0 || clean.Username != "" {
		t.Fatalf("clean local server=%+v", clean)
	}
}

func TestServerSecretsPersistAndValidate(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	server, err := s.CreateServer(ctx, Server{Name: "secrets", Host: "192.0.2.11", Port: 22, Username: "ops", Secrets: map[string]string{"API_TOKEN": "abc"}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetServer(ctx, server.ID)
	if err != nil || got.Secrets["API_TOKEN"] != "abc" {
		t.Fatalf("server=%+v err=%v", got, err)
	}
	if _, err := s.CreateServer(ctx, Server{Name: "invalid", Host: "192.0.2.12", Port: 22, Username: "ops", Secrets: map[string]string{"BAD-KEY": "abc"}}); err == nil {
		t.Fatal("invalid secret key was accepted")
	}
}

func TestAPIServerAndRecipe(t *testing.T) {
	s := newTestStore(t)
	api := API{Store: s, Runner: Runner{Store: s, NixShellExecutable: "/not-found"}}
	body := `{"name":"api-web","host":"198.51.100.1","port":22,"username":"ops"}`
	req := httptest.NewRequest(http.MethodPost, "/api/servers", strings.NewReader(body))
	rec := httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create server status=%d body=%s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/servers", nil)
	rec = httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "api-web") {
		t.Fatalf("list servers status=%d body=%s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/recipe-folders", strings.NewReader(`{"path":"api/empty"}`))
	rec = httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create folder status=%d body=%s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/recipe-folders", nil)
	rec = httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "api/empty") {
		t.Fatalf("list folders status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGitCommitOnMutations(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	server, err := s.CreateServer(ctx, Server{Name: "mini", Host: "10.0.0.1", Port: 22, Username: "u"})
	if err != nil {
		t.Fatal(err)
	}
	recipe, err := s.CreateRecipe(ctx, Recipe{Name: "demo", Content: "console.log('x')\n"})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.CreateRun(ctx, recipe.Name, &server.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.FinishRun(ctx, run.ID, "succeeded", 0, "ok\n"); err != nil {
		t.Fatal(err)
	}
	log := gitLog(t, s.Root)
	for _, want := range []string{"added mini host", "added demo.ts recipe"} {
		if !strings.Contains(log, want) {
			t.Fatalf("git log missing %q:\n%s", want, log)
		}
	}
	// log payloads must never be tracked; logs/.gitignore itself is fine
	tracked := gitLSFiles(t, s.Root)
	for _, line := range strings.Split(tracked, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "logs/.gitignore" {
			continue
		}
		if strings.HasPrefix(line, "logs/") {
			t.Fatalf("log payload should not be tracked: %q\n%s", line, tracked)
		}
	}
	if !fileExists(filepath.Join(s.Root, "logs", "1.json")) {
		t.Fatal("run log file missing on disk")
	}
	if _, err := s.UpdateRecipe(ctx, recipe.Name, Recipe{Name: "demo", Content: "console.log('y')\n"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRecipe(ctx, recipe.Name); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteServer(ctx, server.ID); err != nil {
		t.Fatal(err)
	}
	log = gitLog(t, s.Root)
	for _, want := range []string{"edited demo.ts recipe", "removed demo.ts recipe", "removed mini host"} {
		if !strings.Contains(log, want) {
			t.Fatalf("git log missing %q:\n%s", want, log)
		}
	}
}

func TestRecipeFoldersAndNestedRecipes(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	if _, err := s.CreateRecipeFolder(ctx, "web/tools"); err != nil {
		t.Fatal(err)
	}
	// idempotent
	if _, err := s.CreateRecipeFolder(ctx, "web/tools"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateRecipe(ctx, Recipe{Name: "web/tools/deploy", Content: "console.log('deploy')\n"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListRecipes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "web/tools/deploy" {
		t.Fatalf("recipes=%+v", got)
	}
	folders, err := s.ListRecipeFolders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(folders, ",") != "web,web/tools" {
		t.Fatalf("folders=%v", folders)
	}
	// underscore dirs are skipped by the scan
	if err := os.MkdirAll(filepath.Join(s.recipesDir(), "_helpers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.recipesDir(), "_helpers", "x.ts"), []byte("// helper"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err = s.ListRecipes(ctx)
	if err != nil || len(got) != 1 {
		t.Fatalf("recipes=%+v err=%v", got, err)
	}
	// moving a recipe to another folder via update
	if _, err := s.UpdateRecipe(ctx, "web/tools/deploy", Recipe{Name: "web/deploy", Content: "console.log('moved')\n"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetRecipe(ctx, "web/deploy"); err != nil {
		t.Fatalf("moved recipe missing: %v", err)
	}
	if fileExists(filepath.Join(s.recipesDir(), "web", "tools", "deploy.ts")) {
		t.Fatal("old recipe path still exists after move")
	}
	// deleting leaves no empty nested dirs
	if err := s.DeleteRecipe(ctx, "web/deploy"); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(s.recipesDir(), "web", "deploy.ts")) {
		t.Fatal("deleted recipe still on disk")
	}
	// underscore segments are rejected
	if _, err := s.CreateRecipe(ctx, Recipe{Name: "_bad", Content: "x"}); err == nil {
		t.Fatal("expected error for underscore-prefixed name")
	}
	if _, err := s.CreateRecipe(ctx, Recipe{Name: "../escape", Content: "x"}); err == nil {
		t.Fatal("expected error for traversal name")
	}
}

func TestRecipeHelpersConcatenation(t *testing.T) {
	s := newTestStore(t)
	dir := s.helpersDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b-nix.ts"), []byte("import { $ } from \"bun\"\nexport async function ensure() { await $`nix-env --version` }"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a-node.ts"), []byte("import { $ } from \"bun\"\nexport async function node() { await $`node -v` }"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := s.RecipeHelpers()
	if err != nil {
		t.Fatal(err)
	}
	// exactly one hoisted bun import, bodies sorted by file name
	if strings.Count(out, "from \"bun\"") != 1 {
		t.Fatalf("helpers should hoist a single bun import: %q", out)
	}
	aIdx := strings.Index(out, "node()")
	bIdx := strings.Index(out, "ensure()")
	if aIdx < 0 || bIdx < 0 || aIdx > bIdx {
		t.Fatalf("helpers not ordered by file name: %q", out)
	}
	if !strings.HasPrefix(out, "import { $ } from \"bun\"\n") {
		t.Fatalf("import should be hoisted to the top: %q", out)
	}
}

func gitLog(t *testing.T, root string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", root, "log", "--oneline").CombinedOutput()
	if err != nil {
		t.Fatalf("git log: %v %s", err, out)
	}
	return string(out)
}

func gitLSFiles(t *testing.T, root string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", root, "ls-files").CombinedOutput()
	if err != nil {
		t.Fatalf("git ls-files: %v %s", err, out)
	}
	return string(out)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
