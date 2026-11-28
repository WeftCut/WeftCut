package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"regexp"
	"testing"
	"time"
)

const uiCapabilities = `{"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}`

// panelServer is a shim whose client initialized with capabilities, the app
// away. What it writes collects in out.
func panelServer(t *testing.T, capabilities string) (*server, *bytes.Buffer) {
	t.Helper()
	out := &bytes.Buffer{}
	s := &server{userData: t.TempDir(), events: make(chan any, 8), out: newOutbox(out, func() {})}
	s.resetTables()
	s.initialize(&request{rawID: json.RawMessage(`0`), method: methodInitialize,
		params: json.RawMessage(`{"protocolVersion":"2025-11-25","capabilities":` + capabilities + `}`)})
	return s, out
}

// written is every message the shim wrote, by id; the initialize answer left out.
func written(t *testing.T, s *server, out *bytes.Buffer) map[string]json.RawMessage {
	t.Helper()
	s.out.drainWithin(time.Second)
	byID := map[string]json.RawMessage{}
	for _, line := range bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n")) {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(line, &m) == nil && string(m.ID) != "0" {
			byID[string(m.ID)] = m.Result
		}
	}
	return byID
}

func ask(s *server, id, method, params string) {
	s.clientRequest(&request{rawID: json.RawMessage(id), key: idKey(json.RawMessage(id)), method: method, params: json.RawMessage(params)})
}

func names(t *testing.T, result json.RawMessage, list, field string) []string {
	t.Helper()
	var r map[string][]map[string]any
	if err := json.Unmarshal(result, &r); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, item := range r[list] {
		out = append(out, item[field].(string))
	}
	return out
}

func TestTheViewsAddressIsAHashOfItsHTML(t *testing.T) {
	html, err := os.ReadFile("companion/panel/panel.html")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(html)
	if want := "ui://weftcut/side-preview-" + hex.EncodeToString(sum[:])[:12] + ".html"; panel.uri != want {
		t.Errorf("address %s, the HTML hashes to %s", panel.uri, want)
	}
	if panelURI(panel.entry.URI, append(html, ' ')) == panel.uri {
		t.Error("a changed view kept its address: a host would go on showing the old one")
	}
}

func TestTheEntryNamesTheViewAndIsHiddenFromTheModel(t *testing.T) {
	var def struct {
		Name string `json:"name"`
		Meta struct {
			UI struct {
				ResourceURI string   `json:"resourceUri"`
				Visibility  []string `json:"visibility"`
			} `json:"ui"`
			OpenAI struct {
				Entrypoints []struct {
					Type string `json:"type"`
				} `json:"entrypoints"`
			} `json:"openai/ui"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(panel.definition, &def); err != nil {
		t.Fatal(err)
	}
	if def.Name != panel.toolName || def.Meta.UI.ResourceURI != panel.uri {
		t.Errorf("%+v", def)
	}
	if len(def.Meta.UI.Visibility) != 1 || def.Meta.UI.Visibility[0] != "app" {
		t.Errorf("visibility %v: the model must not see the entry", def.Meta.UI.Visibility)
	}
	if len(def.Meta.OpenAI.Entrypoints) != 1 || def.Meta.OpenAI.Entrypoints[0].Type != "thread" {
		t.Errorf("entrypoints %+v", def.Meta.OpenAI.Entrypoints)
	}
	if bytes.ContainsAny(panel.definition, "\n") || regexp.MustCompile(`\{(uri|hash)\}`).Match(panel.definition) {
		t.Errorf("definition not filled in or not one line: %s", panel.definition)
	}
}

func TestDeclaresUIReadsTheExtensionAndItsMimeType(t *testing.T) {
	cases := map[string]bool{
		uiCapabilities: true,
		`{}`:           false,
		`{"extensions":{"io.modelcontextprotocol/ui":{}}}`:                                            false,
		`{"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html"]}}}`:                   false,
		`{"extensions":{"other/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}`:                     false,
		`{"experimental":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}`: false,
		`not json`: false,
	}
	for caps, want := range cases {
		if got := declaresUI(json.RawMessage(caps)); got != want {
			t.Errorf("%s: %v", caps, got)
		}
	}
}

func TestTheEntryAndTheViewAreListedOnlyToAClientThatShowsViews(t *testing.T) {
	for _, shows := range []bool{false, true} {
		caps := `{}`
		if shows {
			caps = uiCapabilities
		}
		s, out := panelServer(t, caps)
		// The app is away: the shim's own answers are all there is.
		s.write(s.downAnswer(json.RawMessage(`1`), methodToolsList, true, false))
		s.write(s.downAnswer(json.RawMessage(`2`), methodResourcesList, true, false))
		got := written(t, s, out)
		tools, resources := names(t, got["1"], "tools", "name"), names(t, got["2"], "resources", "uri")
		listed := contains(tools, panel.toolName)
		if listed != shows || contains(resources, panel.uri) != shows {
			t.Errorf("shows views %v: tools %v, resources %v", shows, tools, resources)
		}
	}
}

func TestTheShimAnswersTheEntryAndTheViewWithTheAppClosed(t *testing.T) {
	s, out := panelServer(t, uiCapabilities)
	ask(s, `1`, methodToolsCall, `{"name":"`+panel.toolName+`","arguments":{}}`)
	ask(s, `2`, methodResourcesRead, `{"uri":"`+panel.uri+`"}`)
	got := written(t, s, out)
	if !bytes.Contains(got["1"], []byte(panel.entry.Result)) {
		t.Errorf("entry call: %s", got["1"])
	}
	var read struct {
		Contents []struct {
			URI, MimeType, Text string
		}
	}
	if err := json.Unmarshal(got["2"], &read); err != nil || len(read.Contents) != 1 {
		t.Fatalf("read: %s", got["2"])
	}
	c := read.Contents[0]
	if c.URI != panel.uri || c.MimeType != "text/html;profile=mcp-app" || c.Text != string(panelHTML) {
		t.Errorf("read answered %s %s and %d bytes", c.URI, c.MimeType, len(c.Text))
	}
	if len(s.waiters) != 0 || s.connecting {
		t.Error("the entry and the view waited on the app")
	}
}

func TestTheAppsCopiesOfTheEntryAndTheViewAreDropped(t *testing.T) {
	s, out := panelServer(t, uiCapabilities)
	for id, method := range map[string]string{`1`: methodToolsList, `2`: methodResourcesList} {
		s.pending[idKey(json.RawMessage(id))] = &pending{rawID: json.RawMessage(id), method: method, firstPage: true}
	}
	appTools := `{"tools":[` + string(panel.definition) + `,{"name":"add_marker"}]}`
	appResources := `{"resources":[` + string(panel.listing) + `,{"uri":"project://settings","name":"settings"}]}`
	for id, result := range map[string]string{`1`: appTools, `2`: appResources} {
		message := resultMessage(json.RawMessage(id), json.RawMessage(result))
		e, _ := parseEnvelope(message)
		s.answered(idKey(e.ID), e, message)
	}
	got := written(t, s, out)
	tools := names(t, got["1"], "tools", "name")
	if want := []string{toolStatus, toolLaunch, panel.toolName, "add_marker"}; !equal(tools, want) {
		t.Errorf("tools %v, want %v", tools, want)
	}
	if resources := names(t, got["2"], "resources", "uri"); !equal(resources, []string{panel.uri, "project://settings"}) {
		t.Errorf("resources %v", resources)
	}
}

func contains(list []string, item string) bool {
	for _, x := range list {
		if x == item {
			return true
		}
	}
	return false
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
