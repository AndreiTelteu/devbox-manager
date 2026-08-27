# devbox-manager

A local, unauthenticated Go backend and CLI for server inventory and
[Bun shell](https://bun.com/docs/runtime/shell) recipe management, with an
embedded SolidJS+TS single-page UI. Licensed MIT (see `LICENSE`) — every
source file starts with the short MIT header comment.

## Layout

- `cmd/devbox-manager/main.go` — CLI entry point (`serve`, `service`, `server`,
  `recipe` subcommands); `//go:embed web` bundles the built SPA.
- `internal/devbox/` — file store under `data/` (`store.go`: `hosts.yml`,
  `recipes/*.ts`, `logs/*.json`), HTTP/JSON API (`http.go`), bun/nix-shell
  runner (`run.go`). `data/` is a nested private git repo ignored by the parent.
- `web/` — SolidJS SPA; `src/main.tsx` is the whole app.
- `bin/devbox-manager` — the built binary the systemd user service runs.

## Build, test, deploy loop

```sh
export PATH=$PATH:/home/andrei/.local/go/bin   # go1.26 toolchain is NOT on PATH

# UI changes: build and sync into the go:embed location
cd web && npm run build
rm -rf ../cmd/devbox-manager/web && cp -r dist ../cmd/devbox-manager/web

# backend changes / full rebuild into the service binary location
go build -o bin/devbox-manager ./cmd/devbox-manager
gofmt -l cmd internal          # must print nothing
go test ./...

# restart the running user service (systemd picks up the new binary)
./bin/devbox-manager service restart
./bin/devbox-manager service status
```

The service is a user systemd unit (`~/.config/systemd/user/devbox-manager.service`)
managed through the CLI itself:

```sh
./bin/devbox-manager service install --addr :8080
./bin/devbox-manager service start|stop|restart|enable|disable|status
```

Never `pkill` the server; systemd just restarts it. Use `service restart`.

## UI craft gates

Before shipping UI changes: run
`node ~/.agents/skills/impeccable/scripts/detect.mjs --json web/src/main.tsx web/src/styles.css`
and expect `[]`. No emojis, drawn SVG icons only, English UI copy.

## Recipe runtime facts

Recipes are Bun shell scripts (`import { $ } from "bun"`). Runs execute inside
`nix-shell -p bun` — locally, or over SSH when a server context is checked
(the recipe is piped to the server over stdin and run the same way there).
`nix-shell` must exist on the executing machine; bun is fetched by nix.
`--max-runtime N` (CLI) / `max_runtime` (API, 0..86400 seconds, 0 = no limit)
wraps the run in coreutils `timeout`. Remote runs are serialized per server
with `flock` (`/tmp/devbox-manager-bun.lock` on the server).
