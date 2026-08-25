// devbox-manager: mgmt · MCL recipe manager
// Copyright (C) 2026  Andrei
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package devbox

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, e := Open(context.Background(), "file:"+t.TempDir()+"/test.db")
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
	recipe, e := s.CreateRecipe(ctx, Recipe{Name: "hello", Content: "# MCL"})
	if e != nil {
		t.Fatal(e)
	}
	recipe.Content = "resource noop() {}"
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
	recipe, e := s.CreateRecipe(ctx, Recipe{Name: "run", Content: "# test"})
	if e != nil {
		t.Fatal(e)
	}
	run, e := (Runner{Store: s, Executable: "/definitely/not/a-command"}).Run(ctx, recipe.ID, nil, 0)
	if e != nil {
		t.Fatal(e)
	}
	if run.Status != "failed" || run.ExitCode == nil {
		t.Fatalf("unexpected run: %+v", run)
	}
	if !strings.Contains(run.Output, "/definitely/not/a-command") {
		t.Fatalf("missing startup error in output: %q", run.Output)
	}
	stored, e := s.GetRun(ctx, run.ID)
	if e != nil || stored.FinishedAt == nil {
		t.Fatalf("stored=%+v err=%v", stored, e)
	}
}
func TestAPIServerAndRecipe(t *testing.T) {
	s := newTestStore(t)
	api := API{Store: s, Runner: Runner{Store: s, Executable: "/not-found"}}
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
