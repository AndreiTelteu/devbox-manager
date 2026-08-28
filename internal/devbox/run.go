// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

package devbox

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Runner struct {
	Store  *Store
	Events *Broker
	// SSHExecutable overrides the ssh binary (tests); empty defaults to "ssh".
	SSHExecutable string
	// NixShellExecutable overrides the nix-shell binary (tests); empty
	// defaults to "nix-shell".
	NixShellExecutable string
}

// Run executes the recipe locally when serverID is nil; otherwise it streams
// the recipe to the selected server over SSH and executes it there. Recipes
// are Bun shell scripts (https://bun.com/docs/runtime/shell) executed inside
// `nix-shell -p bun`, so no bun install is required on either machine. SSH
// authentication uses the service user's normal SSH configuration and agent.
// maxRuntime caps each run in seconds (via coreutils timeout); 0 disables it.
func (r Runner) Run(ctx context.Context, recipeID int64, serverID *int64, maxRuntime int) (Run, error) {
	recipe, err := r.Store.GetRecipe(ctx, recipeID)
	if err != nil {
		return Run{}, err
	}
	var server Server
	if serverID != nil {
		server, err = r.Store.GetServer(ctx, *serverID)
		if err != nil {
			return Run{}, err
		}
	}
	run, err := r.Store.CreateRun(ctx, recipe.ID, serverID)
	if err != nil {
		return run, err
	}
	if r.Events != nil {
		r.Events.PublishRunStarted(run)
	}

	cmd, err := r.command(ctx, serverID, server, recipe.Content, maxRuntime)
	if err != nil {
		return run, err
	}
	if serverID == nil && cmd.Dir != "" {
		defer os.RemoveAll(cmd.Dir)
	}
	output, execErr := r.execute(cmd, run.ID)
	status, exit := "succeeded", 0
	if execErr != nil {
		status = "failed"
		exit = 1
		var e *exec.ExitError
		if errors.As(execErr, &e) {
			exit = e.ExitCode()
		}
		// CombinedOutput is empty when the executable cannot be started. Persist
		// that error too, otherwise the UI/CLI reports an unhelpful blank output.
		if len(output) == 0 {
			output = []byte(execErr.Error())
		}
	}
	if err := r.Store.FinishRun(context.Background(), run.ID, status, exit, string(output)); err != nil {
		return run, err
	}
	final, err := r.Store.GetRun(context.Background(), run.ID)
	if err != nil {
		return run, err
	}
	if r.Events != nil {
		r.Events.PublishRunFinished(final)
	}
	return final, nil
}

// execute runs cmd while streaming the combined output to SSE subscribers,
// throttled so chatty runs do not flood the browser. It returns the complete
// combined output, mirroring cmd.CombinedOutput.
func (r Runner) execute(cmd *exec.Cmd, runID int64) ([]byte, error) {
	if r.Events == nil {
		return cmd.CombinedOutput()
	}
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	var mu sync.Mutex
	var buf bytes.Buffer
	lastPush := time.Now().Add(-outputPushInterval)
	done := make(chan struct{})
	go func() {
		defer close(done)
		reader := bufio.NewReader(pr)
		chunk := make([]byte, 4096)
		for {
			n, readErr := reader.Read(chunk)
			if n > 0 {
				mu.Lock()
				buf.Write(chunk[:n])
				push := time.Since(lastPush) >= outputPushInterval
				if push {
					lastPush = time.Now()
				}
				snapshot := buf.String()
				mu.Unlock()
				if push {
					r.Events.PublishRunOutput(runID, snapshot)
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	waitErr := cmd.Wait()
	pw.Close()
	<-done
	mu.Lock()
	defer mu.Unlock()
	return []byte(buf.String()), waitErr
}

const outputPushInterval = 250 * time.Millisecond

// recipeHelpers is prepended to every recipe, including scripts streamed over
// SSH, so common Bun helpers do not need to be duplicated in recipe files.
//
//go:embed recipe_helpers.ts
var recipeHelpers string

// bunInvocation is the shell snippet passed to `nix-shell --run`: bun (wrapped
// in coreutils timeout when maxRuntime > 0) executing the recipe file.
func bunInvocation(path string, maxRuntime int) string {
	run := `bun "` + path + `"`
	if maxRuntime > 0 {
		run = "timeout " + strconv.Itoa(maxRuntime) + " " + run
	}
	return run
}

func (r Runner) command(ctx context.Context, serverID *int64, server Server, content string, maxRuntime int) (*exec.Cmd, error) {
	content = recipeHelpers + "\n" + serverEnvironment(server.Secrets) + content
	nix := r.NixShellExecutable
	if nix == "" {
		nix = "nix-shell"
	}
	if serverID != nil {
		if strings.HasPrefix(server.Host, "-") || strings.ContainsAny(server.Host, "\r\n") || strings.ContainsAny(server.Username, "@\r\n") {
			return nil, errors.New("server host or username contains unsupported characters")
		}
		ssh := r.SSHExecutable
		if ssh == "" {
			ssh = "ssh"
		}
		// The recipe is piped over stdin into a temp file; flock serializes
		// concurrent runs on that server; output streams back via tail -f. The
		// inner quotes of the --run argument are escaped for the remote shell.
		remoteRun := strings.ReplaceAll(bunInvocation("$recipe", maxRuntime), `"`, `\"`)
		remoteCommand := `recipe=$(mktemp /tmp/devbox-manager.XXXXXX.ts); log=${recipe%.ts}.log; lock=/tmp/devbox-manager-bun.lock; trap 'rm -f "$recipe"' EXIT; cat >"$recipe"; printf '%s\n' "devbox-manager: bun output: $log"; if ! command -v flock >/dev/null 2>&1; then printf '%s\n' 'devbox-manager: flock is required to serialize bun runs on this server' >&2; exit 1; fi; exec 9>"$lock"; if ! flock -n 9; then printf '%s\n' "devbox-manager: another bun run is active on this server; wait for it to finish before retrying" >&2; exit 1; fi; ` + nix + ` -p bun --run "` + remoteRun + `" >"$log" 2>&1 & pid=$!; printf '%s\n' "devbox-manager: bun pid: $pid"; tail -n +1 -f --pid="$pid" "$log" & tailpid=$!; wait "$pid"; status=$?; wait "$tailpid" || true; printf '%s\n' "devbox-manager: bun exited with status $status; log: $log"; exit "$status"`
		// SSH starts the account's login shell for remote commands. Encode the
		// Bash launcher so Fish does not need to parse its POSIX syntax. The
		// process substitution keeps SSH stdin available for the recipe body.
		remoteCommand = encodedBashCommand(remoteCommand)
		cmd := exec.CommandContext(ctx, ssh, "-p", strconv.Itoa(server.Port), "--", server.Username+"@"+server.Host, remoteCommand)
		cmd.Stdin = strings.NewReader(content)
		return cmd, nil
	}
	dir, err := os.MkdirTemp("", "devbox-manager-recipe-")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "recipe.ts")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	cmd := exec.CommandContext(ctx, nix, "-p", "bun", "--run", bunInvocation(path, maxRuntime))
	cmd.Dir = dir
	return cmd, nil
}

func encodedBashCommand(script string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(script))
	return `env DBM_REMOTE_COMMAND=` + encoded + ` bash -c 'exec bash <(printf %s "$DBM_REMOTE_COMMAND" | base64 -d)'`
}

// serverEnvironment makes saved server secrets available to the Bun process
// and its child commands without exposing values in SSH command arguments.
func serverEnvironment(secrets map[string]string) string {
	if len(secrets) == 0 {
		return ""
	}
	b, err := json.Marshal(secrets)
	if err != nil {
		return ""
	}
	return "Object.assign(process.env, " + string(b) + ")\n"
}
