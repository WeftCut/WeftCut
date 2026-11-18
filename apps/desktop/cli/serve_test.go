package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAnIDTheAppStillOwesAnAnswerToIsInUse(t *testing.T) {
	s := &server{}
	s.resetTables()
	key := idKey(json.RawMessage(`7`))
	if s.inUse(key) {
		t.Fatal("a fresh id is in use")
	}
	// A tool call the shim answered at its timeout while the app works on.
	s.orphans[key] = idKey(quote(ownIDPrefix + "progress:1"))
	if !s.inUse(key) {
		t.Error("the id of a call the app may still answer was free to reuse")
	}
	// The app's late answer ends the orphan, and with it the claim on the id.
	s.answered(key, envelope{}, nil)
	if s.inUse(key) {
		t.Error("the id stayed in use after the app's late answer was dropped")
	}
}

// launchFixture is a server whose profile records target, with starts handed
// to start, and launch_weftcut called once as id 1.
type launchFixture struct {
	s   *server
	out *bytes.Buffer
}

func newLaunchFixture(t *testing.T, h host, target appTarget, start func(launchCmd, func(error, string)) error) launchFixture {
	t.Helper()
	userData := t.TempDir()
	record := map[string]any{"exec": target.exec, "args": []string{}, "version": "0.0.0"}
	if target.bundle != "" {
		record["bundle"] = target.bundle
	}
	data, _ := json.Marshal(record)
	if err := os.MkdirAll(filepath.Join(userData, "cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userData, "cli", launchRecordName), data, 0o644); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	s := &server{host: h, userData: userData, start: start, events: make(chan any, 8), out: newOutbox(out, func() {})}
	s.resetTables()
	key := idKey(json.RawMessage(`1`))
	s.local[key] = json.RawMessage(`1`)
	s.launch(key)
	return launchFixture{s, out}
}

// answer is what the client was sent for launch_weftcut; ok is false when
// nothing was.
func (f launchFixture) answer(t *testing.T) (text string, isError bool, ok bool) {
	t.Helper()
	f.s.out.drainWithin(time.Second)
	for _, line := range bytes.Split(bytes.TrimSpace(f.out.Bytes()), []byte("\n")) {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if json.Unmarshal(line, &m) == nil && string(m.ID) == "1" && len(m.Result.Content) > 0 {
			return m.Result.Content[0].Text, m.Result.IsError, true
		}
	}
	return "", false, false
}

// openExit is a start that takes `open` and keeps the callback for its exit.
func openExit(exited *func(error, string)) func(launchCmd, func(error, string)) error {
	return func(_ launchCmd, cb func(error, string)) error {
		*exited = cb
		return nil
	}
}

func TestLaunchOfAMissingAppSaysItIsNotInstalled(t *testing.T) {
	bundle := "/Applications/WeftCut.app"

	t.Run("macOS: open -b found no app", func(t *testing.T) {
		var exited func(error, string)
		f := newLaunchFixture(t, machine("darwin", nil, "", nil, nil), appTarget{exec: bundle + "/Contents/MacOS/WeftCut", bundle: bundle}, openExit(&exited))
		exited(errors.New("exit status 1"), "LSCopyApplicationURLsForBundleIdentifier() failed")
		f.s.handle(<-f.s.events)
		if text, isError, _ := f.answer(t); text != appMissingText(bundle) || !isError {
			t.Errorf("answered %q (isError %v), want %q", text, isError, appMissingText(bundle))
		}
	})

	t.Run("elsewhere: nothing at the recorded path", func(t *testing.T) {
		gone := "/opt/WeftCut/weftcut"
		f := newLaunchFixture(t, machine("linux", nil, "", nil, nil), appTarget{exec: gone}, func(launchCmd, func(error, string)) error {
			return &fs.PathError{Op: "fork/exec", Path: gone, Err: fs.ErrNotExist}
		})
		if text, isError, _ := f.answer(t); text != appMissingText(gone) || !isError {
			t.Errorf("answered %q (isError %v), want %q", text, isError, appMissingText(gone))
		}
	})
}

func TestLaunchThatFailsForAnotherReasonSaysWhy(t *testing.T) {
	bundle := "/Applications/WeftCut.app"

	t.Run("macOS: open -a on a bundle that is there", func(t *testing.T) {
		var exited func(error, string)
		f := newLaunchFixture(t, machine("darwin", nil, "", nil, []string{bundle}), appTarget{exec: bundle + "/Contents/MacOS/WeftCut", bundle: bundle}, openExit(&exited))
		exited(errors.New("exit status 1"), "The application cannot be opened")
		f.s.handle(<-f.s.events)
		want := launchFailedText(bundle, errors.New("The application cannot be opened"))
		if text, isError, _ := f.answer(t); text != want || !isError {
			t.Errorf("answered %q (isError %v), want %q", text, isError, want)
		}
	})

	t.Run("elsewhere: a start refused", func(t *testing.T) {
		exe := "/opt/WeftCut/weftcut"
		refused := &fs.PathError{Op: "fork/exec", Path: exe, Err: fs.ErrPermission}
		f := newLaunchFixture(t, machine("linux", nil, "", nil, nil), appTarget{exec: exe}, func(launchCmd, func(error, string)) error { return refused })
		if text, _, _ := f.answer(t); text != launchFailedText(exe, refused) {
			t.Errorf("answered %q, want %q", text, launchFailedText(exe, refused))
		}
	})
}

// `open` exiting cleanly means LaunchServices took the bundle: the endpoint is
// still to come. A failure reported for an earlier launch is not this one's.
func TestLaunchWaitOutlivesACleanOpenAndAnEarlierLaunchsExit(t *testing.T) {
	bundle := "/Applications/WeftCut.app"
	var exited func(error, string)
	f := newLaunchFixture(t, machine("darwin", nil, "", nil, nil), appTarget{exec: bundle + "/Contents/MacOS/WeftCut", bundle: bundle}, openExit(&exited))
	exited(nil, "")
	f.s.handle(<-f.s.events)
	f.s.handle(evOpenExited{seq: f.s.launching.seq - 1, err: errors.New("exit status 1")})
	if f.s.launching == nil {
		t.Fatal("the launch wait ended")
	}
	if text, _, ok := f.answer(t); ok {
		t.Errorf("answered %q while the app may still come up", text)
	}
}
