package main

// Where the app keeps its profile (Electron's userData), the rendezvous file
// it writes there, and the waits the environment configures.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// host is what the binary knows of the machine it runs on. Lookups take it as
// a value so their order can be read, and tested, without a machine.
type host struct {
	goos string
	env  func(string) string
	// exe is the binary's own path with symlinks resolved; empty when unknown.
	exe string
	// isFile reports whether path names an existing file.
	isFile func(path string) bool
	// isDir reports whether path names an existing directory.
	isDir func(path string) bool
}

func processHost() host {
	h := host{goos: runtime.GOOS, env: os.Getenv}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			h.exe = resolved
		}
	}
	h.isFile = func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular()
	}
	h.isDir = func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.IsDir()
	}
	return h
}

func (h host) home() string {
	if home := h.env("HOME"); home != "" {
		return home
	}
	return h.env("USERPROFILE")
}

const authFileName = "mcp_auth.json"

// defaultUserDataDir is the last-resort guess, for a binary run from outside
// any profile. Electron names the directory after package.json's productName
// ("WeftCut"); the scoped name is where profiles written before that key was
// set live. Whichever holds the rendezvous file wins, else the first.
func defaultUserDataDir(h host) string {
	var appData string
	switch h.goos {
	case "windows":
		if appData = h.env("APPDATA"); appData == "" {
			appData = filepath.Join(h.home(), "AppData", "Roaming")
		}
	case "darwin":
		appData = filepath.Join(h.home(), "Library", "Application Support")
	default:
		if appData = h.env("XDG_CONFIG_HOME"); appData == "" {
			appData = filepath.Join(h.home(), ".config")
		}
	}
	candidates := []string{filepath.Join(appData, "WeftCut"), filepath.Join(appData, "@weftcut", "desktop")}
	for _, c := range candidates {
		if h.isFile(filepath.Join(c, authFileName)) {
			return c
		}
	}
	return candidates[0]
}

// resolveUserDataDir finds the profile, in order:
//  1. WEFTCUT_USERDATA (dev, tests, a second profile).
//  2. The binary's own place: the app copies it to <userData>/cli/, so a
//     binary in a `cli` directory whose parent holds the rendezvous file is
//     inside its profile. This is what keeps an AppImage's config valid, whose
//     install image mounts somewhere else every run.
//  3. The platform default.
func resolveUserDataDir(h host) string {
	if override := h.env(userDataEnv); override != "" {
		return override
	}
	if h.exe != "" {
		dir := filepath.Dir(h.exe)
		if strings.EqualFold(filepath.Base(dir), "cli") {
			if profile := filepath.Dir(dir); h.isFile(filepath.Join(profile, authFileName)) {
				return profile
			}
		}
	}
	return defaultUserDataDir(h)
}

// auth is the app's persisted rendezvous: its loopback port and bearer token.
type auth struct {
	Token string
	Port  int
}

func (a auth) endpoint() string {
	return "http://127.0.0.1:" + strconv.Itoa(a.Port) + "/mcp"
}

func parseAuth(data []byte) (auth, bool) {
	var raw struct {
		Token *string         `json:"token"`
		Port  json.RawMessage `json:"port"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.Token == nil || *raw.Token == "" {
		return auth{}, false
	}
	// The literal itself: a port written as a string or a fraction is not one.
	port, err := strconv.Atoi(string(raw.Port))
	if err != nil || port < 1 || port > 65535 {
		return auth{}, false
	}
	return auth{Token: *raw.Token, Port: port}, true
}

// readAuth reads the rendezvous file. Read at every connect and never kept: a
// token rotation or a port re-pick must heal at the next attempt. nil: the app
// has never run in this profile.
func readAuth(userData string) *auth {
	data, err := os.ReadFile(filepath.Join(userData, authFileName))
	if err != nil {
		return nil
	}
	a, ok := parseAuth(data)
	if !ok {
		return nil
	}
	return &a
}

// timeouts are how long the shim waits on the app. An agent's own client
// timeout cannot rescue a call this hop gave up on first, so a tool call,
// which can be minutes of transcription, gets an idle window that every
// progress notification re-arms rather than a flat deadline.
type timeouts struct {
	// toolIdle: silence allowed between a tools/call and its result, or
	// between two progress notifications.
	toolIdle time.Duration
	// toolMaxTotal: a cap whatever progress arrives. Zero: none.
	toolMaxTotal time.Duration
	// request: everything else (lists, reads, prompts), flat.
	request time.Duration
}

var defaultTimeouts = timeouts{toolIdle: 300 * time.Second, request: 60 * time.Second}

// maxWaitMs is the longest wait a config can ask for: what a 32-bit
// millisecond timer holds, about 24 days. A larger number is read as that.
const maxWaitMs = 2_147_483_647

// envMs is a positive whole number of milliseconds, else zero: a typo in the
// environment falls back to the default instead of taking the shim down.
func envMs(raw string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.Trim(raw, "0123456789") != "" {
		return 0
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms > maxWaitMs {
		ms = maxWaitMs
	}
	return time.Duration(ms) * time.Millisecond
}

func configuredTimeouts(h host) timeouts {
	t := defaultTimeouts
	if idle := envMs(h.env(toolTimeoutEnv)); idle > 0 {
		t.toolIdle = idle
	}
	t.toolMaxTotal = envMs(h.env(toolMaxTotalEnv))
	return t
}
