package main

// JSON-RPC as the shim reads it: the envelope of a message, and the two edits
// it makes to a body (the tools/list merge, the progress token of a tool
// call). Everything else of a message stays the bytes it arrived as.

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// JSON-RPC error codes the shim answers with. requestTimeout is the MCP SDK's.
const (
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInternalError  = -32603
	codeRequestTimeout = -32001
)

// envelope is what the shim reads of a message. A body is never decoded
// further than deciding where the message goes.
type envelope struct {
	ID     json.RawMessage `json:"id"`
	Method *string         `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func parseEnvelope(message []byte) (envelope, error) {
	var e envelope
	err := json.Unmarshal(message, &e)
	return e, err
}

func present(raw json.RawMessage) bool {
	return len(raw) > 0 && !bytes.Equal(raw, []byte("null"))
}

func (e envelope) isRequest() bool      { return e.Method != nil && present(e.ID) }
func (e envelope) isNotification() bool { return e.Method != nil && !present(e.ID) }
func (e envelope) isResponse() bool     { return e.Method == nil && present(e.ID) }

// idKey is one spelling per id (or progress token), so the id a client sent
// and the one the app echoes meet in a table whatever escapes or number form
// each side wrote: "s:" + the string, "n:" + the number. Empty: not an id.
func idKey(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return "s:" + s
	}
	text := string(raw)
	if _, err := strconv.ParseInt(text, 10, 64); err == nil {
		return "n:" + text
	}
	f, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return ""
	}
	// 1.0 and 1e0 are the id 1: a peer that reads numbers echoes them so.
	if f == float64(int64(f)) {
		return "n:" + strconv.FormatInt(int64(f), 10)
	}
	return "n:" + strconv.FormatFloat(f, 'g', -1, 64)
}

// quote is s as a JSON string. Not json.Marshal: that escapes <, > and & as
// \u00XX, which a client would read back correctly but no peer writes.
func quote(s string) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // a string always encodes
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func resultMessage(id, result json.RawMessage) []byte {
	return concat(`{"jsonrpc":"2.0","id":`, id, `,"result":`, result, `}`)
}

func errorMessage(id json.RawMessage, code int, message string) []byte {
	return concat(`{"jsonrpc":"2.0","id":`, id, `,"error":{"code":`, strconv.Itoa(code), `,"message":`, quote(message), `}}`)
}

func requestMessage(id json.RawMessage, method string, params json.RawMessage) []byte {
	if params == nil {
		return concat(`{"jsonrpc":"2.0","id":`, id, `,"method":`, quote(method), `}`)
	}
	return concat(`{"jsonrpc":"2.0","id":`, id, `,"method":`, quote(method), `,"params":`, params, `}`)
}

func notificationMessage(method string, params json.RawMessage) []byte {
	if params == nil {
		return concat(`{"jsonrpc":"2.0","method":`, quote(method), `}`)
	}
	return concat(`{"jsonrpc":"2.0","method":`, quote(method), `,"params":`, params, `}`)
}

// textResult is a tool result of one text block.
func textResult(text string, isError bool) json.RawMessage {
	if isError {
		return concat(`{"content":[{"type":"text","text":`, quote(text), `}],"isError":true}`)
	}
	return concat(`{"content":[{"type":"text","text":`, quote(text), `}]}`)
}

// concat joins strings and byte slices (json.RawMessage included).
func concat(parts ...any) []byte {
	var out []byte
	for _, part := range parts {
		switch p := part.(type) {
		case string:
			out = append(out, p...)
		case []byte:
			out = append(out, p...)
		case json.RawMessage:
			out = append(out, p...)
		}
	}
	return out
}

// oneLine makes a message safe for the newline-delimited stdio framing. A raw
// line break inside valid JSON is always whitespace between tokens (a string
// carries its own as \n), so a space in its place changes nothing.
func oneLine(message []byte) []byte {
	if !bytes.ContainsAny(message, "\r\n") {
		return message
	}
	out := bytes.ReplaceAll(message, []byte("\r"), []byte(" "))
	return bytes.ReplaceAll(out, []byte("\n"), []byte(" "))
}

// member is one key of a JSON object with its value's bytes as written.
type member struct {
	key   string
	value json.RawMessage
}

// object is a JSON object opened one level: its members in order, each value
// untouched. Editing one member and encoding again leaves every other value
// byte for byte what it was (no number is re-read, no string re-escaped).
type object []member

var errNotObject = errors.New("not a JSON object")

func parseObject(raw json.RawMessage) (object, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if open, err := dec.Token(); err != nil || open != json.Delim('{') {
		return nil, errNotObject
	}
	var out object
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok {
			return nil, errNotObject
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, member{name, value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return out, nil
}

func parseArray(raw json.RawMessage) ([]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if open, err := dec.Token(); err != nil || open != json.Delim('[') {
		return nil, errors.New("not a JSON array")
	}
	var out []json.RawMessage
	for dec.More() {
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return out, nil
}

func (o object) get(key string) (json.RawMessage, bool) {
	for _, m := range o {
		if m.key == key {
			return m.value, true
		}
	}
	return nil, false
}

// set replaces the member in place, or appends it.
func (o object) set(key string, value json.RawMessage) object {
	for i := range o {
		if o[i].key == key {
			o[i].value = value
			return o
		}
	}
	return append(o, member{key, value})
}

func (o object) encode() json.RawMessage {
	out := []byte{'{'}
	for i, m := range o {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, quote(m.key)...)
		out = append(out, ':')
		out = append(out, m.value...)
	}
	return append(out, '}')
}

func encodeArray(items []json.RawMessage) json.RawMessage {
	out := []byte{'['}
	for i, item := range items {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, item...)
	}
	return append(out, ']')
}

// callParams is what the shim reads of a tools/call: which tool, and the
// progress token the client attached (nil: none).
func callParams(params json.RawMessage) (name string, token json.RawMessage) {
	var p struct {
		Name *string `json:"name"`
		Meta *struct {
			ProgressToken json.RawMessage `json:"progressToken"`
		} `json:"_meta"`
	}
	if json.Unmarshal(params, &p) != nil {
		return "", nil
	}
	if p.Name != nil {
		name = *p.Name
	}
	if p.Meta != nil && present(p.Meta.ProgressToken) {
		token = p.Meta.ProgressToken
	}
	return name, token
}

// withProgressToken is params with `_meta.progressToken` set to token: the
// one member changed, the arguments left as they were sent.
func withProgressToken(params json.RawMessage, token string) (json.RawMessage, bool) {
	top, err := parseObject(params)
	if err != nil {
		return nil, false
	}
	var meta object
	if raw, ok := top.get("_meta"); ok && present(raw) {
		if meta, err = parseObject(raw); err != nil {
			return nil, false
		}
	}
	meta = meta.set("progressToken", quote(token))
	return top.set("_meta", meta.encode()).encode(), true
}

// progressToken is the token a notifications/progress names, as an idKey.
func progressToken(params json.RawMessage) string {
	var p struct {
		ProgressToken json.RawMessage `json:"progressToken"`
	}
	if json.Unmarshal(params, &p) != nil {
		return ""
	}
	return idKey(p.ProgressToken)
}

// cancelledID is the request a notifications/cancelled names, as an idKey.
func cancelledID(params json.RawMessage) string {
	var p struct {
		RequestID json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return ""
	}
	return idKey(p.RequestID)
}

// hasCursor says a list request continues an earlier page.
func hasCursor(params json.RawMessage) bool {
	var p struct {
		Cursor *string `json:"cursor"`
	}
	return json.Unmarshal(params, &p) == nil && p.Cursor != nil && *p.Cursor != ""
}

// mergeTools is the app's tools/list result with the shim's own tools put
// first and any app tool of the same name left out. Every other member of the
// result (nextCursor, _meta) and every tool definition keeps its bytes.
func mergeTools(result json.RawMessage, own []syntheticTool) (json.RawMessage, error) {
	top, err := parseObject(result)
	if err != nil {
		return nil, err
	}
	var listed []json.RawMessage
	if raw, ok := top.get("tools"); ok && present(raw) {
		if listed, err = parseArray(raw); err != nil {
			return nil, err
		}
	}
	merged := make([]json.RawMessage, 0, len(own)+len(listed))
	for _, tool := range own {
		merged = append(merged, tool.definition)
	}
	for _, tool := range listed {
		var named struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(tool, &named)
		if !isSynthetic(own, named.Name) {
			merged = append(merged, tool)
		}
	}
	return top.set("tools", encodeArray(merged)).encode(), nil
}

func isSynthetic(own []syntheticTool, name string) bool {
	for _, tool := range own {
		if tool.name == name {
			return true
		}
	}
	return false
}

// firstLine is what list-tools prints of a description.
func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}
