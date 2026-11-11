package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNegotiate(t *testing.T) {
	for _, supported := range supportedProtocols {
		if got := negotiate(supported); got != supported {
			t.Errorf("%s is supported, answered %s", supported, got)
		}
	}
	if supportedProtocols[0] != latestProtocol {
		t.Error("the latest version must head the supported list")
	}
	for _, unknown := range []string{"", "1999-01-01", "2099-01-01"} {
		if got := negotiate(unknown); got != latestProtocol {
			t.Errorf("%q is unknown, answered %s", unknown, got)
		}
	}
}

func TestInstructionsNameTheVersionOnTheirLastLine(t *testing.T) {
	lines := strings.Split(instructions("1.2.3"), "\n")
	last := lines[len(lines)-1]
	if !strings.Contains(last, "is not 1.2.3 is stale") || strings.Contains(strings.Join(lines, "\n"), "{version}") {
		t.Errorf("closing line: %s", last)
	}
	// A later call must not see the first call's closing line.
	if again := strings.Split(instructions("9.9.9"), "\n"); len(again) != len(lines) {
		t.Errorf("%d lines, then %d", len(lines), len(again))
	}
}

func TestInitializeResult(t *testing.T) {
	var result struct {
		ProtocolVersion string
		Capabilities    map[string]map[string]bool
		ServerInfo      serverInfo
		Instructions    string
	}
	if err := json.Unmarshal(initializeResult("2025-06-18"), &result); err != nil {
		t.Fatal(err)
	}
	if result.ProtocolVersion != "2025-06-18" || result.ServerInfo != (serverInfo{serverName, version}) || result.Instructions != instructions(version) {
		t.Errorf("%+v", result)
	}
	for _, list := range []string{"tools", "resources", "prompts"} {
		if !result.Capabilities[list]["listChanged"] {
			t.Errorf("%s must declare listChanged: the catalog follows the app", list)
		}
	}
}

func TestDuration(t *testing.T) {
	cases := map[time.Duration]string{
		300 * time.Second:       "5 min",
		60 * time.Second:        "1 min",
		90 * time.Second:        "90 s",
		45 * time.Second:        "45 s",
		1500 * time.Millisecond: "2 s",
		999 * time.Millisecond:  "999 ms",
		80 * time.Millisecond:   "80 ms",
	}
	for d, want := range cases {
		if got := duration(d); got != want {
			t.Errorf("%v reads %q, want %q", d, got, want)
		}
	}
}

func TestProjectLine(t *testing.T) {
	respond := func(result string) []byte {
		return []byte(`{"jsonrpc":"2.0","id":"weftcut-cli:1","result":` + result + `}`)
	}
	cases := []struct{ what, result, want string }{
		{"the structured view", `{"content":[{"type":"text","text":"ignored"}],"structuredContent":{"project":{"name":"Demo","dir":"/p/Demo"}}}`, "Project: Demo (/p/Demo)"},
		{"the text view when there is no structured one", `{"content":[{"type":"text","text":"{\"project\":{\"name\":\"Demo\",\"dir\":\"/p/Demo\"}}"}]}`, "Project: Demo (/p/Demo)"},
		{"no project open", `{"structuredContent":{"project":null}}`, "Project: none open."},
		{"a view that does not say", `{"structuredContent":{"other":1}}`, ""},
		{"a text that is no view", `{"content":[{"type":"text","text":"called:read_project"}]}`, ""},
		{"an empty result", `{}`, ""},
	}
	for _, c := range cases {
		if got := projectLine(respond(c.result)); !strings.HasPrefix(got, c.want) || (c.want == "") != (got == "") {
			t.Errorf("%s: %q", c.what, got)
		}
	}
	if got := projectLine([]byte(`{"jsonrpc":"2.0","id":"x","error":{"code":-32603,"message":"no"}}`)); got != "" {
		t.Errorf("an error answer: %q", got)
	}
}

func TestStatusNamesTheCLIVersionOnlyWhenItDiffersFromTheApps(t *testing.T) {
	same := statusUpText(serverInfo{"weftcut", version}, "http://127.0.0.1:1/mcp", "")
	if strings.Contains(same, "CLI") {
		t.Errorf("one version, named twice:\n%s", same)
	}
	other := statusUpText(serverInfo{"weftcut", "0.0.1-other"}, "http://127.0.0.1:1/mcp", "Project: Demo (/p/Demo)")
	want := []string{
		"WeftCut is running (weftcut 0.0.1-other).",
		"Endpoint: http://127.0.0.1:1/mcp",
		"This weftcut CLI is version " + version + ", not the running app's 0.0.1-other.",
		"Project: Demo (/p/Demo)",
		"The full tool catalog is available in this session.",
	}
	if other != strings.Join(want, "\n") {
		t.Errorf("\n got %q\nwant %q", other, strings.Join(want, "\n"))
	}
}

func TestDownTextsSayWhatToDo(t *testing.T) {
	never := downState{userData: "/home/u/.config/WeftCut"}
	stopped := downState{userData: never.userData, auth: &auth{Token: "t", Port: 4711}}
	foreign := downState{userData: never.userData, auth: stopped.auth,
		mismatch: &mismatch{endpoint: "http://127.0.0.1:4711/mcp", asked: "2025-11-25", answered: "2024-11-05"}}
	for _, text := range []string{never.errorText(), never.statusText()} {
		if !strings.Contains(text, "never been launched") || !strings.Contains(text, never.userData) {
			t.Errorf("never launched: %s", text)
		}
	}
	for _, text := range []string{stopped.errorText(), stopped.statusText()} {
		if !strings.Contains(text, "WeftCut is not running (nothing answering at http://127.0.0.1:4711/mcp)") || !strings.Contains(text, "launch_weftcut") {
			t.Errorf("stopped: %s", text)
		}
	}
	// A mismatch outranks the file: the app is there, and is not the fix.
	for _, text := range []string{foreign.errorText(), foreign.statusText()} {
		if !strings.Contains(text, "2024-11-05") || !strings.Contains(text, "2025-11-25") || !strings.Contains(text, "open WeftCut once") || strings.Contains(text, "not running") {
			t.Errorf("mismatch: %s", text)
		}
	}
}
