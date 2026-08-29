// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

package devbox

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

type API struct {
	Store  *Store
	Events *Broker
	Runner Runner
}

func (a API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/events", a.sseEvents)
	mux.HandleFunc("GET /api/servers", a.listServers)
	mux.HandleFunc("POST /api/servers", a.createServer)
	mux.HandleFunc("GET /api/servers/{id}", a.getServer)
	mux.HandleFunc("PUT /api/servers/{id}", a.updateServer)
	mux.HandleFunc("DELETE /api/servers/{id}", a.deleteServer)
	mux.HandleFunc("GET /api/recipes", a.listRecipes)
	mux.HandleFunc("POST /api/recipes", a.createRecipe)
	mux.HandleFunc("GET /api/recipe-folders", a.listRecipeFolders)
	mux.HandleFunc("POST /api/recipe-folders", a.createRecipeFolder)
	mux.HandleFunc("GET /api/recipes/{name...}", a.getRecipe)
	mux.HandleFunc("PUT /api/recipes/{name...}", a.updateRecipe)
	mux.HandleFunc("DELETE /api/recipes/{name...}", a.deleteRecipe)
	mux.HandleFunc("GET /api/runs", a.listRuns)
	mux.HandleFunc("POST /api/runs", a.runRecipe)
	return mux
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		respond(w, 400, map[string]string{"error": "invalid JSON: " + e.Error()})
		return false
	}
	return true
}
func id(r *http.Request) (int64, error) { return strconv.ParseInt(r.PathValue("id"), 10, 64) }
func errorResponse(w http.ResponseWriter, e error) {
	if errors.Is(e, ErrNotFound) {
		respond(w, 404, map[string]string{"error": "not found"})
		return
	}
	if strings.Contains(e.Error(), "UNIQUE constraint failed") {
		respond(w, 409, map[string]string{"error": "name already exists"})
		return
	}
	respond(w, 400, map[string]string{"error": e.Error()})
}
func (a API) listServers(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.ListServers(r.Context())
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) createServer(w http.ResponseWriter, r *http.Request) {
	var v Server
	if !decode(w, r, &v) {
		return
	}
	v, e := a.Store.CreateServer(r.Context(), v)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 201, v)
}
func (a API) getServer(w http.ResponseWriter, r *http.Request) {
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	v, e := a.Store.GetServer(r.Context(), x)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) updateServer(w http.ResponseWriter, r *http.Request) {
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	var v Server
	if !decode(w, r, &v) {
		return
	}
	v, e = a.Store.UpdateServer(r.Context(), x, v)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) deleteServer(w http.ResponseWriter, r *http.Request) {
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	if e = a.Store.DeleteServer(r.Context(), x); e != nil {
		errorResponse(w, e)
		return
	}
	w.WriteHeader(204)
}
func (a API) listRecipes(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.ListRecipes(r.Context())
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) createRecipe(w http.ResponseWriter, r *http.Request) {
	var v Recipe
	if !decode(w, r, &v) {
		return
	}
	v, e := a.Store.CreateRecipe(r.Context(), v)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 201, v)
}
func (a API) getRecipe(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.GetRecipe(r.Context(), r.PathValue("name"))
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) updateRecipe(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var v Recipe
	if !decode(w, r, &v) {
		return
	}
	if strings.TrimSpace(v.Name) == "" {
		v.Name = name
	}
	v, e := a.Store.UpdateRecipe(r.Context(), name, v)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) deleteRecipe(w http.ResponseWriter, r *http.Request) {
	if e := a.Store.DeleteRecipe(r.Context(), r.PathValue("name")); e != nil {
		errorResponse(w, e)
		return
	}
	w.WriteHeader(204)
}

type folderRequest struct {
	Path string `json:"path"`
}

func (a API) listRecipeFolders(w http.ResponseWriter, r *http.Request) {
	folders, e := a.Store.ListRecipeFolders(r.Context())
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, folders)
}

func (a API) createRecipeFolder(w http.ResponseWriter, r *http.Request) {
	var req folderRequest
	if !decode(w, r, &req) {
		return
	}
	name, e := a.Store.CreateRecipeFolder(r.Context(), req.Path)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 201, map[string]string{"path": name})
}

type runRequest struct {
	Recipe     string `json:"recipe"`
	ServerID   *int64 `json:"server_id"`
	MaxRuntime int    `json:"max_runtime"`
}

func (a API) runRecipe(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Recipe) == "" {
		respond(w, 400, map[string]string{"error": "recipe is required"})
		return
	}
	if req.MaxRuntime < 0 || req.MaxRuntime > 24*60*60 {
		respond(w, 400, map[string]string{"error": "max_runtime must be between 0 and 86400 seconds"})
		return
	}
	v, e := a.Runner.Run(r.Context(), req.Recipe, req.ServerID, req.MaxRuntime)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 201, v)
}
func (a API) sseEvents(w http.ResponseWriter, r *http.Request) {
	if a.Events == nil {
		respond(w, http.StatusServiceUnavailable, map[string]string{"error": "event streaming unavailable"})
		return
	}
	a.Events.ServeSSE(w, r)
}
func (a API) listRecentRuns(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.ListRecentRuns(r.Context(), 50)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}

func (a API) listRuns(w http.ResponseWriter, r *http.Request) {
	recipe := r.URL.Query().Get("recipe")
	if recipe == "" {
		v, e := a.Store.ListRecentRuns(r.Context(), 500)
		if e != nil {
			errorResponse(w, e)
			return
		}
		respond(w, 200, v)
		return
	}
	v, e := a.Store.ListRuns(r.Context(), recipe)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
