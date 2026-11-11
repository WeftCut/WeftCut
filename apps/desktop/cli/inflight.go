package main

// The requests the client is waiting on that the app has yet to answer, and
// the clocks that run on them. The table is what lets the shim answer in the
// app's place (the app went away, a wait ran out) and then drop the app's own
// answer if one still comes.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// expiry is which wait of a request ran out.
type expiry int

const (
	notExpired expiry = iota
	idleExpired
	totalExpired
	flatExpired
)

// pending is one client request forwarded to the app.
type pending struct {
	rawID  json.RawMessage
	method string
	// tool is the tool a tools/call names.
	tool string
	// firstPage: a tools/list without a cursor, whose answer gains the
	// shim's own tools.
	firstPage bool
	// token is the progress token the app-side call carries (an idKey): the
	// client's, or one the shim injected. Empty: none.
	token    string
	injected bool
	// order is the arrival rank, so several answers the shim writes at once
	// go out in the order the requests came.
	order uint64
	// post identifies the POST that carries the request; stop ends it.
	post uint64
	stop context.CancelFunc

	idle, total, flat *time.Timer
	// arm counts idle re-arms: an expiry carrying an older count lost a race
	// with a progress notification and is ignored.
	arm     uint64
	expired expiry
}

func (p *pending) stopTimers() {
	for _, t := range []*time.Timer{p.idle, p.total, p.flat} {
		if t != nil {
			t.Stop()
		}
	}
}

// ownKind is what a request of the shim's own is for.
type ownKind int

const (
	ownProbe ownKind = iota
	ownStatusRead
)

// ownRequest is a request the shim itself made of the app.
type ownRequest struct {
	kind ownKind
	// caller is the weftcut_status call a status read answers.
	caller string
	timer  *time.Timer
}

// after delivers ev to the loop once d has passed, unless stopped first.
func (s *server) after(d time.Duration, ev any) *time.Timer {
	return time.AfterFunc(d, func() { s.events <- ev })
}

// forward sends a client request to the app and starts its clock: the idle
// window for a tool call, the flat request window for anything else.
func (s *server) forward(r *request) {
	s.order++
	p := &pending{rawID: r.rawID, method: r.method, order: s.order}
	body := r.line
	if r.method == methodToolsCall {
		name, token := callParams(r.params)
		p.tool = name
		if token != nil {
			p.token = idKey(token)
		} else {
			// The idle window is re-armed by progress, and the app reports
			// progress only to a call that carries a token: the shim attaches
			// its own and keeps those notifications to itself.
			s.nextOwn++
			own := fmt.Sprintf("%sprogress:%d", ownIDPrefix, s.nextOwn)
			if params, ok := withProgressToken(r.params, own); ok {
				body = requestMessage(r.rawID, r.method, params)
				p.token, p.injected = idKey(quote(own)), true
			}
		}
		p.idle = s.after(s.timeouts.toolIdle, evExpired{idleExpired, r.key, p.arm})
		if s.timeouts.toolMaxTotal > 0 {
			p.total = s.after(s.timeouts.toolMaxTotal, evExpired{totalExpired, r.key, 0})
		}
	} else {
		p.firstPage = r.method == methodToolsList && !hasCursor(r.params)
		p.flat = s.after(s.timeouts.request, evExpired{flatExpired, r.key, 0})
	}
	s.pending[r.key] = p
	if p.token != "" {
		s.tokens[p.token] = r.key
	}
	p.post, p.stop = s.post(body, r.key, false, nil)
}

// take removes a request from the table: its clocks stop and its token no
// longer re-arms anything.
func (s *server) take(key string) *pending {
	p, ok := s.pending[key]
	if !ok {
		return nil
	}
	delete(s.pending, key)
	p.stopTimers()
	if p.token != "" && s.tokens[p.token] == key {
		delete(s.tokens, p.token)
	}
	return p
}

// answered handles the app's response to a client request: forwarded as it
// came, except a first tools/list page, which gains the shim's own tools. A
// response to a request the shim already answered is dropped.
func (s *server) answered(key string, e envelope, message []byte) {
	p := s.take(key)
	if p == nil {
		if token, late := s.orphans[key]; late {
			delete(s.orphans, key)
			delete(s.orphanTokens, token)
		}
		return
	}
	if p.firstPage && present(e.Result) {
		if merged, err := mergeTools(e.Result, syntheticTools); err == nil {
			message = resultMessage(p.rawID, merged)
		}
	}
	s.write(message)
}

// progressed handles a progress notification from the app and reports whether
// the client is to see it.
func (s *server) progressed(token string) (relay bool) {
	key, live := s.tokens[token]
	if !live {
		// Progress for a call the shim already answered: the client has no
		// request left that it could belong to.
		return !s.orphanTokens[token]
	}
	p := s.pending[key]
	if p.idle != nil && p.expired == notExpired {
		p.idle.Stop()
		p.arm++
		p.idle = s.after(s.timeouts.toolIdle, evExpired{idleExpired, key, p.arm})
	}
	return !p.injected
}

// expire records that a wait ran out. Running out does not say the app is
// gone (a long tool call looks exactly like it), so the answer waits for a
// liveness ping to tell which.
func (s *server) expire(ev evExpired) {
	p, ok := s.pending[ev.key]
	if !ok || p.expired != notExpired || (ev.kind == idleExpired && ev.arm != p.arm) {
		return
	}
	p.expired = ev.kind
	p.stopTimers()
	s.probe()
}

// probe pings the app, once however many ask. An answer leads to probeAlive;
// silence for probeTimeout, or a failed POST, marks the app down.
func (s *server) probe() {
	if s.up == nil || s.probing {
		return
	}
	s.probing = true
	id := s.ownID()
	s.own[idKey(id)] = &ownRequest{kind: ownProbe, timer: s.after(probeTimeout, evOwnExpired{idKey(id)})}
	s.post(requestMessage(id, methodPing, nil), idKey(id), true, nil)
}

// probeAlive answers every request whose wait ran out: the app is there and
// has not finished.
func (s *server) probeAlive() {
	s.probing = false
	for _, key := range s.inOrder() {
		p := s.pending[key]
		if p.expired == notExpired {
			continue
		}
		s.take(key)
		if p.method == methodToolsCall {
			// A tool result, not a protocol error: the call is fine, only this
			// wait is over. The job is left running in the app, so an identical
			// retry can join it; what the app still sends for it is dropped.
			waited, total := s.timeouts.toolIdle, false
			if p.expired == totalExpired {
				waited, total = s.timeouts.toolMaxTotal, true
			}
			s.write(resultMessage(p.rawID, textResult(toolTimeoutText(p.tool, waited, total), true)))
			s.orphans[key] = p.token
			if p.token != "" {
				s.orphanTokens[p.token] = true
			}
			continue
		}
		s.write(errorMessage(p.rawID, codeRequestTimeout, requestTimeoutText(p.method, s.timeouts.request)))
		cancelled := concat(`{"requestId":`, p.rawID, `,"reason":"Request timed out"}`)
		s.post(notificationMessage(cancelledNote, cancelled), "", false, p.stop)
	}
	if s.streamDue && !s.streamOpen && s.streamOffered {
		s.openStream()
	}
	s.streamDue = false
}

// inOrder is the keys of the table in arrival order.
func (s *server) inOrder() []string {
	keys := make([]string, 0, len(s.pending))
	for key := range s.pending {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(a, b int) bool { return s.pending[keys[a]].order < s.pending[keys[b]].order })
	return keys
}

// downAnswer is what a request gets while the app cannot answer it. The
// listings answer empty rather than fail: there is nothing to list until the
// app is up, and a client that lists at start-up must not see an error. A
// method the shim has no such answer for is, without the app, not a method of
// this server; one that was already with the app when it went away fails as
// the request it was.
func (s *server) downAnswer(id json.RawMessage, method string, firstPage, inFlight bool) []byte {
	switch method {
	case methodToolsList:
		var tools []json.RawMessage
		if firstPage {
			for _, tool := range syntheticTools {
				tools = append(tools, tool.definition)
			}
		}
		return resultMessage(id, concat(`{"tools":`, encodeArray(tools), `}`))
	case "resources/list":
		return resultMessage(id, json.RawMessage(`{"resources":[]}`))
	case "resources/templates/list":
		return resultMessage(id, json.RawMessage(`{"resourceTemplates":[]}`))
	case "prompts/list":
		return resultMessage(id, json.RawMessage(`{"prompts":[]}`))
	case methodToolsCall, "resources/read", "prompts/get":
		return errorMessage(id, codeInternalError, s.down().errorText())
	}
	if inFlight {
		return errorMessage(id, codeInternalError, s.down().errorText())
	}
	return errorMessage(id, codeMethodNotFound, "Method not found")
}
