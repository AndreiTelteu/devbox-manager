// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

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
	dataDir := os.Getenv("DEVBOX_MANAGER_DATA")
	if dataDir == "" {
		dataDir = "data"
	}
	s, e := devbox.Open(ctx, dataDir)
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
	if e := fs.Parse(args); e != nil {
		return e
	}
	broker := devbox.NewBroker()
	api := devbox.API{Store: s, Events: broker, Runner: devbox.Runner{Store: s, Events: broker}}
	handler, err := webHandler(api.Handler())
	if err != nil {
		return err
	}
	log.Printf("serving embedded web app and API on %s; recipes run with bun in nix-shell", *addr)
	return http.ListenAndServe(*addr, handler)
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
		dataDir := os.Getenv("DEVBOX_MANAGER_DATA")
		if dataDir == "" {
			// Prefer <repo>/data when the binary lives in <repo>/bin/.
			candidate := filepath.Join(filepath.Dir(executable), "..", "data")
			if abs, err := filepath.Abs(candidate); err == nil {
				dataDir = abs
			} else {
				dataDir = filepath.Join(filepath.Dir(executable), "data")
			}
		}
		workDir := filepath.Dir(dataDir)
		unit := fmt.Sprintf(`[Unit]
Description=Devbox Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%s
Environment=DEVBOX_MANAGER_DATA=%s
ExecStart=%s serve -addr %s
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`, workDir, dataDir, systemdQuote(executable), systemdQuote(*addr))
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
		content := fs.String("content", "", "Bun shell script content")
		file := fs.String("file", "", "read recipe content from file")
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
		serverID := fs.Int64("server-id", 0, "optional server id to execute on over SSH")
		maxRuntime := fs.Int("max-runtime", 0, "seconds before this run is killed (0 disables)")
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
		v, e := (devbox.Runner{Store: s}).Run(ctx, *id, sp, *maxRuntime)
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
