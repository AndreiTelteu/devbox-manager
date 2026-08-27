# devbox-manager

A local, unauthenticated Go backend and CLI for server inventory and
[Bun shell](https://bun.com/docs/runtime/shell) recipe management.

## Build and run

```sh
go build -o devbox-manager ./cmd/devbox-manager
./devbox-manager serve -addr :8080
```

Inventory lives under `data/` (`hosts.yml`, `recipes/*.ts`, `logs/`). Set
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

# Bun shell recipes
./devbox-manager recipe create --name example --file recipe.ts
./devbox-manager recipe list
./devbox-manager recipe update --id 1 --name example --content 'import { $ } from "bun"'
./devbox-manager recipe run --id 1
./devbox-manager recipe run --id 1 --max-runtime 120
./devbox-manager recipe run --id 1 --server-id 1
./devbox-manager recipe delete --id 1

# user systemd (no sudo; unit: ~/.config/systemd/user/devbox-manager.service)
./devbox-manager service install --addr :8080
./devbox-manager service status
./devbox-manager service start|stop|restart|enable|disable
```

Recipes are [Bun shell](https://bun.com/docs/runtime/shell) scripts
(`import { $ } from "bun"`). `recipe run` writes the recipe to a private
temporary `.ts` file and executes it inside `nix-shell -p bun`, so bun never
needs to be installed permanently. With `--server-id`, the recipe is streamed
over SSH (stdin) and executed the same way on that server; `flock` serializes
concurrent runs per server. `--max-runtime <seconds>` wraps the run in
coreutils `timeout` (0 = no limit). Status, exit code, timestamps, and
combined stdout/stderr are persisted per run. Requires `nix-shell` on the
executing machine (local or remote); SSH auth uses the current user's normal
SSH config and agent.

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

[MIT](LICENSE)
