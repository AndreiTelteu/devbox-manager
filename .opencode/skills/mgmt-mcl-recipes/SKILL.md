---
name: mgmt-mcl-recipes
description: >-
  Write, review, and validate mgmt 1.1.0 MCL (.mcl) recipes for system
  packages, npm packages, Nix packages and configuration, services, and
  idempotent installation scripts with binary verification. Use for raw MCL
  recipes and Devbox Manager's Builder tab.
version: 2.0.0
metadata:
  tags: [mgmt, mcl, provisioning, nix, npm, packages]
---

# mgmt 1.1.0 MCL recipes

Use this skill for recipes executed by Devbox Manager. The installed binary is
`/home/andrei/.local/bin/mgmt`, version `1.1.0`. The app runs recipes as:

```sh
mgmt run --tmp-prefix lang <recipe.mcl>
```

The backend can append `--max-runtime N`; zero means no runtime limit. For a
fast syntax/type check that does not apply resources, use:

```sh
/home/andrei/.local/bin/mgmt run --tmp-prefix --no-network --no-pgp \
  lang --only-unify recipe.mcl
```

## Non-negotiable MCL rules

1. Use tabs for indentation.
2. Resource attribute lines require trailing commas.
3. List and map literals require a trailing comma after the final item.
4. A map has quoted keys; a `struct` has unquoted field names.
5. Values are immutable and statically typed. Use `$name = value` once.
6. Imported function modules are explicit: `import "sys"`, then call
   `sys.env()`. Do not assume a namespace is in scope.

```mcl
import "sys"

$packages = [
	"git",
	"curl",
]

$config = {
	"auto-optimise-store" => "true",
	"keep-outputs" => "true",
}

$host = sys.hostname()

file "/tmp/mgmt-example.txt" {
	content => "Managed by mgmt.\n",
	state => "exists",
	mode => "0644",
}
```

`file` needs `state => "exists",` to create a missing path. `content` or
`mode` alone do not imply creation.

## Builder-compatible resources

Devbox Manager's Builder supports `pkg`, `file`, `svc`, `exec`, `cron`,
`noop`, and `print` (`web/src/builder.ts`). Raw nodes preserve other valid MCL,
but prefer these resource kinds whenever possible.

| Resource | Use | Important fields |
|---|---|---|
| `pkg` | Native distro package | `state => "installed",` |
| `file` | File or directory | `state`, `content`, `mode`, `owner`, `group`, `recurse` |
| `svc` | systemd service | `state => "running", startup => "enabled",` |
| `exec` | Command or installer | `cmd`, `args`, `shell`, `env`, `nifcmd`, `nifshell`, `creates`, `mtimes` |
| `cron` | systemd timer | `trigger`, `time`, `unit`, `state`, `startup`, `session` |
| `print` | Progress/status log | `msg` |

## `exec` is deliberately minimal: set shell and environment

`exec` starts with an **empty environment** and uses **no shell by default**.
This is the most common source of broken recipes.

- Use absolute executable paths plus `args` when shell syntax is unnecessary.
- For `command -v`, pipes, redirects, variables, `&&`, or `||`, set both
  `shell => "/bin/sh",` and `env => sys.env(),`.
- Do not treat a bare `exec` command string as a shell script.
- `creates` skips execution when an absolute path exists, but is not a lock or
  a universal guarantee. The installer itself must remain safe to re-run.
- `nifcmd` blocks `cmd` when it exits zero. Pair it with `nifshell` and use it
  as an optimization; keep `cmd` idempotent because mtime changes can force it.

```mcl
import "sys"

exec "install-starship" {
	cmd => "command -v starship >/dev/null 2>&1 || curl -fsSL https://starship.rs/install.sh | sh -s -- --yes",
	shell => "/bin/sh",
	env => sys.env(),
}

exec "verify-starship" {
	cmd => "command -v starship >/dev/null 2>&1",
	shell => "/bin/sh",
	env => sys.env(),
}
```

Use an explicit binary guard for every random installer. A failed verification
is better than silently succeeding with a binary that is absent from `PATH`.

## Function modules

The upstream reference is https://mgmtconfig.com/docs/functions/. Import only
the module used by a recipe. The functions below were syntax/type checked with
the installed mgmt 1.1.0 binary; check upstream documentation before adding a
function not listed here.

| Import | Function | Use |
|---|---|---|
| `sys` | `sys.env()` | Pass the inherited environment to `exec`. |
| `sys` | `sys.hostname()` | Host name fact. |
| `os` | `os.family()` | Distro family string. |
| `strings` | `strings.join_nonempty(list, sep)` | Render non-empty config lines. |
| `fmt` | `fmt.printf(format, values...)` | Format output; format string must be static. |
| `golang` | `golang.template(text, value)` | Render configuration templates. Struct fields use title case in templates. |

Facts such as `os.*` and `sys.*` are reactive values. Do not use them to
generate incompatible resource graphs with a compile-time `if`. For runtime
installation decisions, use an idempotent `exec` command guard instead.

## npm packages

Install Node first, then make each package installation repeat-safe. The npm
global prefix varies by account and installation method, so `command -v` plus
`nifcmd` is more reliable than assuming `/usr/lib/node_modules`.

```mcl
import "sys"

pkg "nodejs" {
	state => "installed",
}

pkg "npm" {
	state => "installed",
}

exec "install-pnpm" {
	cmd => "npm install --global pnpm@9",
	shell => "/bin/sh",
	env => sys.env(),
	nifcmd => "command -v pnpm >/dev/null 2>&1",
	nifshell => "/bin/sh",
}

exec "verify-pnpm" {
	cmd => "pnpm --version",
	shell => "/bin/sh",
	env => sys.env(),
}
```

For NodeSource, nvm, fnm, or Volta, use a dedicated `exec` resource and verify
both `node --version` and `npm --version`. Do not mix multiple Node installers
in one recipe.

## Nix packages and configuration

Treat Nix in two layers:

1. Bootstrap and configure the Nix daemon/store at the system level.
2. Install user-facing tools through a deliberately selected profile or a
   declarative NixOS/Home Manager configuration.

Do not manage `/nix/store` directly. Do not use `pkg "nix"` for a NixOS host;
NixOS declares Nix itself through its system configuration. On Debian-like
hosts, use the official installer or the distro package, then verify `nix`.

```mcl
import "sys"

exec "verify-nix" {
	cmd => "nix --version",
	shell => "/bin/sh",
	env => sys.env(),
}

exec "install-ripgrep-with-nix" {
	cmd => "nix profile install nixpkgs#ripgrep",
	shell => "/bin/sh",
	env => sys.env(),
	nifcmd => "command -v rg >/dev/null 2>&1",
	nifshell => "/bin/sh",
}

exec "verify-ripgrep" {
	cmd => "rg --version",
	shell => "/bin/sh",
	env => sys.env(),
}
```

For Nix configuration, model the complete intended file. Keep the config
content in one MCL variable, set `state => "exists",`, and use `mtimes` to
reload the daemon only after the config changes:

```mcl
import "sys"

$nix_conf = "# Managed by mgmt.\nexperimental-features = nix-command flakes\nauto-optimise-store = true\ntrusted-users = root @wheel\n"

file "/etc/nix/nix.conf" {
	content => $nix_conf,
	state => "exists",
	mode => "0644",
}

exec "reload-nix-daemon-after-config-change" {
	cmd => "systemctl reload-or-restart nix-daemon",
	shell => "/bin/sh",
	env => sys.env(),
	mtimes => [
		"/etc/nix/nix.conf",
	],
	nifcmd => "/bin/false",
}
```

`mtimes` forces the reload when `nix.conf` is newer than the last command run;
`nifcmd => "/bin/false",` suppresses ordinary repeat runs. The daemon name can
be `nix-daemon.service` on non-NixOS systems. For user config, manage
`~/.config/nix/nix.conf` with a concrete absolute home path and do not restart
the system daemon.

Use `nix profile install nixpkgs#name` for imperative package recipes. For a
NixOS or Home Manager system, prefer managing the repository configuration
file and running the appropriate rebuild command as a verified `exec`:

```mcl
import "sys"

exec "apply-nixos-configuration" {
	cmd => "nixos-rebuild switch --flake /etc/nixos#hostname",
	shell => "/bin/sh",
	env => sys.env(),
}
```

Replace `hostname` with the actual flake target. Do not run this recipe on a
non-NixOS host.

## PHP, MySQL, and Docker

Use native packages and `svc` resources first. Pin versioned package names
only when the distro repository provides that version.

```mcl
pkg "php8.3-fpm" {
	state => "installed",
}

pkg "php8.3-mysql" {
	state => "installed",
}

svc "php8.3-fpm" {
	state => "running",
	startup => "enabled",
}

pkg "mysql-server" {
	state => "installed",
}

svc "mysql" {
	state => "running",
	startup => "enabled",
}

pkg "docker.io" {
	state => "installed",
}

svc "docker" {
	state => "running",
	startup => "enabled",
}
```

For Docker's official repository or a third-party PHP repository, use a
separate bootstrap `exec` with `creates` anchored to the repository file, then
declare packages and services normally. Never pipe a remote installer into a
shell without pinning its version or verifying a checksum where practical.

## Review checklist

1. Run `mgmt ... lang --only-unify` before saving a non-trivial recipe.
2. Confirm every resource attribute, list item, map item, and struct field has
   the required trailing comma.
3. Ensure every `file` creation has `state => "exists",`.
4. For every shell command, include `shell => "/bin/sh",` and `env => sys.env(),`.
5. Set Devbox Manager's recipe `max_runtime` when a package download, Nix
   profile change, or rebuild needs a runtime limit.
6. Pair every installer with a binary or service verification resource.
7. Use `pkg`/`svc` before `exec`; reserve shell scripts for actions that the
   native resources cannot model.
8. Never place secrets directly in an MCL recipe. Read a protected local file
   or inject an environment value deliberately instead.
