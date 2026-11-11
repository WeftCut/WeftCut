package main

import (
	"path/filepath"
	"testing"
	"time"
)

// machine is a host made of maps: the environment, and the files and
// directories that exist.
func machine(goos string, env map[string]string, exe string, files, dirs []string) host {
	in := func(list []string) func(string) bool {
		return func(path string) bool {
			for _, known := range list {
				if known == path {
					return true
				}
			}
			return false
		}
	}
	return host{goos: goos, env: func(name string) string { return env[name] }, exe: exe, isFile: in(files), isDir: in(dirs)}
}

func TestUserDataLookupOrder(t *testing.T) {
	home := filepath.FromSlash("/home/u")
	profile := filepath.FromSlash("/profiles/one")
	inProfile := filepath.Join(profile, "cli", "weftcut")
	auth := filepath.Join(profile, authFileName)
	byDefault := filepath.Join(home, ".config", "WeftCut")

	// 1. The override wins over a binary that sits in a profile.
	h := machine("linux", map[string]string{"HOME": home, userDataEnv: "/custom"}, inProfile, []string{auth}, nil)
	if got := resolveUserDataDir(h); got != "/custom" {
		t.Errorf("override: %s", got)
	}
	// 2. A binary in <profile>/cli/ whose profile holds the rendezvous file.
	h = machine("linux", map[string]string{"HOME": home}, inProfile, []string{auth}, nil)
	if got := resolveUserDataDir(h); got != profile {
		t.Errorf("own profile: %s", got)
	}
	// Not in a profile: the directory is not `cli`, or holds no rendezvous file.
	elsewhere := filepath.Join(profile, "bin", "weftcut")
	for _, h := range []host{
		machine("linux", map[string]string{"HOME": home}, elsewhere, []string{auth}, nil),
		machine("linux", map[string]string{"HOME": home}, inProfile, nil, nil),
		machine("linux", map[string]string{"HOME": home}, "", []string{auth}, nil),
	} {
		// 3. The platform default.
		if got := resolveUserDataDir(h); got != byDefault {
			t.Errorf("default for a binary at %q: %s", h.exe, got)
		}
	}
}

func TestDefaultUserDataDirPerPlatform(t *testing.T) {
	home := filepath.FromSlash("/home/u")
	cases := []struct {
		goos string
		env  map[string]string
		want string
	}{
		{"linux", map[string]string{"HOME": home}, filepath.Join(home, ".config", "WeftCut")},
		{"linux", map[string]string{"HOME": home, "XDG_CONFIG_HOME": "/xdg"}, filepath.Join("/xdg", "WeftCut")},
		{"darwin", map[string]string{"HOME": home}, filepath.Join(home, "Library", "Application Support", "WeftCut")},
		{"windows", map[string]string{"USERPROFILE": home}, filepath.Join(home, "AppData", "Roaming", "WeftCut")},
		{"windows", map[string]string{"USERPROFILE": home, "APPDATA": "/roaming"}, filepath.Join("/roaming", "WeftCut")},
	}
	for _, c := range cases {
		if got := defaultUserDataDir(machine(c.goos, c.env, "", nil, nil)); got != c.want {
			t.Errorf("%s %v: %s, want %s", c.goos, c.env, got, c.want)
		}
	}
	// The scoped name wins only where the rendezvous file is.
	scoped := filepath.Join(home, ".config", "@weftcut", "desktop")
	h := machine("linux", map[string]string{"HOME": home}, "", []string{filepath.Join(scoped, authFileName)}, nil)
	if got := defaultUserDataDir(h); got != scoped {
		t.Errorf("profile under the scoped name: %s", got)
	}
}

func TestParseAuth(t *testing.T) {
	a, ok := parseAuth([]byte(`{"token":"abc","port":4711,"extra":true}`))
	if !ok || a.Token != "abc" || a.Port != 4711 {
		t.Fatalf("valid file: %+v %v", a, ok)
	}
	if got := a.endpoint(); got != "http://127.0.0.1:4711/mcp" {
		t.Errorf("endpoint %s", got)
	}
	for _, bad := range []string{``, `not json`, `{"token":"","port":1}`, `{"token":"t"}`, `{"port":1}`,
		`{"token":"t","port":"1"}`, `{"token":"t","port":1.5}`, `{"token":"t","port":0}`, `{"token":"t","port":70000}`, `{"token":7,"port":1}`} {
		if a, ok := parseAuth([]byte(bad)); ok {
			t.Errorf("%s was taken as %+v", bad, a)
		}
	}
}

func TestConfiguredTimeouts(t *testing.T) {
	with := func(idle, total string) timeouts {
		return configuredTimeouts(machine("linux", map[string]string{toolTimeoutEnv: idle, toolMaxTotalEnv: total}, "", nil, nil))
	}
	if got := with("", ""); got != defaultTimeouts {
		t.Errorf("defaults: %+v", got)
	}
	if defaultTimeouts.toolMaxTotal != 0 {
		t.Error("a total cap must be opt-in")
	}
	got := with("900000", " 3600000 ")
	if got.toolIdle != 900*time.Second || got.toolMaxTotal != time.Hour || got.request != defaultTimeouts.request {
		t.Errorf("from the environment: %+v", got)
	}
	// Anything but a positive whole number of milliseconds is a typo, not a setting.
	for _, bad := range []string{"0", "-5", "1.5", "10s", "abc", "1e6", "+7"} {
		if got := with(bad, bad); got != defaultTimeouts {
			t.Errorf("%q changed the waits: %+v", bad, got)
		}
	}
	// Too large to be a wait is the longest wait, not an instant one.
	for _, huge := range []string{"99999999999", "99999999999999999999999999"} {
		if got := with(huge, ""); got.toolIdle != maxWaitMs*time.Millisecond {
			t.Errorf("%s: %v", huge, got.toolIdle)
		}
	}
}
