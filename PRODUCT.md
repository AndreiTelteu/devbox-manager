# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The developer (a single person) managing their own dev boxes and [mgmt](https://github.com/purpleidea/mgmt) MCL recipes — a personal tool used on a trusted local network.

## Product Purpose

A local, unauthenticated Go backend and CLI plus an embedded SolidJS web UI for server inventory and mgmt MCL recipe management. It records recipe runs (status, exit code, timestamps, combined output) by invoking `mgmt run --tmp-prefix lang <recipe.mcl>` locally. Success: one place to track servers and declarative recipes with auditable run output.

## Positioning

A stepping stone toward a remote control-plane for multi-server mgmt orchestration. Today execution is local-only; the selected inventory server is saved as audit context, not an execution target.

## Operating Context

- Runs on the user's own machine or trusted network; SQLite database (`devbox-manager.db`, override via `DEVBOX_MANAGER_DB`).
- Served via `./devbox-manager serve -addr :8080` as a single binary embedding the pre-built `web/dist` SPA.
- Also usable via CLI (`server create/list/update/delete`, `recipe create/list/update/run/delete`, `service install/status/restart` with user systemd).
- `mgmt` binary must be present locally for recipe runs.

## Capabilities and Constraints

- REST API under `/api`: servers CRUD, recipes CRUD, `POST /api/recipes/{id}/run` (optional `server_id`), run history per recipe, health check. No authentication — deploy only on trusted networks.
- Remote mgmt agents/etcd are intentionally outside this MVP; recorded server IDs are audit context only.
- Frontend: SolidJS + Vite + TypeScript, single-file app in `web/src/main.tsx`; embedded into the Go binary at build time.

## Brand Commitments

Name: "Devbox Manager". No other identity commitments recorded.

## Evidence on Hand

README.md documents build, CLI usage, API surface, and test commands (`gofmt -w cmd internal`, `go test ./...`). No marketing content, testimonials, screenshots, or case studies exist; none may be fabricated.

## Product Principles

- Local-first simplicity: single binary, no login, no external services.
- Audit everything: every run leaves persisted status, timing, and output.
- Honest scope: never imply remote execution that isn't happening.

## Accessibility & Inclusion
