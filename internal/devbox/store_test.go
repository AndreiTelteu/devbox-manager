// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

package devbox

import (
	"context"
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
	if _, e = s.UpdateRecipe(ctx, recipe.ID, recipe); e != nil {
		t.Fatal(e)
	}
	runs, e := s.ListRuns(ctx, recipe.ID)
	if e != nil || len(runs) != 0 {
		t.Fatalf("runs=%v err=%v", runs, e)
	}
	if e = s.DeleteRecipe(ctx, recipe.ID); e != nil {
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
	run, e := (Runner{Store: s, NixShellExecutable: "/definitely/not-a-command"}).Run(ctx, recipe.ID, nil, 0)
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
	server := Server{Host: "mini3", Port: 2222, Username: "andrei"}
	id := int64(1)
	cmd, e := (Runner{Store: s, SSHExecutable: "ssh-test"}).command(context.Background(), &id, server, "import { $ } from \"bun\"\nawait $`echo hi`\n", 60)
	if e != nil {
		t.Fatal(e)
	}
	if cmd.Path != "ssh-test" {
		t.Fatalf("ssh executable=%q", cmd.Path)
	}
	joined := strings.Join(cmd.Args, " ")
	for _, want := range []string{"-p 2222", "mktemp /tmp/devbox-manager.XXXXXX.ts", "log=${recipe%.ts}.log", "lock=/tmp/devbox-manager-bun.lock", "flock -n 9", "another bun run is active", `nix-shell -p bun --run "timeout 60 bun \"$recipe\""`, "devbox-manager: bun pid: $pid", "tail -n +1 -f --pid=\"$pid\" \"$log\" &", "wait \"$tailpid\" || true", "wait \"$pid\""} {
		if !strings.Contains(joined, want) {
			t.Fatalf("command %q does not contain %q", joined, want)
		}
	}
	if strings.Contains(joined, "mgmt") {
		t.Fatalf("remote command unexpectedly mentions mgmt: %q", joined)
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
	run, err := s.CreateRun(ctx, recipe.ID, &server.ID)
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
	if _, err := s.UpdateRecipe(ctx, recipe.ID, Recipe{Name: "demo", Content: "console.log('y')\n"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRecipe(ctx, recipe.ID); err != nil {
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
