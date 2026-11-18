package main

// Finding the app and starting it for launch_weftcut. The process attributes
// that detach the child are per OS: launch_unix.go, launch_windows.go.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// appTarget is what starts the app.
type appTarget struct {
	exec string
	args []string
	// bundle is the macOS .app the executable belongs to; empty elsewhere and
	// for a run that is no bundle (dev).
	bundle string
}

// describe names the target in a message.
func (t appTarget) describe() string {
	if t.bundle != "" {
		return t.bundle
	}
	return t.exec
}

const launchRecordName = "launch.json"

// parseLaunchRecord reads <userData>/cli/launch.json, which the app writes at
// every start: how to start this app again. A record that is not exactly
// { exec: string, args: string[], version: string, bundle?: string } is no
// record: a half-written or foreign file must not start anything.
func parseLaunchRecord(data []byte) (appTarget, bool) {
	var raw struct {
		Exec    *string   `json:"exec"`
		Args    *[]string `json:"args"`
		Version *string   `json:"version"`
		Bundle  *string   `json:"bundle"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.Exec == nil || *raw.Exec == "" || raw.Args == nil || raw.Version == nil {
		return appTarget{}, false
	}
	t := appTarget{exec: *raw.Exec, args: *raw.Args}
	if raw.Bundle != nil {
		t.bundle = *raw.Bundle
	}
	return t, true
}

// siblingApp is the app a binary shipped in its `resources/cli/` belongs to:
// on macOS the enclosing .app, elsewhere the executable one level above
// `resources`.
func siblingApp(h host) (appTarget, bool) {
	if h.exe == "" {
		return appTarget{}, false
	}
	cli := filepath.Dir(h.exe)
	resources := filepath.Dir(cli)
	if !strings.EqualFold(filepath.Base(cli), "cli") || !strings.EqualFold(filepath.Base(resources), "resources") {
		return appTarget{}, false
	}
	root := filepath.Dir(resources)
	if h.goos == "darwin" {
		bundle := filepath.Dir(root)
		if filepath.Base(root) != "Contents" || !strings.HasSuffix(bundle, ".app") {
			return appTarget{}, false
		}
		return appTarget{exec: bundle, bundle: bundle}, true
	}
	suffix := ""
	if h.goos == "windows" {
		suffix = ".exe"
	}
	for _, name := range []string{product.ProductName, strings.ToLower(product.ProductName)} {
		if candidate := filepath.Join(root, name+suffix); h.isFile(candidate) {
			return appTarget{exec: candidate}, true
		}
	}
	return appTarget{}, false
}

// findApp is what launch_weftcut starts, in order: WEFTCUT_APP; the app's own
// record in the profile; the app the binary is packaged inside.
func findApp(h host, userData string, readFile func(string) ([]byte, error)) (appTarget, bool) {
	if override := h.env(appEnv); override != "" {
		return appTarget{exec: override}, true
	}
	if data, err := readFile(filepath.Join(userData, "cli", launchRecordName)); err == nil {
		if t, ok := parseLaunchRecord(data); ok {
			return t, true
		}
	}
	return siblingApp(h)
}

// launchCmd is the process that starts the app.
type launchCmd struct {
	name string
	args []string
	// throughOpen: the process is macOS `open`, which hands the bundle to
	// LaunchServices and exits. Its exit status is the only word on whether
	// an app was found: the app itself is not its child.
	throughOpen bool
	// byBundleID: the recorded bundle is gone, so `open` looks the app up by
	// its bundle id.
	byBundleID bool
}

// launchCommand is the process to start for t.
//
// LANDMINE (macOS): a bundle goes through LaunchServices, never by its
// executable. A recorded executable path is dead once the bundle is moved or
// was run from an App Translocation mount, and an app spawned directly makes
// the spawning program the one macOS attributes its permission requests to.
// `open -a` the bundle while its path exists, `open -b` the bundle id
// otherwise. See ADR 0165.
func launchCommand(h host, t appTarget) launchCmd {
	if h.goos != "darwin" || t.bundle == "" {
		return launchCmd{name: t.exec, args: t.args}
	}
	c := launchCmd{name: "/usr/bin/open", throughOpen: true}
	if h.isDir(t.bundle) {
		c.args = []string{"-a", t.bundle}
	} else {
		c.byBundleID = true
		c.args = []string{"-b", product.BundleID}
	}
	if len(t.args) > 0 {
		c.args = append(append(c.args, "--args"), t.args...)
	}
	return c
}

// nothingAt reports whether a start failed because nothing is at the path it
// named: the app was uninstalled, or moved, since its path was recorded.
func nothingAt(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound)
}

// childEnv is the environment the app starts in. Without ELECTRON_RUN_AS_NODE:
// a client that set it for an older config would otherwise bring the app up as
// a Node interpreter with no script.
func childEnv(environ []string, goos string) []string {
	out := make([]string, 0, len(environ))
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		if name == "ELECTRON_RUN_AS_NODE" || (goos == "windows" && strings.EqualFold(name, "ELECTRON_RUN_AS_NODE")) {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// startDetached starts c so that the app outlives the shim and shares none of
// its stdio: the client owns those pipes and must see them close with the
// shim. exited, when given, is called once the process ends, with its error and
// the first line it wrote to stderr; it is given only for `open`, which exits
// at once, never for the app itself.
func startDetached(h host, c launchCmd, exited func(err error, stderr string)) error {
	cmd := exec.Command(c.name, c.args...)
	cmd.Env = childEnv(os.Environ(), h.goos)
	cmd.SysProcAttr = detached()
	var stderr bytes.Buffer
	if exited != nil {
		cmd.Stderr = &stderr
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reaped whenever it ends, so a short-lived child (`open`) leaves no zombie.
	go func() {
		err := cmd.Wait()
		if exited != nil {
			line, _, _ := strings.Cut(strings.TrimSpace(stderr.String()), "\n")
			exited(err, strings.TrimSpace(line))
		}
	}()
	return nil
}
