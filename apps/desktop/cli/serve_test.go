package main

import (
	"encoding/json"
	"testing"
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
