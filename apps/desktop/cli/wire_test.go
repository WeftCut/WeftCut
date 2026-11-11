package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEnvelopeTellsRequestNotificationAndResponseApart(t *testing.T) {
	cases := []struct {
		message                         string
		request, notification, response bool
	}{
		{`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, true, false, false},
		{`{"jsonrpc":"2.0","id":"a","method":"ping","params":{}}`, true, false, false},
		{`{"jsonrpc":"2.0","method":"notifications/initialized"}`, false, true, false},
		// A null id is no id: the message asks for no answer.
		{`{"jsonrpc":"2.0","id":null,"method":"notifications/progress"}`, false, true, false},
		{`{"jsonrpc":"2.0","id":0,"result":{}}`, false, false, true},
		{`{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"x"}}`, false, false, true},
	}
	for _, c := range cases {
		e, err := parseEnvelope([]byte(c.message))
		if err != nil {
			t.Fatalf("%s: %v", c.message, err)
		}
		if e.isRequest() != c.request || e.isNotification() != c.notification || e.isResponse() != c.response {
			t.Errorf("%s: request=%v notification=%v response=%v", c.message, e.isRequest(), e.isNotification(), e.isResponse())
		}
	}
}

func TestEnvelopeKeepsBodiesAsWritten(t *testing.T) {
	params := `{"big":12345678901234567890,"exp":1e+21,"frac":1.0,"html":"<b>&</b>","esc":"\u00e9\ud83d\ude00"}`
	e, err := parseEnvelope([]byte(`{"jsonrpc":"2.0","id":1,"method":"m","params":` + params + `}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(e.Params) != params {
		t.Errorf("params were rewritten:\n got %s\nwant %s", e.Params, params)
	}
}

func TestIDKeyIsOneSpellingPerID(t *testing.T) {
	same := [][]string{
		{`1`, ` 1 `, `1.0`, `1e0`},
		{`"a"`, `"\u0061"`},
		{`"weftcut-cli:3"`},
	}
	seen := map[string]string{}
	for _, group := range same {
		key := idKey(json.RawMessage(group[0]))
		if key == "" {
			t.Fatalf("%s has no key", group[0])
		}
		for _, spelling := range group[1:] {
			if got := idKey(json.RawMessage(spelling)); got != key {
				t.Errorf("%s and %s are one id, keyed %q and %q", group[0], spelling, key, got)
			}
		}
		if other, clash := seen[key]; clash {
			t.Errorf("%s and %s are different ids with one key %q", group[0], other, key)
		}
		seen[key] = group[0]
	}
	// The number 1 and the string "1" are different ids.
	if idKey(json.RawMessage(`1`)) == idKey(json.RawMessage(`"1"`)) {
		t.Error(`1 and "1" share a key`)
	}
	for _, none := range []string{``, `null x`, `{}`, `"unterminated`} {
		if key := idKey(json.RawMessage(none)); key != "" {
			t.Errorf("%q is not an id, keyed %q", none, key)
		}
	}
}

func TestBuiltMessagesAreValidAndUnescaped(t *testing.T) {
	text := "a <tag> & \"quotes\"\nnew line — dash"
	for _, message := range [][]byte{
		resultMessage(json.RawMessage(`7`), textResult(text, true)),
		errorMessage(json.RawMessage(`"id"`), codeInternalError, text),
		requestMessage(json.RawMessage(`1`), "tools/call", json.RawMessage(`{"name":"x"}`)),
		requestMessage(json.RawMessage(`1`), "ping", nil),
		notificationMessage("notifications/tools/list_changed", nil),
	} {
		if !json.Valid(message) {
			t.Errorf("not JSON: %s", message)
		}
		if strings.ContainsAny(string(message), "\r\n") {
			t.Errorf("holds a line break, which would split it on stdio: %q", message)
		}
		if strings.Contains(string(message), `\u003c`) || strings.Contains(string(message), `\u0026`) {
			t.Errorf("HTML characters were escaped: %s", message)
		}
	}
	var decoded struct {
		Error struct {
			Code    int
			Message string
		}
	}
	if err := json.Unmarshal(errorMessage(json.RawMessage(`1`), codeRequestTimeout, text), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Error.Code != codeRequestTimeout || decoded.Error.Message != text {
		t.Errorf("error did not survive: %+v", decoded.Error)
	}
}

func TestOneLineOnlyTouchesLineBreaks(t *testing.T) {
	pretty := "{\r\n  \"a\": \"line\\nbreak\",\n  \"b\": 1\n}"
	got := oneLine([]byte(pretty))
	if strings.ContainsAny(string(got), "\r\n") {
		t.Fatalf("still multi-line: %q", got)
	}
	var before, after map[string]any
	if json.Unmarshal([]byte(pretty), &before) != nil || json.Unmarshal(got, &after) != nil {
		t.Fatal("not JSON on one side")
	}
	if before["a"] != after["a"] || before["b"] != after["b"] {
		t.Errorf("content changed: %v → %v", before, after)
	}
	compact := []byte(`{"a":1}`)
	if &oneLine(compact)[0] != &compact[0] {
		t.Error("a message already on one line was copied")
	}
}

func TestCallParamsReadsTheToolAndTheClientToken(t *testing.T) {
	cases := []struct {
		params, name, token string
	}{
		{`{"name":"add_marker","arguments":{}}`, "add_marker", ""},
		{`{"name":"slow","_meta":{"progressToken":"tok"}}`, "slow", `"tok"`},
		{`{"name":"slow","_meta":{"progressToken":7}}`, "slow", `7`},
		{`{"name":"slow","_meta":{"progressToken":null}}`, "slow", ""},
		{`{"name":"slow","_meta":{"other":1},"arguments":{"_meta":{"progressToken":"inner"}}}`, "slow", ""},
		{`null`, "", ""},
		{`[]`, "", ""},
	}
	for _, c := range cases {
		name, token := callParams(json.RawMessage(c.params))
		if name != c.name || string(token) != c.token {
			t.Errorf("%s: name %q token %q", c.params, name, token)
		}
	}
}

func TestWithProgressTokenChangesOnlyTheToken(t *testing.T) {
	arguments := `{"n":1e+21,"f":1.0,"big":12345678901234567890,"html":"<b>&</b>","nested":{"_meta":{"progressToken":"theirs"}}}`
	cases := []struct{ params, want string }{
		{`{"name":"slow","arguments":` + arguments + `}`,
			`{"name":"slow","arguments":` + arguments + `,"_meta":{"progressToken":"mine"}}`},
		{`{"_meta":{"trace":"<1>"},"name":"slow","arguments":` + arguments + `}`,
			`{"_meta":{"trace":"<1>","progressToken":"mine"},"name":"slow","arguments":` + arguments + `}`},
		{`{"name":"slow","_meta":null}`, `{"name":"slow","_meta":{"progressToken":"mine"}}`},
	}
	for _, c := range cases {
		got, ok := withProgressToken(json.RawMessage(c.params), "mine")
		if !ok || string(got) != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.params, got, c.want)
		}
	}
	for _, unusable := range []string{`null`, `[1]`, `"x"`, `{"_meta":7}`} {
		if got, ok := withProgressToken(json.RawMessage(unusable), "mine"); ok {
			t.Errorf("%s has no place for a token, got %s", unusable, got)
		}
	}
}

func TestMergeToolsPutsOwnFirstAndKeepsEveryOtherByte(t *testing.T) {
	real1 := `{"name":"add_marker","description":"<b>&</b>","inputSchema":{"type":"object","maximum":1e+21,"step":1.0}}`
	real2 := `{"name":"read_project","inputSchema":{"type":"object"}}`
	shadow := `{"name":"weftcut_status","description":"an app tool under the shim's name"}`
	result := `{"tools":[` + real1 + `,` + shadow + `,` + real2 + `],"nextCursor":"page<2>","_meta":{"n":1.50}}`
	got, err := mergeTools(json.RawMessage(result), syntheticTools)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"tools":[` + string(syntheticTools[0].definition) + `,` + string(syntheticTools[1].definition) + `,` + real1 + `,` + real2 +
		`],"nextCursor":"page<2>","_meta":{"n":1.50}}`
	if string(got) != want {
		t.Errorf("\n got %s\nwant %s", got, want)
	}

	// A result without a tools member still lists the shim's own.
	got, err = mergeTools(json.RawMessage(`{"_meta":{}}`), syntheticTools)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct{ Tools []struct{ Name string } }
	if json.Unmarshal(got, &listed) != nil || len(listed.Tools) != len(syntheticTools) {
		t.Errorf("own tools missing: %s", got)
	}
	if _, err := mergeTools(json.RawMessage(`[]`), syntheticTools); err == nil {
		t.Error("a result that is no object was merged")
	}
}

func TestSyntheticToolDefinitionsAreValidToolObjects(t *testing.T) {
	for _, tool := range syntheticTools {
		var def struct {
			Name        string
			Description string
			InputSchema map[string]any
			Annotations map[string]bool
		}
		if err := json.Unmarshal(tool.definition, &def); err != nil {
			t.Fatalf("%s: %v", tool.name, err)
		}
		if def.Name != tool.name || def.Description == "" || def.InputSchema["type"] != "object" || len(def.Annotations) == 0 {
			t.Errorf("%s is not a complete tool: %s", tool.name, tool.definition)
		}
	}
}

func TestCursorAndNotificationFields(t *testing.T) {
	if hasCursor(json.RawMessage(`{}`)) || hasCursor(nil) || hasCursor(json.RawMessage(`{"cursor":""}`)) {
		t.Error("a first page was read as a continuation")
	}
	if !hasCursor(json.RawMessage(`{"cursor":"abc"}`)) {
		t.Error("a cursor was not seen")
	}
	if got := progressToken(json.RawMessage(`{"progressToken":"t","progress":1}`)); got != idKey(json.RawMessage(`"t"`)) {
		t.Errorf("progress token keyed %q", got)
	}
	if got := cancelledID(json.RawMessage(`{"requestId":4,"reason":"stop"}`)); got != idKey(json.RawMessage(`4`)) {
		t.Errorf("cancelled id keyed %q", got)
	}
	if progressToken(json.RawMessage(`{}`)) != "" || cancelledID(nil) != "" {
		t.Error("a missing field produced a key")
	}
}
