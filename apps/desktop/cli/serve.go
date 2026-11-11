package main

// `weftcut mcp`: an MCP server on stdio that is a passthrough to the running
// app. One loop owns all state and takes one event at a time (a client line,
// an app message, a timer, the end of an exchange); everything that waits on
// the network or a clock runs beside it and reports back as an event.
//
// The shim answers itself only what must work without the app or is its own:
// `initialize`, `ping`, its two tools, and the answers of the down state.
// Every other message crosses in the direction it was going, unread past its
// envelope. See docs/adr/0165.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	// pollInterval is how often the shim checks the app: a ping while up, a
	// connect attempt while down.
	pollInterval = 10 * time.Second
	// launchTimeout is how long launch_weftcut waits for the endpoint of the
	// app it started; launchPoll is how often it looks.
	launchTimeout = 45 * time.Second
	launchPoll    = time.Second
	// outputDrain is how long queued answers get to reach a client at exit.
	outputDrain = 2 * time.Second
)

// Events of the loop.
type (
	evLine struct{ line []byte }
	evEOF  struct{}
	// evApp is one message from the app, on any stream of session gen.
	evApp struct {
		gen     uint64
		message []byte
	}
	// evPostDone is the end of one POST: its answer ended, or err says it
	// never completed. track names the request it carried, if any.
	evPostDone struct {
		gen, seq uint64
		track    string
		own      bool
		err      error
	}
	evStreamEnded struct {
		gen     uint64
		offered bool
	}
	evConnected struct{ outcome connectOutcome }
	evExpired   struct {
		kind expiry
		key  string
		arm  uint64
	}
	evOwnExpired struct{ key string }
	evLaunchTick struct{}
)

// request is a client request: its envelope, and the line it arrived as.
type request struct {
	rawID  json.RawMessage
	key    string
	method string
	params json.RawMessage
	line   []byte
}

// waiter is something held until the connect attempt in flight ends.
type waiter struct {
	kind waiterKind
	// req: a request to forward, or answer as down.
	req *request
	// key: the weftcut_status or launch_weftcut call to answer.
	key string
}

type waiterKind int

const (
	waitRequest waiterKind = iota
	waitStatus
	waitLaunch
)

// launchWait is a launch_weftcut that started the app and is waiting for its
// endpoint. Later calls join it instead of starting the app again.
type launchWait struct {
	deadline time.Time
	app      string
	callers  []string
	// polling: the connect attempt in flight is this wait's look.
	polling bool
}

type server struct {
	host     host
	userData string
	timeouts timeouts
	events   chan any
	out      *outbox

	// hello is who the client said it is. The app session is opened as that
	// client, so nothing is opened before it.
	hello *identity

	// up is the app session; nil while down. gen changes at every transition,
	// so an event from an exchange of an earlier session is recognised.
	up         *appSession
	gen        uint64
	ctx        context.Context
	cancel     context.CancelFunc
	connecting bool
	waiters    []waiter
	// mismatch: the last connect attempt found an app at another protocol version.
	mismatch *mismatch

	pending map[string]*pending
	// tokens maps the progress token of a call in flight to its request.
	tokens map[string]string
	// orphans are tool calls the shim answered while the app works on: the
	// request key to its token, and the tokens. What the app still sends for
	// them is dropped.
	orphans      map[string]string
	orphanTokens map[string]bool
	// appRequests are the ids of requests the app made that the client has
	// not answered yet.
	appRequests map[string]bool
	own         map[string]*ownRequest
	// local are the calls of the shim's own tools not yet answered: the id
	// key to the id as the client wrote it. A cancelled call leaves it.
	local     map[string]json.RawMessage
	launching *launchWait

	order, nextOwn, posts uint64
	probing               bool
	// The standalone stream: open now; offered by this app at all; to be
	// reopened after the next ping that answers.
	streamOpen, streamOffered, streamDue bool
}

func serve(h host) int {
	s := &server{
		host:     h,
		userData: resolveUserDataDir(h),
		timeouts: configuredTimeouts(h),
		events:   make(chan any, 64),
	}
	s.resetTables()
	// A client that stopped reading has gone, as one that closed stdin has.
	s.out = newOutbox(os.Stdout, func() { go func() { s.events <- evEOF{} }() })
	go readLines(os.Stdin, s.events)

	// LANDMINE: without this the Go runtime ends the process on SIGPIPE the
	// moment a write to stdout finds the client gone, and the app session is
	// never deleted. Ignored, the write fails instead and the outbox reports it.
	signal.Ignore(syscall.SIGPIPE)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	poll := time.NewTicker(pollInterval)
	defer poll.Stop()

	for running := true; running; {
		select {
		case ev := <-s.events:
			running = s.handle(ev)
		case <-poll.C:
			s.poll()
		case <-signals:
			running = false
		}
	}
	s.shutdown()
	return 0
}

func (s *server) resetTables() {
	s.pending = map[string]*pending{}
	s.tokens = map[string]string{}
	s.orphans = map[string]string{}
	s.orphanTokens = map[string]bool{}
	s.appRequests = map[string]bool{}
	s.own = map[string]*ownRequest{}
	if s.local == nil {
		s.local = map[string]json.RawMessage{}
	}
}

// handle takes one event; false ends the loop.
func (s *server) handle(ev any) bool {
	switch ev := ev.(type) {
	case evLine:
		s.fromClient(ev.line)
	case evEOF:
		return false
	case evApp:
		if ev.gen == s.gen {
			s.fromApp(ev.message)
		}
	case evPostDone:
		s.postDone(ev)
	case evStreamEnded:
		if ev.gen == s.gen {
			s.streamOpen = false
			s.streamOffered = ev.offered
			if ev.offered {
				// The stream ending is the first sign of an app that quit.
				s.probe()
			}
		}
	case evConnected:
		s.connected(ev.outcome)
	case evExpired:
		s.expire(ev)
	case evOwnExpired:
		s.ownExpired(ev.key)
	case evLaunchTick:
		s.launchTick()
	}
	return true
}

// shutdown ends the app session before the process does: the DELETE releases
// the agent's work session and history lock, which the app would otherwise
// hold until its reaper noticed. A session whose opening is still in flight is
// waited for and ended too.
func (s *server) shutdown() {
	if s.up != nil {
		s.cancel()
		s.up.end()
	} else if s.connecting {
		limit := time.After(handshakeTimeout + probeTimeout)
		for waiting := true; waiting; {
			select {
			case ev := <-s.events:
				if c, ok := ev.(evConnected); ok {
					if c.outcome.session != nil {
						c.outcome.session.end()
					}
					waiting = false
				}
			case <-limit:
				waiting = false
			}
		}
	}
	s.out.drainWithin(outputDrain)
}

func (s *server) write(message []byte) {
	s.out.push(oneLine(message))
}

func (s *server) down() downState {
	return downState{userData: s.userData, auth: readAuth(s.userData), mismatch: s.mismatch}
}

// ownID is a fresh id for a request of the shim's own.
func (s *server) ownID() json.RawMessage {
	s.nextOwn++
	return quote(fmt.Sprintf("%s%d", ownIDPrefix, s.nextOwn))
}

// --- from the client ---

func (s *server) fromClient(line []byte) {
	e, err := parseEnvelope(line)
	if err != nil {
		fmt.Fprintln(os.Stderr, "weftcut: a line on stdin is not JSON-RPC:", err)
		return
	}
	switch {
	case e.isRequest():
		s.clientRequest(&request{rawID: e.ID, key: idKey(e.ID), method: *e.Method, params: e.Params, line: line})
	case e.isNotification():
		s.clientNotification(*e.Method, e.Params, line)
	case e.isResponse():
		// An answer to a request the app made: it goes back to the session
		// that asked, and nowhere once that session is gone.
		if key := idKey(e.ID); s.appRequests[key] {
			delete(s.appRequests, key)
			s.post(line, "", false, nil)
		}
	}
}

func (s *server) clientRequest(r *request) {
	switch {
	case r.method == methodInitialize:
		s.initialize(r)
	case r.method == methodPing:
		s.write(resultMessage(r.rawID, json.RawMessage(`{}`)))
	case s.hello == nil:
		// The app session is opened as the client; before the client has
		// said who it is there is no one to open it as.
		s.write(errorMessage(r.rawID, codeInvalidRequest, beforeInitializeText))
	case s.inUse(r.key):
		// Two requests under one id could not be told apart in any table.
		s.write(errorMessage(r.rawID, codeInvalidRequest, duplicateIDText))
	default:
		if r.method == methodToolsCall {
			switch name, _ := callParams(r.params); name {
			case toolStatus:
				s.statusCall(r)
				return
			case toolLaunch:
				s.launchCall(r)
				return
			}
		}
		if s.up != nil {
			s.forward(r)
			return
		}
		// Any request is a moment a just-started app should become visible,
		// without waiting on the poll.
		s.waiters = append(s.waiters, waiter{kind: waitRequest, req: r})
		s.ensureConnecting()
	}
}

// inUse reports whether the client still awaits an answer under this id.
func (s *server) inUse(key string) bool {
	if _, ok := s.pending[key]; ok {
		return true
	}
	if _, ok := s.local[key]; ok {
		return true
	}
	for _, w := range s.waiters {
		if w.kind == waitRequest && w.req.key == key {
			return true
		}
	}
	return false
}

func (s *server) initialize(r *request) {
	var p struct {
		ProtocolVersion string          `json:"protocolVersion"`
		Capabilities    json.RawMessage `json:"capabilities"`
		ClientInfo      json.RawMessage `json:"clientInfo"`
	}
	_ = json.Unmarshal(r.params, &p)
	protocol := negotiate(p.ProtocolVersion)
	if s.hello == nil {
		who := identity{protocol: protocol, clientInfo: p.ClientInfo, capabilities: p.Capabilities}
		if !present(who.clientInfo) {
			who.clientInfo = json.RawMessage(`{"name":"MCP client","version":""}`)
		}
		if !present(who.capabilities) {
			who.capabilities = json.RawMessage(`{}`)
		}
		s.hello = &who
	}
	s.write(resultMessage(r.rawID, initializeResult(protocol)))
}

func (s *server) clientNotification(method string, params json.RawMessage, line []byte) {
	switch method {
	case initializedNote:
		// The shim sends the app its own; the client's is the cue to connect.
		s.ensureConnecting()
	case cancelledNote:
		s.clientCancelled(cancelledID(params), line)
	default:
		s.post(line, "", false, nil)
	}
}

// clientCancelled is the client giving up on a request. Only this explicit
// notification cancels the app's job: a client that merely goes away leaves it
// running, so a retry can join it.
func (s *server) clientCancelled(key string, line []byte) {
	if p := s.take(key); p != nil {
		// The answer stream is closed once the app has the cancel: it would
		// never end by itself, since a cancelled request gets no response.
		s.post(line, "", false, p.stop)
		return
	}
	for i, w := range s.waiters {
		if w.kind == waitRequest && w.req.key == key {
			s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
			return
		}
	}
	if _, ok := s.local[key]; ok {
		delete(s.local, key)
		return
	}
	s.post(line, "", false, nil)
}

// --- from the app ---

func (s *server) fromApp(message []byte) {
	e, err := parseEnvelope(message)
	if err != nil {
		return
	}
	switch {
	case e.isRequest():
		s.appRequests[idKey(e.ID)] = true
		s.write(message)
	case e.isNotification():
		switch *e.Method {
		case progressNote:
			if !s.progressed(progressToken(e.Params)) {
				return
			}
		case cancelledNote:
			delete(s.appRequests, cancelledID(e.Params))
		}
		s.write(message)
	case e.isResponse():
		key := idKey(e.ID)
		if o, ok := s.own[key]; ok {
			delete(s.own, key)
			o.timer.Stop()
			s.ownAnswered(o, message)
			return
		}
		s.answered(key, e, message)
	}
}

func (s *server) ownAnswered(o *ownRequest, message []byte) {
	switch o.kind {
	case ownProbe:
		// Any response is the app answering, an error included.
		s.probeAlive()
	case ownStatusRead:
		s.answerLocal(o.caller, textResult(statusUpText(s.up.server, s.up.endpoint, projectLine(message)), false))
	}
}

func (s *server) ownExpired(key string) {
	o, ok := s.own[key]
	if !ok {
		return
	}
	delete(s.own, key)
	switch o.kind {
	case ownProbe:
		s.markDown()
	case ownStatusRead:
		// The status call itself must still answer; it goes without the line.
		s.answerLocal(o.caller, textResult(statusUpText(s.up.server, s.up.endpoint, ""), false))
	}
}

// --- the app session ---

// post sends one message to the app beside the loop. Every message of the
// answer comes back as an evApp, then an evPostDone. track names the request
// the message carries, so a POST that ends without that request's response is
// known to have lost it. then, if given, runs once the POST has ended.
func (s *server) post(body []byte, track string, own bool, then func()) (seq uint64, stop context.CancelFunc) {
	if s.up == nil {
		return 0, func() {}
	}
	s.posts++
	seq = s.posts
	session, gen, events := s.up, s.gen, s.events
	ctx, stop := context.WithCancel(s.ctx)
	go func() {
		err := session.post(ctx, body, func(message []byte) { events <- evApp{gen, message} })
		stop()
		if then != nil {
			then()
		}
		events <- evPostDone{gen: gen, seq: seq, track: track, own: own, err: err}
	}()
	return seq, stop
}

// postDone is the end of a POST. One that ends while its request is still
// unanswered, or that the app did not accept, means the app went away under
// the session: every request in flight is failed now, not at its next timeout.
func (s *server) postDone(ev evPostDone) {
	if ev.gen != s.gen {
		return
	}
	lost := false
	switch {
	case ev.own:
		_, lost = s.own[ev.track]
	case ev.track != "":
		if p, ok := s.pending[ev.track]; ok && p.post == ev.seq {
			lost = true
		} else if token, orphan := s.orphans[ev.track]; orphan {
			delete(s.orphans, ev.track)
			delete(s.orphanTokens, token)
		}
	default:
		lost = ev.err != nil
	}
	if lost {
		s.markDown()
	}
}

func (s *server) openStream() {
	s.streamOpen = true
	session, gen, ctx, events := s.up, s.gen, s.ctx, s.events
	go func() {
		offered := session.listen(ctx, func(message []byte) { events <- evApp{gen, message} })
		events <- evStreamEnded{gen, offered}
	}()
}

func (s *server) ensureConnecting() {
	if s.up != nil || s.connecting || s.hello == nil {
		return
	}
	s.connecting = true
	userData, who, events := s.userData, *s.hello, s.events
	go func() { events <- evConnected{connect(context.Background(), userData, who)} }()
}

func (s *server) connected(outcome connectOutcome) {
	s.connecting = false
	s.mismatch = outcome.mismatch
	if outcome.session != nil {
		s.up = outcome.session
		s.gen++
		s.ctx, s.cancel = context.WithCancel(context.Background())
		s.streamOffered = true
		s.openStream()
		s.broadcast()
	}
	waiters := s.waiters
	s.waiters = nil
	for _, w := range waiters {
		switch {
		case w.kind == waitRequest && s.up != nil:
			s.forward(w.req)
		case w.kind == waitRequest:
			s.write(s.downAnswer(w.req.rawID, w.req.method, !hasCursor(w.req.params), false))
		case w.kind == waitStatus && s.up != nil:
			s.readStatus(w.key)
		case w.kind == waitStatus:
			s.answerLocal(w.key, textResult(s.down().statusText(), false))
		case w.kind == waitLaunch:
			s.launch(w.key)
		}
	}
	s.launchLooked()
}

// markDown is the app going away under a session: the session is ended,
// everything in flight is answered as down, and the client is told its
// catalog changed.
func (s *server) markDown() {
	if s.up == nil {
		return
	}
	old := s.up
	s.up = nil
	s.gen++
	s.cancel()
	go old.end()
	s.probing, s.streamOpen, s.streamDue = false, false, false

	for _, key := range s.inOrder() {
		p := s.pending[key]
		p.stopTimers()
		s.write(s.downAnswer(p.rawID, p.method, p.firstPage, true))
	}
	own := s.own
	s.resetTables()
	for _, o := range own {
		o.timer.Stop()
		if o.kind == ownStatusRead {
			s.answerLocal(o.caller, textResult(s.down().statusText(), false))
		}
	}
	s.broadcast()
}

// broadcast tells the client its catalog changed: the app's tools, resources
// and prompts appear and disappear with the session.
func (s *server) broadcast() {
	for _, method := range catalogChanged {
		s.write(notificationMessage(method, nil))
	}
}

func (s *server) poll() {
	if s.up == nil {
		s.ensureConnecting()
		return
	}
	s.streamDue = true
	s.probe()
}

// --- the shim's own tools ---

func (s *server) answerLocal(key string, result json.RawMessage) {
	if id, ok := s.local[key]; ok {
		delete(s.local, key)
		s.write(resultMessage(id, result))
	}
}

func (s *server) statusCall(r *request) {
	s.local[r.key] = r.rawID
	if s.up != nil {
		s.readStatus(r.key)
		return
	}
	s.waiters = append(s.waiters, waiter{kind: waitStatus, key: r.key})
	s.ensureConnecting()
}

// readStatus asks the app which project is open, for the status's `Project:`
// line. A request of the shim's own, under the flat request window.
func (s *server) readStatus(caller string) {
	id := s.ownID()
	key := idKey(id)
	s.own[key] = &ownRequest{kind: ownStatusRead, caller: caller, timer: s.after(s.timeouts.request, evOwnExpired{key})}
	params := json.RawMessage(`{"name":"read_project","arguments":{"view":"session"}}`)
	s.post(requestMessage(id, methodToolsCall, params), key, true, nil)
}

func (s *server) launchCall(r *request) {
	s.local[r.key] = r.rawID
	switch {
	case s.up != nil:
		s.answerLocal(r.key, textResult(alreadyRunningText, false))
	case s.launching != nil:
		s.launching.callers = append(s.launching.callers, r.key)
	default:
		s.waiters = append(s.waiters, waiter{kind: waitLaunch, key: r.key})
		s.ensureConnecting()
	}
}

// launch runs once a connect attempt has said whether the app is already
// there: it starts the app only when nothing answered.
func (s *server) launch(key string) {
	switch {
	case s.up != nil:
		s.answerLocal(key, textResult(alreadyRunningText, false))
		return
	case s.mismatch != nil:
		s.answerLocal(key, textResult(s.mismatch.text(), true))
		return
	case s.launching != nil:
		s.launching.callers = append(s.launching.callers, key)
		return
	}
	target, ok := findApp(s.host, s.userData, os.ReadFile)
	if !ok {
		s.answerLocal(key, textResult(noAppText, true))
		return
	}
	name, args := launchCommand(s.host, target)
	if err := startDetached(s.host, name, args); err != nil {
		s.answerLocal(key, textResult(launchFailedText(target.describe(), err), true))
		return
	}
	s.launching = &launchWait{deadline: time.Now().Add(launchTimeout), app: target.describe(), callers: []string{key}}
	s.after(launchPoll, evLaunchTick{})
}

func (s *server) launchTick() {
	if s.launching == nil {
		return
	}
	s.launching.polling = true
	if s.up != nil {
		s.launchLooked()
		return
	}
	s.ensureConnecting()
}

// launchLooked ends or continues a launch wait after a look at the endpoint.
func (s *server) launchLooked() {
	w := s.launching
	if w == nil {
		return
	}
	var result json.RawMessage
	switch {
	case s.up != nil:
		result = textResult(launchedText, false)
	case !w.polling:
		// A connect attempt someone else asked for: the wait's own look is
		// still to come.
		return
	case s.mismatch != nil:
		result = textResult(s.mismatch.text(), true)
	case !time.Now().Before(w.deadline):
		result = textResult(launchTimeoutText(w.app, launchTimeout), true)
	default:
		w.polling = false
		s.after(launchPoll, evLaunchTick{})
		return
	}
	s.launching = nil
	for _, caller := range w.callers {
		s.answerLocal(caller, result)
	}
}
