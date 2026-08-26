# devbox-manager

A local, unauthenticated Go backend and CLI for server inventory and [mgmt](https://github.com/purpleidea/mgmt) MCL recipe management.

## Build and run

```sh
go build -o devbox-manager ./cmd/devbox-manager
./devbox-manager serve -addr :8080
```

Inventory lives under `data/` (`hosts.yml`, `recipes/*.mcl`, `logs/`). Set
`DEVBOX_MANAGER_DATA` to choose another root. `data/` is a nested private git
repo (ignored by the parent project); host/recipe edits auto-commit; `logs/`
stays untracked.

## CLI

```sh
# Server inventory
./devbox-manager server create --name web-1 --host 192.0.2.10 --port 22 --username admin
./devbox-manager server list
./devbox-manager server update --id 1 --name web-1 --host web.internal --port 22 --username admin
./devbox-manager server delete --id 1

# MCL recipes
./devbox-manager recipe create --name example --file recipe.mcl
./devbox-manager recipe list
./devbox-manager recipe update --id 1 --name example --content 'resource noop() {}'
./devbox-manager recipe run --id 1
./devbox-manager recipe run --id 1 --max-runtime 120
./devbox-manager recipe delete --id 1

# user systemd (no sudo; unit: ~/.config/systemd/user/devbox-manager.service)
./devbox-manager service install --addr :8080
./devbox-manager service status
./devbox-manager service start|stop|restart|enable|disable
```

`recipe run` writes a private temporary `.mcl` file and invokes `mgmt run --tmp-prefix lang <temporary recipe.mcl>` locally. It persists status, exit code, timestamps, and combined stdout/stderr. `--max-runtime <seconds>` clamps each run and is forwarded to mgmt as `--max-runtime`. With mgmt 1.1.0, the runner uses `--converger-timeout` and `--converged-exit` for its convergence exit. An empty `--mgmt-seeds` (the default) starts an isolated embedded etcd; set it only when an existing mgmt etcd endpoint is available. Because mgmt's embedded etcd uses fixed localhost ports, isolated runs are queued one at a time. `--server-id` records an inventory server for audit, but does **not** perform remote execution; remote mgmt agents/etcd are intentionally outside this MVP.

By default, `serve` first resolves `mgmt` from its own `PATH`, then asks fish with `fish -lc 'command -s -- mgmt'`. This makes user-local installations such as `~/.local/bin/mgmt` available when devbox-manager runs as a systemd user service. Use `-mgmt /absolute/path/to/mgmt` to override this lookup.

## REST API

The `serve` binary embeds the pre-built `web/dist` SolidJS application. It serves static assets and falls back to `index.html` for client-side SPA routes; `/api/*` remains reserved for the API.

All endpoints are JSON under `/api`:

- `GET, POST /api/servers`
- `GET, PUT, DELETE /api/servers/{id}`
- `GET, POST /api/recipes`
- `GET, PUT, DELETE /api/recipes/{id}`
- `POST /api/recipes/{id}/run` with optional `{ "server_id": 1, "max_runtime": 120 }` (`max_runtime` is seconds, 0 = no limit, max 86400)
- `GET /api/recipes/{id}/runs`
- `GET /api/health`

No authentication is included; deploy only on an appropriately trusted network.

## Test

```sh
gofmt -w cmd internal
go test ./...
```

## License

[GPL-3.0-or-later](LICENSE), same as [mgmt](https://github.com/purpleidea/mgmt).
