package main

// The side-panel view's entry, answered by the shim itself: a host that
// shows MCP Apps views lists it, opens it and reads its HTML whether or not
// the app is running, so the view can offer to start it. The definition is
// `companion/panel/entry.json`, which the app reads too; the view is the
// generated `companion/panel/panel.html`. See docs/adr/0186.

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"strings"
)

//go:embed companion/panel/entry.json
var panelEntryJSON []byte

//go:embed companion/panel/panel.html
var panelHTML []byte

// panelEntry is the part of entry.json the shim reads.
type panelEntry struct {
	Extension string          `json:"extension"`
	MimeType  string          `json:"mimeType"`
	URI       string          `json:"uri"`
	Tool      json.RawMessage `json:"tool"`
	Result    string          `json:"result"`
	Resource  struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	} `json:"resource"`
}

// panel is the entry with its address filled in, and what the shim answers
// with: the tool definition, the resource listing and the resource read.
var panel = loadPanel()

type panelAnswers struct {
	entry      panelEntry
	toolName   string
	uri        string
	definition json.RawMessage
	listing    json.RawMessage
}

func loadPanel() panelAnswers {
	var e panelEntry
	if err := json.Unmarshal(panelEntryJSON, &e); err != nil {
		panic("companion/panel/entry.json: " + err.Error())
	}
	uri := panelURI(e.URI, panelHTML)
	var named struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(e.Tool, &named); err != nil || named.Name == "" {
		panic("companion/panel/entry.json: the tool has no name")
	}
	var definition bytes.Buffer
	if err := json.Compact(&definition, bytes.ReplaceAll(e.Tool, []byte("{uri}"), []byte(uri))); err != nil {
		panic("companion/panel/entry.json: " + err.Error())
	}
	listing := concat(`{"uri":`, quote(uri), `,"name":`, quote(e.Resource.Name),
		`,"description":`, quote(e.Resource.Description), `,"mimeType":`, quote(e.MimeType), `}`)
	return panelAnswers{entry: e, toolName: named.Name, uri: uri, definition: definition.Bytes(), listing: listing}
}

// panelURI is the view's address: `template` with `{hash}` replaced by the
// first 12 hex digits of the SHA-256 of the view's HTML. A host keeps a view
// by its address, so a new view must have a new one.
// LANDMINE: main/companion/panelEntry.ts computes the same; the parity test in
// src/cli/integration.test.ts holds the two equal.
func panelURI(template string, html []byte) string {
	sum := sha256.Sum256(html)
	return strings.ReplaceAll(template, "{hash}", hex.EncodeToString(sum[:])[:12])
}

// declaresUI reports whether a client's `initialize` capabilities say it
// shows MCP Apps views: the extension, naming the view's MIME type. Only such
// a client is listed the entry and its view, and answered the entry's name.
// LANDMINE: a host that shows views but does not declare this capability is
// never listed the entry, so its panel has nothing to open. The gate and its
// twin declaresMcpAppsUi in main/companion/panelEntry.ts change together; see
// docs/adr/0186, Consequences.
func declaresUI(capabilities json.RawMessage) bool {
	var c struct {
		Extensions map[string]struct {
			MimeTypes []string `json:"mimeTypes"`
		} `json:"extensions"`
	}
	if json.Unmarshal(capabilities, &c) != nil {
		return false
	}
	ui, ok := c.Extensions[panel.entry.Extension]
	if !ok {
		return false
	}
	for _, m := range ui.MimeTypes {
		if m == panel.entry.MimeType {
			return true
		}
	}
	return false
}

// panelCallResult answers the entry tool: the host shows the view, and the
// result is what the view and the chat are told.
func panelCallResult() json.RawMessage {
	return textResult(panel.entry.Result, false)
}

// panelReadResult answers `resources/read` of the view's address.
func panelReadResult() json.RawMessage {
	return concat(`{"contents":[{"uri":`, quote(panel.uri), `,"mimeType":`, quote(panel.entry.MimeType),
		`,"text":`, quote(string(panelHTML)), `}]}`)
}

// uriOf is the `uri` member of an object: what a resources/read names, or
// the address of a listed resource.
func uriOf(params json.RawMessage) string {
	var p struct {
		URI string `json:"uri"`
	}
	if json.Unmarshal(params, &p) != nil {
		return ""
	}
	return p.URI
}

// mergeResources is the app's resources/list result with the view put first
// and the app's own listing of the same address left out, as mergeTools does
// for tools.
func mergeResources(result json.RawMessage, own []json.RawMessage) (json.RawMessage, error) {
	top, err := parseObject(result)
	if err != nil {
		return nil, err
	}
	var listed []json.RawMessage
	if raw, ok := top.get("resources"); ok && present(raw) {
		if listed, err = parseArray(raw); err != nil {
			return nil, err
		}
	}
	ownURIs := map[string]bool{}
	for _, r := range own {
		ownURIs[uriOf(r)] = true
	}
	merged := append([]json.RawMessage{}, own...)
	for _, r := range listed {
		if !ownURIs[uriOf(r)] {
			merged = append(merged, r)
		}
	}
	return top.set("resources", encodeArray(merged)).encode(), nil
}
