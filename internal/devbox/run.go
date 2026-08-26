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

package devbox

import (
	"bufio"
	"bytes"
	"context"
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

var isolatedMgmtMu sync.Mutex

type Runner struct {
	Store            *Store
	Events           *Broker
	Executable       string
	SSHExecutable    string
	Seeds            string
	ConvergedTimeout int
}

// Run executes locally when serverID is nil, otherwise it streams the recipe to
// the selected server over SSH and executes mgmt there. SSH authentication uses
// the service user's normal SSH configuration and agent.
// maxRuntime is forwarded to mgmt as --max-runtime in seconds; 0 disables it.
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
		return Run{}, err
	}
	if r.Events != nil {
		r.Events.PublishRunStarted(run)
	}

	cmd, err := r.command(ctx, serverID, server, recipe.Content, maxRuntime)
	if err != nil {
		return run, err
	}
	if serverID == nil && r.Seeds == "" {
		isolatedMgmtMu.Lock()
		defer isolatedMgmtMu.Unlock()
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

func (r Runner) command(ctx context.Context, serverID *int64, server Server, content string, maxRuntime int) (*exec.Cmd, error) {
	args := []string{"run", "--tmp-prefix", "lang"}
	if serverID == nil && r.Seeds != "" {
		args = append(args, "--seeds="+r.Seeds)
	}
	if serverID == nil && r.ConvergedTimeout > 0 {
		args = append(args, "--converger-timeout", strconv.Itoa(r.ConvergedTimeout), "--converged-exit")
	}
	if serverID == nil && maxRuntime > 0 {
		args = append(args, "--max-runtime", strconv.Itoa(maxRuntime))
	}
	if serverID != nil {
		if strings.HasPrefix(server.Host, "-") || strings.ContainsAny(server.Host, "\r\n") || strings.ContainsAny(server.Username, "@\r\n") {
			return nil, errors.New("server host or username contains unsupported characters")
		}
		ssh := r.SSHExecutable
		if ssh == "" {
			ssh = "ssh"
		}
		remoteArgs := "run --tmp-prefix --no-watch --no-stream-watch --no-deploy-watch"
		if r.ConvergedTimeout > 0 {
			remoteArgs += " --converged-timeout " + strconv.Itoa(r.ConvergedTimeout)
		}
		if maxRuntime > 0 {
			remoteArgs += " --max-runtime " + strconv.Itoa(maxRuntime)
		}
		remoteCommand := "recipe=$(mktemp /tmp/devbox-manager.XXXXXX.mcl); log=${recipe%.mcl}.log; lock=/tmp/devbox-manager-mgmt.lock; trap 'rm -f \"$recipe\"' EXIT; cat >\"$recipe\"; printf '%s\\n' \"devbox-manager: mgmt output: $log\"; if ! command -v flock >/dev/null 2>&1; then printf '%s\\n' 'devbox-manager: flock is required to serialize mgmt runs on this server' >&2; exit 1; fi; exec 9>\"$lock\"; if ! flock -n 9; then printf '%s\\n' \"devbox-manager: another mgmt run is active on this server; wait for it to finish before retrying\" >&2; exit 1; fi; mgmt " + remoteArgs + " lang \"$recipe\" >\"$log\" 2>&1 & pid=$!; printf '%s\\n' \"devbox-manager: mgmt pid: $pid\"; tail -n +1 -f --pid=\"$pid\" \"$log\" & tailpid=$!; wait \"$pid\"; status=$?; wait \"$tailpid\" || true; printf '%s\\n' \"devbox-manager: mgmt exited with status $status; log: $log\"; exit \"$status\""
		cmd := exec.CommandContext(ctx, ssh, "-p", strconv.Itoa(server.Port), "--", server.Username+"@"+server.Host, remoteCommand)
		cmd.Stdin = strings.NewReader(content)
		return cmd, nil
	}
	dir, err := os.MkdirTemp("", "devbox-manager-mcl-")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "recipe.mcl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	args = append(args, path)
	exe := r.Executable
	if exe == "" {
		exe = "mgmt"
	}
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Dir = dir
	return cmd, nil
}
