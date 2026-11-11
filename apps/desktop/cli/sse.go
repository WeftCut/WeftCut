package main

// Server-Sent Events framing (the WHATWG event-stream format), as far as
// Streamable HTTP uses it: `data` and `event` fields; `id` and `retry` are
// read past, because a stream is never resumed.

import "bytes"

// sseParser turns the bytes of an event stream into events, across whatever
// chunk boundaries the network cut. No line has a length cap: one `data` line
// carries a whole JSON-RPC message, image frames included.
type sseParser struct {
	line    []byte
	data    []byte
	hasData bool
	event   string
	// afterCR: the last byte was a CR, so an LF opening the next chunk is the
	// second half of one line ending.
	afterCR bool
	started bool
}

// feed consumes chunk and calls emit once per completed event that carries
// data. The slice emit receives is its to keep.
func (p *sseParser) feed(chunk []byte, emit func(event string, data []byte)) {
	for len(chunk) > 0 {
		if p.afterCR {
			p.afterCR = false
			if chunk[0] == '\n' {
				chunk = chunk[1:]
				continue
			}
		}
		end := bytes.IndexAny(chunk, "\r\n")
		if end < 0 {
			p.line = append(p.line, chunk...)
			return
		}
		p.line = append(p.line, chunk[:end]...)
		p.afterCR = chunk[end] == '\r'
		chunk = chunk[end+1:]
		p.endLine(emit)
	}
}

func (p *sseParser) endLine(emit func(event string, data []byte)) {
	line := p.line
	p.line = p.line[:0]
	if !p.started {
		p.started = true
		line = bytes.TrimPrefix(line, []byte("\xEF\xBB\xBF"))
	}
	if len(line) == 0 {
		if p.hasData {
			// Each data line added its own line feed; the last one is not content.
			emit(p.event, bytes.Clone(p.data[:len(p.data)-1]))
		}
		p.data, p.hasData, p.event = nil, false, ""
		return
	}
	if line[0] == ':' {
		return
	}
	field, value, _ := bytes.Cut(line, []byte(":"))
	value = bytes.TrimPrefix(value, []byte(" "))
	switch string(field) {
	case "data":
		p.data = append(append(p.data, value...), '\n')
		p.hasData = true
	case "event":
		p.event = string(value)
	}
}
