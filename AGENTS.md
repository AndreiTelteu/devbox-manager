# devbox-manager

A local, unauthenticated Go backend and CLI for server inventory and
[mgmt](https://github.com/purpleidea/mgmt) MCL recipe management, with an
embedded SolidJS+TS single-page UI. Licensed GPL-3.0-or-later (see `LICENSE`),
same as mgmt — every source file starts with the short GPL header comment.

## Layout

- `cmd/devbox-manager/main.go` — CLI entry point (`serve`, `service`, `server`,
  `recipe` subcommands); `//go:embed web` bundles the built SPA.
- `internal/devbox/` — file store under `data/` (`store.go`: `hosts.yml`,
  `recipes/*.mcl`, `logs/*.json`), HTTP/JSON API (`http.go`), mgmt runner
  (`run.go`). `data/` is a nested private git repo ignored by the parent.
- `web/` — SolidJS SPA. `src/main.tsx` is the app, `src/builder.ts` the pure
  MCL parser/emitter model for the Builder tab (no React/Solid imports).
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

## Builder parser tests

`web/src/builder.ts` is validated with a Node harness (strip-types);

```sh
cp web/src/builder.ts /tmp/opencode/builder-test.mts
node --experimental-strip-types /tmp/opencode/builder-test-run.mts   # ALL PASS expected
```

## UI craft gates

Before shipping UI changes: run
`node ~/.agents/skills/impeccable/scripts/detect.mjs --json web/src/main.tsx web/src/styles.css`
and expect `[]`. No emojis, drawn SVG icons only, English UI copy.

## mgmt facts

Installed binary targets mgmt 1.1.0 at `/home/andrei/.local/bin/mgmt`
(`mgmt run --tmp-prefix lang <file.mcl>`);
MCL there **requires trailing commas** on attribute lines. The Builder preserves
unrecognised MCL verbatim as raw nodes; known resource kinds are
pkg/file/exec/svc/noop/print/void. Recipe runs honor `-max-runtime N` (CLI) and
`max_runtime` (API, 0..86400 seconds, 0 = no limit).
