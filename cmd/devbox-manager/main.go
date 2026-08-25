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

package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/andrei/devbox-manager/internal/devbox"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return usage()
	}
	if args[0] == "service" {
		return service(args[1:])
	}
	dbPath := os.Getenv("DEVBOX_MANAGER_DB")
	if dbPath == "" {
		dbPath = "devbox-manager.db"
	}
	s, e := devbox.Open(ctx, dbPath)
	if e != nil {
		return e
	}
	defer s.Close()
	switch args[0] {
	case "serve":
		return serve(s, args[1:])
	case "server":
		return server(ctx, s, args[1:])
	case "recipe":
		return recipe(ctx, s, args[1:])
	default:
		return usage()
	}
}
func usage() error {
	return errors.New("usage: devbox-manager serve [-addr :8080] | service <install|status|start|stop|restart|enable|disable|config> | server <list|create|update|delete> | recipe <list|create|update|delete|run>")
}

//go:embed web
var webFiles embed.FS

func webHandler(api http.Handler) (http.Handler, error) {
	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		return nil, err
	}
	files := http.FileServer(http.FS(webRoot))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(webRoot, path); err != nil {
			r.URL.Path = "/" // SPA client-route fallback to index.html.
		}
		files.ServeHTTP(w, r)
	}), nil
}

func serve(s *devbox.Store, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", ":8080", "listen address")
	mgmt := fs.String("mgmt", "mgmt", "path to mgmt executable; the default is resolved from fish")
	mgmtSeeds := fs.String("mgmt-seeds", "", "existing Mgmt etcd endpoint; empty starts an isolated embedded etcd")
	convergedTimeout := fs.Int("converged-timeout", 2, "seconds Mgmt must be converged before this one-shot run exits (0 disables)")
	if e := fs.Parse(args); e != nil {
		return e
	}
	mgmtExecutable, err := resolveMgmtExecutable(*mgmt)
	if err != nil {
		return err
	}
	api := devbox.API{Store: s, Runner: devbox.Runner{Store: s, Executable: mgmtExecutable, Seeds: *mgmtSeeds, ConvergedTimeout: *convergedTimeout}}
	handler, err := webHandler(api.Handler())
	if err != nil {
		return err
	}
	log.Printf("serving embedded web app and API on %s with mgmt at %s", *addr, mgmtExecutable)
	return http.ListenAndServe(*addr, handler)
}

// resolveMgmtExecutable makes a user-installed mgmt available to a systemd
// user service, whose PATH does not include paths configured by fish.
func resolveMgmtExecutable(configured string) (string, error) {
	if configured != "mgmt" {
		return configured, nil
	}
	if path, err := exec.LookPath(configured); err == nil {
		return path, nil
	}
	output, err := exec.Command("fish", "-lc", "command -s -- mgmt").Output()
	if err != nil {
		return "", fmt.Errorf("resolve mgmt from PATH or fish: %w", err)
	}
	path := strings.TrimSpace(string(output))
	if path == "" {
		return "", errors.New("mgmt is not available in PATH or fish")
	}
	if _, err := exec.LookPath(path); err != nil {
		return "", fmt.Errorf("resolve mgmt path from fish: %w", err)
	}
	return path, nil
}

const serviceName = "devbox-manager.service"

func service(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: devbox-manager service <install|status|start|stop|restart|enable|disable|config host <host>>")
	}
	switch args[0] {
	case "install":
		fs := flag.NewFlagSet("service install", flag.ContinueOnError)
		addr := fs.String("addr", ":8080", "listen address")
		mgmt := fs.String("mgmt", "mgmt", "path to mgmt executable; the default is resolved from fish")
		mgmtSeeds := fs.String("mgmt-seeds", "", "existing Mgmt etcd endpoint; empty starts an isolated embedded etcd")
		convergedTimeout := fs.Int("converged-timeout", 2, "seconds Mgmt must be converged before a recipe run exits")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() != 0 {
			return errors.New("service install accepts flags only")
		}
		executable, err := os.Executable()
		if err != nil {
			return fmt.Errorf("resolve executable: %w", err)
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return fmt.Errorf("resolve executable symlink: %w", err)
		}
		dbPath := os.Getenv("DEVBOX_MANAGER_DB")
		if dbPath == "" {
			dbPath = filepath.Join(filepath.Dir(executable), "devbox-manager.db")
		}
		unit := fmt.Sprintf(`[Unit]
Description=Devbox Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=DEVBOX_MANAGER_DB=%s
ExecStart=%s serve -addr %s -mgmt %s -mgmt-seeds %s -converged-timeout %d
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`, systemdQuote(dbPath), systemdQuote(executable), systemdQuote(*addr), systemdQuote(*mgmt), systemdQuote(*mgmtSeeds), *convergedTimeout)
		unitDir, err := userSystemdUnitDir()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(unitDir, 0o755); err != nil {
			return fmt.Errorf("create user systemd unit directory: %w", err)
		}
		if err := os.WriteFile(filepath.Join(unitDir, serviceName), []byte(unit), 0o644); err != nil {
			return fmt.Errorf("write user systemd unit: %w", err)
		}
		if err := systemctl("daemon-reload"); err != nil {
			return err
		}
		if err := systemctl("enable", "--now", serviceName); err != nil {
			return err
		}
		return systemctl("status", "--no-pager", serviceName)
	case "status":
		return systemctl("status", "--no-pager", serviceName)
	case "start":
		return systemctl("start", serviceName)
	case "stop":
		return systemctl("stop", serviceName)
	case "restart":
		return systemctl("restart", serviceName)
	case "enable":
		return systemctl("enable", serviceName)
	case "disable":
		return systemctl("disable", serviceName)
	case "config":
		return serviceConfig(args[1:])
	default:
		return errors.New("usage: devbox-manager service <install|status|start|stop|restart|enable|disable|config host <host>>")
	}
}

func serviceConfig(args []string) error {
	if len(args) != 2 || args[0] != "host" {
		return errors.New("usage: devbox-manager service config host <host>")
	}
	host := strings.TrimSpace(args[1])
	if host == "" || strings.ContainsAny(host, "\r\n\x00") {
		return errors.New("host must be a single non-empty value")
	}
	unitDir, err := userSystemdUnitDir()
	if err != nil {
		return err
	}
	unitPath := filepath.Join(unitDir, serviceName)
	content, err := os.ReadFile(unitPath)
	if err != nil {
		return fmt.Errorf("read user systemd unit: %w", err)
	}
	lines := strings.Split(string(content), "\n")
	changed := false
	for i, line := range lines {
		if !strings.HasPrefix(line, "ExecStart=") {
			continue
		}
		match := regexp.MustCompile(`-addr\s+(?:"([^"]+)"|(\S+))`).FindStringSubmatchIndex(line)
		if match == nil {
			continue
		}
		addrStart, addrEnd := match[2], match[3]
		if addrStart == -1 {
			addrStart, addrEnd = match[4], match[5]
		}
		_, port, splitErr := net.SplitHostPort(line[addrStart:addrEnd])
		if splitErr != nil {
			return fmt.Errorf("parse service listen address: %w", splitErr)
		}
		lines[i] = line[:addrStart] + net.JoinHostPort(host, port) + line[addrEnd:]
		changed = true
		if changed {
			break
		}
	}
	if !changed {
		return errors.New("service unit has no ExecStart -addr setting")
	}
	if err := os.WriteFile(unitPath, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return fmt.Errorf("write user systemd unit: %w", err)
	}
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	return systemctl("restart", serviceName)
}

func userSystemdUnitDir() (string, error) {
	if configHome := os.Getenv("XDG_CONFIG_HOME"); configHome != "" {
		return filepath.Join(configHome, "systemd", "user"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home for systemd unit: %w", err)
	}
	return filepath.Join(home, ".config", "systemd", "user"), nil
}

func systemdQuote(value string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(value, `\\`, `\\\\`), `"`, `\\"`) + `"`
}

func systemctl(args ...string) error {
	cmd := exec.Command("systemctl", append([]string{"--user"}, args...)...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func server(ctx context.Context, s *devbox.Store, args []string) error {
	if len(args) == 0 {
		return usage()
	}
	switch args[0] {
	case "list":
		v, e := s.ListServers(ctx)
		if e != nil {
			return e
		}
		return print(v)
	case "create", "update":
		fs := flag.NewFlagSet("server "+args[0], flag.ContinueOnError)
		name := fs.String("name", "", "server name")
		host := fs.String("host", "", "hostname or IP")
		port := fs.Int("port", 22, "SSH port")
		user := fs.String("username", "", "username")
		id := fs.Int64("id", 0, "server id (update)")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		v := devbox.Server{Name: *name, Host: *host, Port: *port, Username: *user}
		var e error
		if args[0] == "create" {
			v, e = s.CreateServer(ctx, v)
		} else {
			if *id < 1 {
				return errors.New("--id is required")
			}
			v, e = s.UpdateServer(ctx, *id, v)
		}
		if e != nil {
			return e
		}
		return print(v)
	case "delete":
		fs := flag.NewFlagSet("server delete", flag.ContinueOnError)
		id := fs.Int64("id", 0, "server id")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		if *id < 1 {
			return errors.New("--id is required")
		}
		return s.DeleteServer(ctx, *id)
	}
	return usage()
}
func recipe(ctx context.Context, s *devbox.Store, args []string) error {
	if len(args) == 0 {
		return usage()
	}
	switch args[0] {
	case "list":
		v, e := s.ListRecipes(ctx)
		if e != nil {
			return e
		}
		return print(v)
	case "create", "update":
		fs := flag.NewFlagSet("recipe "+args[0], flag.ContinueOnError)
		name := fs.String("name", "", "recipe name")
		content := fs.String("content", "", "MCL content")
		file := fs.String("file", "", "read MCL content from file")
		id := fs.Int64("id", 0, "recipe id (update)")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		if *file != "" {
			b, e := os.ReadFile(filepath.Clean(*file))
			if e != nil {
				return e
			}
			*content = string(b)
		}
		v := devbox.Recipe{Name: *name, Content: *content}
		var e error
		if args[0] == "create" {
			v, e = s.CreateRecipe(ctx, v)
		} else {
			if *id < 1 {
				return errors.New("--id is required")
			}
			v, e = s.UpdateRecipe(ctx, *id, v)
		}
		if e != nil {
			return e
		}
		return print(v)
	case "delete":
		fs := flag.NewFlagSet("recipe delete", flag.ContinueOnError)
		id := fs.Int64("id", 0, "recipe id")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		if *id < 1 {
			return errors.New("--id is required")
		}
		return s.DeleteRecipe(ctx, *id)
	case "run":
		fs := flag.NewFlagSet("recipe run", flag.ContinueOnError)
		id := fs.Int64("id", 0, "recipe id")
		serverID := fs.Int64("server-id", 0, "optional audited server id")
		mgmt := fs.String("mgmt", "mgmt", "path to mgmt executable; the default is resolved from fish")
		mgmtSeeds := fs.String("mgmt-seeds", "", "existing Mgmt etcd endpoint; empty starts an isolated embedded etcd")
		convergedTimeout := fs.Int("converged-timeout", 2, "seconds Mgmt must be converged before this one-shot run exits (0 disables)")
		maxRuntime := fs.Int("max-runtime", 0, "seconds before mgmt exits this run (0 disables)")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		if *id < 1 {
			return errors.New("--id is required")
		}
		var sp *int64
		if *serverID > 0 {
			sp = serverID
		}
		mgmtExecutable, e := resolveMgmtExecutable(*mgmt)
		if e != nil {
			return e
		}
		v, e := (devbox.Runner{Store: s, Executable: mgmtExecutable, Seeds: *mgmtSeeds, ConvergedTimeout: *convergedTimeout}).Run(ctx, *id, sp, *maxRuntime)
		if e != nil {
			return e
		}
		return print(v)
	}
	return usage()
}
func print(v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	fmt.Println(string(b))
	return nil
}

var _ = strconv.IntSize
var _ = strings.Builder{}
