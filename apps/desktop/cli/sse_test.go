package main

import (
	"reflect"
	"strings"
	"testing"
)

type sseEvent struct{ event, data string }

// parseIn feeds stream to a parser in pieces of the given size.
func parseIn(stream string, piece int) []sseEvent {
	var p sseParser
	var out []sseEvent
	for start := 0; start < len(stream); start += piece {
		end := min(start+piece, len(stream))
		p.feed([]byte(stream[start:end]), func(event string, data []byte) {
			out = append(out, sseEvent{event, string(data)})
		})
	}
	return out
}

func TestSSEFramingIsTheSameWhereverTheChunksCut(t *testing.T) {
	stream := "\xEF\xBB\xBF: a comment\n" +
		"event: message\ndata: {\"id\":1}\n\n" +
		"id: 7\nretry: 300\ndata: first\ndata: second\n\n" +
		"event: message\r\ndata:{\"crlf\":true}\r\n\r\n" +
		"data: cr only\r\r" +
		"event: other\ndata: x\n\n" +
		"data\n\n" +
		"event: dropped, no data\n\n" +
		"data: unterminated"
	want := []sseEvent{
		{"message", `{"id":1}`},
		{"", "first\nsecond"},
		{"message", `{"crlf":true}`},
		{"", "cr only"},
		{"other", "x"},
		{"", ""},
	}
	for _, piece := range []int{1, 2, 3, 7, 64, len(stream)} {
		if got := parseIn(stream, piece); !reflect.DeepEqual(got, want) {
			t.Errorf("in pieces of %d:\n got %q\nwant %q", piece, got, want)
		}
	}
}

func TestSSEDataLineHasNoLengthCap(t *testing.T) {
	// Larger than any buffer the reader uses: a tool result with image frames.
	payload := strings.Repeat("0123456789abcdef", 1<<17)
	got := parseIn("data: "+payload+"\n\n", 64*1024)
	if len(got) != 1 || got[0].data != payload {
		t.Fatalf("a %d-byte data line did not come through whole", len(payload))
	}
}

func TestSSEEventDataIsTheCallersToKeep(t *testing.T) {
	var p sseParser
	var kept [][]byte
	p.feed([]byte("data: one\n\ndata: two\n\n"), func(_ string, data []byte) { kept = append(kept, data) })
	if string(kept[0]) != "one" || string(kept[1]) != "two" {
		t.Errorf("a later event overwrote an earlier one: %q", kept)
	}
}
