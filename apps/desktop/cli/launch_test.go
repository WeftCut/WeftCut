package main

import (
	"errors"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestParseLaunchRecord(t *testing.T) {
	got, ok := parseLaunchRecord([]byte(`{"exec":"/opt/WeftCut/weftcut","args":["--flag","two words",""],"version":"1.2.3"}`))
	want := appTarget{exec: "/opt/WeftCut/weftcut", args: []string{"--flag", "two words", ""}}
	if !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("record: %+v %v", got, ok)
	}
	got, ok = parseLaunchRecord([]byte(`{"exec":"/Applications/WeftCut.app/Contents/MacOS/WeftCut","args":[],"version":"1.2.3","bundle":"/Applications/WeftCut.app"}`))
	if !ok || got.bundle != "/Applications/WeftCut.app" || len(got.args) != 0 {
		t.Errorf("record with a bundle: %+v %v", got, ok)
	}
	// Anything short of the whole shape starts nothing.
	for _, bad := range []string{
		``, `not json`, `[]`, `{}`,
		`{"args":[],"version":"1"}`,
		`{"exec":"","args":[],"version":"1"}`,
		`{"exec":"/x","version":"1"}`,
		`{"exec":"/x","args":null,"version":"1"}`,
		`{"exec":"/x","args":"--flag","version":"1"}`,
		`{"exec":"/x","args":[1],"version":"1"}`,
		`{"exec":"/x","args":[]}`,
		`{"exec":"/x","args":[],"version":1}`,
		`{"exec":["/x"],"args":[],"version":"1"}`,
		`{"exec":"/x","args":[],"version":"1","bundle":7}`,
	} {
		if got, ok := parseLaunchRecord([]byte(bad)); ok {
			t.Errorf("%s was taken as %+v", bad, got)
		}
	}
}

func TestAppLookupOrder(t *testing.T) {
	userData := filepath.FromSlash("/profiles/one")
	record := filepath.Join(userData, "cli", launchRecordName)
	install := filepath.FromSlash("/opt/WeftCut")
	packaged := filepath.Join(install, "resources", "cli", "weftcut")
	sibling := filepath.Join(install, "WeftCut")
	read := func(files map[string]string) func(string) ([]byte, error) {
		return func(path string) ([]byte, error) {
			if content, ok := files[path]; ok {
				return []byte(content), nil
			}
			return nil, errors.New("no such file")
		}
	}
	recorded := map[string]string{record: `{"exec":"/recorded/app","args":["a"],"version":"1"}`}

	// 1. The override, whatever else is there.
	h := machine("linux", map[string]string{appEnv: "/override/app"}, packaged, []string{sibling}, nil)
	if got, ok := findApp(h, userData, read(recorded)); !ok || got.exec != "/override/app" || len(got.args) != 0 {
		t.Errorf("override: %+v %v", got, ok)
	}
	// 2. The app's own record, ahead of the app the binary is packaged in.
	h = machine("linux", nil, packaged, []string{sibling}, nil)
	if got, ok := findApp(h, userData, read(recorded)); !ok || got.exec != "/recorded/app" || !reflect.DeepEqual(got.args, []string{"a"}) {
		t.Errorf("record: %+v %v", got, ok)
	}
	// 3. The sibling, when the record is missing or not a record.
	for _, files := range []map[string]string{nil, {record: `{"exec":7}`}} {
		if got, ok := findApp(h, userData, read(files)); !ok || got.exec != sibling {
			t.Errorf("sibling with record %v: %+v %v", files, got, ok)
		}
	}
	// None: a binary that is not inside an app.
	h = machine("linux", nil, filepath.Join(userData, "cli", "weftcut"), nil, nil)
	if got, ok := findApp(h, userData, read(nil)); ok {
		t.Errorf("an app was found from nothing: %+v", got)
	}
}

func TestSiblingApp(t *testing.T) {
	install := filepath.FromSlash("/opt/WeftCut")
	// Linux and Windows: the executable one level above `resources`.
	h := machine("linux", nil, filepath.Join(install, "resources", "cli", "weftcut"), []string{filepath.Join(install, "weftcut")}, nil)
	if got, ok := siblingApp(h); !ok || got.exec != filepath.Join(install, "weftcut") || got.bundle != "" {
		t.Errorf("linux: %+v %v", got, ok)
	}
	h = machine("windows", nil, filepath.Join(install, "resources", "cli", "weftcut.exe"), []string{filepath.Join(install, "WeftCut.exe")}, nil)
	if got, ok := siblingApp(h); !ok || got.exec != filepath.Join(install, "WeftCut.exe") {
		t.Errorf("windows: %+v %v", got, ok)
	}
	// macOS: the enclosing bundle, never its executable.
	bundle := filepath.FromSlash("/Applications/WeftCut.app")
	h = machine("darwin", nil, filepath.Join(bundle, "Contents", "Resources", "cli", "weftcut"), nil, []string{bundle})
	if got, ok := siblingApp(h); !ok || got.bundle != bundle {
		t.Errorf("darwin: %+v %v", got, ok)
	}
	// Not an app's resources: no executable there, another directory name, or
	// (macOS) no bundle around it.
	for _, h := range []host{
		machine("linux", nil, filepath.Join(install, "resources", "cli", "weftcut"), nil, nil),
		machine("linux", nil, filepath.Join(install, "resources", "bin", "weftcut"), []string{filepath.Join(install, "weftcut")}, nil),
		machine("linux", nil, filepath.Join(install, "cli", "weftcut"), []string{filepath.Join(install, "weftcut")}, nil),
		machine("darwin", nil, filepath.Join(install, "Resources", "cli", "weftcut"), []string{filepath.Join(install, "WeftCut")}, nil),
		machine("linux", nil, "", nil, nil),
	} {
		if got, ok := siblingApp(h); ok {
			t.Errorf("%s binary at %q found %+v", h.goos, h.exe, got)
		}
	}
}

func TestLaunchCommand(t *testing.T) {
	bundle := "/Applications/WeftCut.app"
	exe := bundle + "/Contents/MacOS/WeftCut"
	cases := []struct {
		what string
		h    host
		t    appTarget
		want launchCmd
	}{
		{"an executable runs as recorded, arguments verbatim",
			machine("linux", nil, "", nil, nil), appTarget{exec: "/opt/WeftCut/weftcut", args: []string{"--a", "b c"}},
			launchCmd{name: "/opt/WeftCut/weftcut", args: []string{"--a", "b c"}}},
		{"a bundle means nothing off macOS",
			machine("windows", nil, "", nil, []string{bundle}), appTarget{exec: `C:\Program Files\WeftCut\WeftCut.exe`, bundle: bundle},
			launchCmd{name: `C:\Program Files\WeftCut\WeftCut.exe`}},
		{"macOS opens the bundle while its path exists",
			machine("darwin", nil, "", nil, []string{bundle}), appTarget{exec: exe, bundle: bundle},
			launchCmd{name: "/usr/bin/open", args: []string{"-a", bundle}, throughOpen: true}},
		{"with its arguments after --args",
			machine("darwin", nil, "", nil, []string{bundle}), appTarget{exec: exe, args: []string{"--a", "b c"}, bundle: bundle},
			launchCmd{name: "/usr/bin/open", args: []string{"-a", bundle, "--args", "--a", "b c"}, throughOpen: true}},
		{"and by bundle id once the path is gone",
			machine("darwin", nil, "", nil, nil), appTarget{exec: exe, args: []string{"--a"}, bundle: bundle},
			launchCmd{name: "/usr/bin/open", args: []string{"-b", product.BundleID, "--args", "--a"}, throughOpen: true, byBundleID: true}},
		{"macOS without a bundle (a dev run) runs the executable",
			machine("darwin", nil, "", nil, nil), appTarget{exec: "/dev/electron", args: []string{"."}},
			launchCmd{name: "/dev/electron", args: []string{"."}}},
	}
	for _, c := range cases {
		if got := launchCommand(c.h, c.t); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %+v, want %+v", c.what, got, c.want)
		}
	}
}

// Starting a path with nothing at it is told apart from any other failure to
// start, by the error this OS gives.
func TestStartingAMissingAppIsRecognised(t *testing.T) {
	gone := filepath.Join(t.TempDir(), "WeftCut")
	if runtime.GOOS == "windows" {
		gone += ".exe"
	}
	err := startDetached(processHost(), launchCmd{name: gone}, nil)
	if err == nil || !nothingAt(err) {
		t.Fatalf("starting %s: %v, want an error that says nothing is there", gone, err)
	}
}

func TestChildEnvDropsRunAsNode(t *testing.T) {
	environ := []string{"PATH=/bin", "ELECTRON_RUN_AS_NODE=1", "Electron_Run_As_Node=1", "ELECTRON_RUN_AS_NODE_X=keep", "EMPTY="}
	got := childEnv(environ, "linux")
	want := []string{"PATH=/bin", "Electron_Run_As_Node=1", "ELECTRON_RUN_AS_NODE_X=keep", "EMPTY="}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unix: %q", got)
	}
	// Windows environment names are case-insensitive.
	got = childEnv(environ, "windows")
	want = []string{"PATH=/bin", "ELECTRON_RUN_AS_NODE_X=keep", "EMPTY="}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("windows: %q", got)
	}
}
