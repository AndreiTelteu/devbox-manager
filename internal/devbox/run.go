package devbox

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

type Runner struct {
	Store            *Store
	Executable       string
	Seeds            string
	ConvergedTimeout int
}

// Run executes an MCL recipe locally. Server selection is recorded for audit only:
// this MVP does not establish a remote connection from inventory credentials.
func (r Runner) Run(ctx context.Context, recipeID int64, serverID *int64) (Run, error) {
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
		args = append(args, "--no-server", "--seeds="+r.Seeds)
	}
	if r.ConvergedTimeout > 0 {
		args = append(args, "--converged-timeout", strconv.Itoa(r.ConvergedTimeout))
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
