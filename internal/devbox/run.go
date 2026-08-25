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
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
)

var isolatedMgmtMu sync.Mutex

type Runner struct {
	Store            *Store
	Executable       string
	Seeds            string
	ConvergedTimeout int
}

// Run executes an MCL recipe locally. Server selection is recorded for audit only:
// this MVP does not establish a remote connection from inventory credentials.
// maxRuntime is forwarded to mgmt as --max-runtime in seconds; 0 disables it.
func (r Runner) Run(ctx context.Context, recipeID int64, serverID *int64, maxRuntime int) (Run, error) {
	recipe, err := r.Store.GetRecipe(ctx, recipeID)
	if err != nil {
		return Run{}, err
	}
	if serverID != nil {
		if _, err := r.Store.GetServer(ctx, *serverID); err != nil {
			return Run{}, err
		}
	}
	run, err := r.Store.CreateRun(ctx, recipe.ID, serverID)
	if err != nil {
		return Run{}, err
	}

	dir, err := os.MkdirTemp("", "devbox-manager-mcl-")
	if err != nil {
		return run, err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "recipe.mcl")
	if err := os.WriteFile(path, []byte(recipe.Content), 0o600); err != nil {
		return run, err
	}
	exe := r.Executable
	if exe == "" {
		exe = "mgmt"
	}
	args := []string{"run", "--tmp-prefix", "lang"}
	// The distro service already owns Mgmt's embedded etcd on 127.0.0.1:2379.
	// Join it rather than starting a second embedded server for every recipe.
	if r.Seeds != "" {
		args = append(args, "--seeds="+r.Seeds)
	} else {
		// mgmt 1.1.0 uses fixed localhost etcd ports for an embedded server.
		// Keep isolated runs serial so concurrent API requests cannot collide.
		isolatedMgmtMu.Lock()
		defer isolatedMgmtMu.Unlock()
	}
	if r.ConvergedTimeout > 0 {
		args = append(args, "--converger-timeout", strconv.Itoa(r.ConvergedTimeout), "--converged-exit")
	}
	if maxRuntime > 0 {
		args = append(args, "--max-runtime", strconv.Itoa(maxRuntime))
	}
	args = append(args, path)
	cmd := exec.CommandContext(ctx, exe, args...)
	output, execErr := cmd.CombinedOutput()
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
	return r.Store.GetRun(context.Background(), run.ID)
}
