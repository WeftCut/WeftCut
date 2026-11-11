package main

// Finding the app and starting it for launch_weftcut. The process attributes
// that detach the child are per OS: launch_unix.go, launch_windows.go.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// bundleID is the app's macOS bundle identifier (electron-builder.yml appId).
const bundleID = "dev.weftcut.desktop"

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
	for _, name := range []string{"WeftCut", "weftcut"} {
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

// launchCommand is the process to start for t.
//
// LANDMINE (macOS): a bundle goes through LaunchServices, never by its
// executable. A recorded executable path is dead once the bundle is moved or
// was run from an App Translocation mount, and an app spawned directly makes
// the spawning program the one macOS attributes its permission requests to.
// `open -a` the bundle while its path exists, `open -b` the bundle id
// otherwise. See ADR 0165.
func launchCommand(h host, t appTarget) (name string, args []string) {
	if h.goos != "darwin" || t.bundle == "" {
		return t.exec, t.args
	}
	if h.isDir(t.bundle) {
		args = []string{"-a", t.bundle}
	} else {
		args = []string{"-b", bundleID}
	}
	if len(t.args) > 0 {
		args = append(append(args, "--args"), t.args...)
	}
	return "/usr/bin/open", args
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

// startDetached starts the app so that it outlives the shim and shares none of
// its stdio: the client owns those pipes and must see them close with the shim.
func startDetached(h host, name string, args []string) error {
	cmd := exec.Command(name, args...)
	cmd.Env = childEnv(os.Environ(), h.goos)
	cmd.SysProcAttr = detached()
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reaped whenever it ends, so a short-lived child (`open`) leaves no zombie.
	go func() { _ = cmd.Wait() }()
	return nil
}
