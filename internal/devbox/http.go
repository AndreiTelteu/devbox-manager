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
	Runner Runner
}

func (a API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/servers", a.listServers)
	mux.HandleFunc("POST /api/servers", a.createServer)
	mux.HandleFunc("GET /api/servers/{id}", a.getServer)
	mux.HandleFunc("PUT /api/servers/{id}", a.updateServer)
	mux.HandleFunc("DELETE /api/servers/{id}", a.deleteServer)
	mux.HandleFunc("GET /api/recipes", a.listRecipes)
	mux.HandleFunc("POST /api/recipes", a.createRecipe)
	mux.HandleFunc("GET /api/recipes/{id}", a.getRecipe)
	mux.HandleFunc("PUT /api/recipes/{id}", a.updateRecipe)
	mux.HandleFunc("DELETE /api/recipes/{id}", a.deleteRecipe)
	mux.HandleFunc("POST /api/recipes/{id}/run", a.runRecipe)
	mux.HandleFunc("GET /api/recipes/{id}/runs", a.listRuns)
	mux.HandleFunc("GET /api/runs", a.listRecentRuns)
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
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	v, e := a.Store.GetRecipe(r.Context(), x)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) updateRecipe(w http.ResponseWriter, r *http.Request) {
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	var v Recipe
	if !decode(w, r, &v) {
		return
	}
	v, e = a.Store.UpdateRecipe(r.Context(), x, v)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
func (a API) deleteRecipe(w http.ResponseWriter, r *http.Request) {
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	if e = a.Store.DeleteRecipe(r.Context(), x); e != nil {
		errorResponse(w, e)
		return
	}
	w.WriteHeader(204)
}

type runRequest struct {
	ServerID *int64 `json:"server_id"`
}

func (a API) runRecipe(w http.ResponseWriter, r *http.Request) {
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	var req runRequest
	if !decode(w, r, &req) {
		return
	}
	v, e := a.Runner.Run(r.Context(), x, req.ServerID)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 201, v)
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
	x, e := id(r)
	if e != nil {
		respond(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	if _, e = a.Store.GetRecipe(r.Context(), x); e != nil {
		errorResponse(w, e)
		return
	}
	v, e := a.Store.ListRuns(r.Context(), x)
	if e != nil {
		errorResponse(w, e)
		return
	}
	respond(w, 200, v)
}
