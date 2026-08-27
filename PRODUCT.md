# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The developer (a single person) managing their own dev boxes and [Bun shell](https://bun.com/docs/runtime/shell) recipes — a personal tool used on a trusted local network.

## Product Purpose

A local, unauthenticated Go backend and CLI plus an embedded SolidJS web UI for server inventory and Bun shell recipe management. It records recipe runs (status, exit code, timestamps, combined output) by executing the recipe with `bun` inside `nix-shell -p bun` — locally, or over SSH on a checked inventory server. Success: one place to track servers and scripted recipes with auditable run output.

## Positioning

A lightweight control-plane for a handful of dev boxes: write a shell recipe once, run it locally or stream it to any checked server over SSH.

## Operating Context

- Runs on the user's own machine or trusted network; file store under `data/` (override via `DEVBOX_MANAGER_DATA`).
- Served via `./devbox-manager serve -addr :8080` as a single binary embedding the pre-built `web/dist` SPA.
- Also usable via CLI (`server create/list/update/delete`, `recipe create/list/update/run/delete`, `service install/status/restart` with user systemd).
- `nix-shell` must be present on every executing machine (local or remote); bun is provided by nix.

## Capabilities and Constraints

- REST API under `/api`: servers CRUD, recipes CRUD, `POST /api/recipes/{id}/run` (optional `server_id`), run history per recipe, health check. No authentication — deploy only on trusted networks.
- SSH execution uses the current user's SSH config and agent; per-server runs are serialized with `flock`.
- Frontend: SolidJS + Vite + TypeScript, single-file app in `web/src/main.tsx`; embedded into the Go binary at build time.

## Brand Commitments

Name: "Devbox Manager". No other identity commitments recorded.

## Evidence on Hand

README.md documents build, CLI usage, API surface, and test commands (`gofmt -w cmd internal`, `go test ./...`). No marketing content, testimonials, screenshots, or case studies exist; none may be fabricated.

## Product Principles

- Local-first simplicity: single binary, no login, no external services.
- Audit everything: every run leaves persisted status, timing, and output.
- Honest scope: local runs stay local; a checked server context runs the same recipe over SSH.

## Accessibility & Inclusion
