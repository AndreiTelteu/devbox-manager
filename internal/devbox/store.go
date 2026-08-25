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
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type Store struct{ db *sql.DB }

type Server struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Recipe struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
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

func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS servers (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22 CHECK(port BETWEEN 1 AND 65535), username TEXT NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipes (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipe_runs (
 id INTEGER PRIMARY KEY, recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), started_at DATETIME NOT NULL, finished_at DATETIME, exit_code INTEGER, output TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_recipe_runs_recipe_id ON recipe_runs(recipe_id);`)
	return err
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
	return v, nil
}
func scanServer(row interface{ Scan(...any) error }) (Server, error) {
	var v Server
	err := row.Scan(&v.ID, &v.Name, &v.Host, &v.Port, &v.Username, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	return v, err
}
func scanRecipe(row interface{ Scan(...any) error }) (Recipe, error) {
	var v Recipe
	err := row.Scan(&v.ID, &v.Name, &v.Content, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	return v, err
}

func (s *Store) ListServers(ctx context.Context) ([]Server, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id,name,host,port,username,created_at,updated_at FROM servers ORDER BY name")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []Server
	for rows.Next() {
		v, e := scanServer(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) GetServer(ctx context.Context, id int64) (Server, error) {
	return scanServer(s.db.QueryRowContext(ctx, "SELECT id,name,host,port,username,created_at,updated_at FROM servers WHERE id=?", id))
}
func (s *Store) CreateServer(ctx context.Context, v Server) (Server, error) {
	v, e := cleanServer(v)
	if e != nil {
		return v, e
	}
	r, e := s.db.ExecContext(ctx, "INSERT INTO servers(name,host,port,username) VALUES(?,?,?,?)", v.Name, v.Host, v.Port, v.Username)
	if e != nil {
		return v, e
	}
	id, _ := r.LastInsertId()
	return s.GetServer(ctx, id)
}
func (s *Store) UpdateServer(ctx context.Context, id int64, v Server) (Server, error) {
	v, e := cleanServer(v)
	if e != nil {
		return v, e
	}
	r, e := s.db.ExecContext(ctx, "UPDATE servers SET name=?,host=?,port=?,username=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", v.Name, v.Host, v.Port, v.Username, id)
	if e != nil {
		return v, e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return v, ErrNotFound
	}
	return s.GetServer(ctx, id)
}
func (s *Store) DeleteServer(ctx context.Context, id int64) error {
	r, e := s.db.ExecContext(ctx, "DELETE FROM servers WHERE id=?", id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) ListRecipes(ctx context.Context) ([]Recipe, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id,name,content,created_at,updated_at FROM recipes ORDER BY name")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []Recipe
	for rows.Next() {
		v, e := scanRecipe(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) GetRecipe(ctx context.Context, id int64) (Recipe, error) {
	return scanRecipe(s.db.QueryRowContext(ctx, "SELECT id,name,content,created_at,updated_at FROM recipes WHERE id=?", id))
}
func (s *Store) CreateRecipe(ctx context.Context, v Recipe) (Recipe, error) {
	v, e := cleanRecipe(v)
	if e != nil {
		return v, e
	}
	r, e := s.db.ExecContext(ctx, "INSERT INTO recipes(name,content) VALUES(?,?)", v.Name, v.Content)
	if e != nil {
		return v, e
	}
	id, _ := r.LastInsertId()
	return s.GetRecipe(ctx, id)
}
func (s *Store) UpdateRecipe(ctx context.Context, id int64, v Recipe) (Recipe, error) {
	v, e := cleanRecipe(v)
	if e != nil {
		return v, e
	}
	r, e := s.db.ExecContext(ctx, "UPDATE recipes SET name=?,content=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", v.Name, v.Content, id)
	if e != nil {
		return v, e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return v, ErrNotFound
	}
	return s.GetRecipe(ctx, id)
}
func (s *Store) DeleteRecipe(ctx context.Context, id int64) error {
	r, e := s.db.ExecContext(ctx, "DELETE FROM recipes WHERE id=?", id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) CreateRun(ctx context.Context, recipeID int64, serverID *int64) (Run, error) {
	r, e := s.db.ExecContext(ctx, "INSERT INTO recipe_runs(recipe_id,server_id,status,started_at) VALUES(?,?,?,?)", recipeID, serverID, "running", time.Now().UTC())
	if e != nil {
		return Run{}, e
	}
	id, _ := r.LastInsertId()
	return s.GetRun(ctx, id)
}
func (s *Store) FinishRun(ctx context.Context, id int64, status string, exit int, output string) error {
	if status != "succeeded" && status != "failed" {
		return fmt.Errorf("invalid run status %q", status)
	}
	_, e := s.db.ExecContext(ctx, "UPDATE recipe_runs SET status=?,finished_at=?,exit_code=?,output=? WHERE id=?", status, time.Now().UTC(), exit, output, id)
	return e
}
func (s *Store) GetRun(ctx context.Context, id int64) (Run, error) {
	var v Run
	var finished sql.NullTime
	var code sql.NullInt64
	err := s.db.QueryRowContext(ctx, "SELECT id,recipe_id,server_id,status,started_at,finished_at,exit_code,output FROM recipe_runs WHERE id=?", id).Scan(&v.ID, &v.RecipeID, &v.ServerID, &v.Status, &v.StartedAt, &finished, &code, &v.Output)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	if finished.Valid {
		v.FinishedAt = &finished.Time
	}
	if code.Valid {
		x := int(code.Int64)
		v.ExitCode = &x
	}
	return v, nil
}
func (s *Store) ListRuns(ctx context.Context, recipeID int64) ([]Run, error) {
	return s.listRuns(ctx, "SELECT id FROM recipe_runs WHERE recipe_id=? ORDER BY id DESC", recipeID)
}

func (s *Store) ListRecentRuns(ctx context.Context, limit int) ([]Run, error) {
	if limit < 1 || limit > 500 {
		limit = 50
	}
	return s.listRuns(ctx, "SELECT id FROM recipe_runs ORDER BY id DESC LIMIT ?", limit)
}

// listRuns closes the cursor before calling GetRun. This matters because SQLite
// is deliberately configured with one connection for consistent in-process use.
func (s *Store) listRuns(ctx context.Context, query string, argument any) ([]Run, error) {
	rows, err := s.db.QueryContext(ctx, query, argument)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := make([]Run, 0, len(ids))
	for _, id := range ids {
		v, err := s.GetRun(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}
