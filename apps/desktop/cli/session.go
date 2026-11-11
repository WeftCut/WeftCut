package main

// The app side: one MCP session over Streamable HTTP on loopback, as a client.
// It moves messages and reports how each exchange ended; what a message means
// is serve.go's.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"time"
)

// handshakeTimeout bounds opening a session. A dead port refuses at once; this
// is for an app that accepts and then says nothing, which must not hold every
// waiting request for the length of a request window.
const handshakeTimeout = 3 * time.Second

// probeTimeout is how long the liveness ping, and the DELETE that ends a
// session, may take.
const probeTimeout = 3 * time.Second

// identity is who a session is opened as: the client's own `initialize`,
// passed on. The app attributes every edit to the name its session was opened
// under, and may ask the client only what these capabilities declare.
type identity struct {
	protocol     string
	clientInfo   json.RawMessage
	capabilities json.RawMessage
}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// appSession is an open session with the app.
type appSession struct {
	http     *http.Client
	endpoint string
	token    string
	id       string
	protocol string
	server   serverInfo
}

// newHTTPClient is the client of one session.
//
//   - Proxy nil: the endpoint is loopback, and a proxy from the user's
//     environment must never see the bearer token.
//   - No client timeout: a tool call's answer and the standalone stream stay
//     open for as long as they take; the shim's own timers decide.
//   - LANDMINE, DisableKeepAlives: the app's Node server closes a connection
//     idle for 5 s. A request written into a connection as it closes fails the
//     way a vanished app does, and would take the session down with it. One
//     connection per request costs nothing on loopback.
func newHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:              nil,
		DisableKeepAlives:  true,
		DisableCompression: true,
	}}
}

// errLost is an exchange the app did not complete as the protocol requires.
var errLost = errors.New("the app did not answer")

func (s *appSession) request(ctx context.Context, method string, body []byte) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.endpoint, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	if s.id != "" {
		req.Header.Set("Mcp-Session-Id", s.id)
		req.Header.Set("Mcp-Protocol-Version", s.protocol)
	}
	return req, nil
}

// post sends one message and hands every message of the answer to sink, in
// order, as it arrives: the response, and whatever the app sends on the way
// (progress, a request of its own). It returns when the answer has ended; an
// error means the app did not take the message or the answer broke off.
func (s *appSession) post(ctx context.Context, body []byte, sink func([]byte)) error {
	_, err := s.exchange(ctx, body, sink)
	return err
}

func (s *appSession) exchange(ctx context.Context, body []byte, sink func([]byte)) (http.Header, error) {
	req, err := s.request(ctx, http.MethodPost, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("%w: HTTP %d", errLost, resp.StatusCode)
	}
	if resp.StatusCode == http.StatusAccepted {
		return resp.Header, nil
	}
	return resp.Header, readMessages(resp, sink)
}

// readMessages reads the JSON-RPC messages of a response: an event stream, or
// one JSON body holding a message or an array of them.
func readMessages(resp *http.Response, sink func([]byte)) error {
	kind, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	switch kind {
	case "text/event-stream":
		var parser sseParser
		chunk := make([]byte, 64*1024)
		for {
			n, err := resp.Body.Read(chunk)
			parser.feed(chunk[:n], func(event string, data []byte) {
				if (event == "" || event == "message") && len(data) > 0 {
					sink(data)
				}
			})
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return err
			}
		}
	case "application/json":
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		data = bytes.TrimSpace(data)
		if len(data) > 0 && data[0] == '[' {
			batch, err := parseArray(data)
			if err != nil {
				return err
			}
			for _, message := range batch {
				sink(message)
			}
			return nil
		}
		if len(data) > 0 {
			sink(data)
		}
		return nil
	default:
		return fmt.Errorf("%w: content type %q", errLost, resp.Header.Get("Content-Type"))
	}
}

// listen holds the session's standalone stream open, handing sink what the
// app sends outside any request, until the stream ends. offered is false when
// the app has no such stream to give (405), which is not a failure.
func (s *appSession) listen(ctx context.Context, sink func([]byte)) (offered bool) {
	req, err := s.request(ctx, http.MethodGet, nil)
	if err != nil {
		return true
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := s.http.Do(req)
	if err != nil {
		return true
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusMethodNotAllowed {
		return false
	}
	if resp.StatusCode == http.StatusOK {
		_ = readMessages(resp, sink)
	}
	return true
}

// end tells the app the session is over (DELETE), which releases the agent's
// work session and history lock at once instead of leaving them to the app's
// reaper. Best effort: the app may be the thing that went away.
func (s *appSession) end() {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	req, err := s.request(ctx, http.MethodDelete, nil)
	if err != nil {
		return
	}
	if resp, err := s.http.Do(req); err == nil {
		resp.Body.Close()
	}
}

// call sends one request and returns its response message, for the terminal
// subcommands: no table, no stream, one question at a time.
func (s *appSession) call(ctx context.Context, id string, method string, params json.RawMessage) ([]byte, error) {
	want := idKey(quote(id))
	var response []byte
	err := s.post(ctx, requestMessage(quote(id), method, params), func(message []byte) {
		if e, err := parseEnvelope(message); err == nil && e.isResponse() && idKey(e.ID) == want {
			response = message
		}
	})
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, errLost
	}
	return response, nil
}

// connectOutcome is how an attempt to open a session ended: exactly one of a
// session, no rendezvous file, a protocol mismatch, or (all nil) nothing
// answering.
type connectOutcome struct {
	session  *appSession
	noAuth   bool
	mismatch *mismatch
}

// The shim's own request ids are strings under this prefix, so none can equal
// an id of the client's, whose requests travel in the same session untouched.
const ownIDPrefix = "weftcut-cli:"

// connect opens a session as who, at who's protocol version. An app that
// answers at another version is not kept: the client was already told which
// version its session speaks, and every message would cross a hop that
// disagrees with it.
func connect(ctx context.Context, userData string, who identity) connectOutcome {
	a := readAuth(userData)
	if a == nil {
		return connectOutcome{noAuth: true}
	}
	ctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	s := &appSession{http: newHTTPClient(), endpoint: a.endpoint(), token: a.Token}
	id := quote(ownIDPrefix + "initialize")
	params := concat(`{"protocolVersion":`, quote(who.protocol), `,"capabilities":`, who.capabilities, `,"clientInfo":`, who.clientInfo, `}`)
	var result struct {
		Result *struct {
			ProtocolVersion string     `json:"protocolVersion"`
			ServerInfo      serverInfo `json:"serverInfo"`
		} `json:"result"`
	}
	header, err := s.exchange(ctx, requestMessage(id, methodInitialize, params), func(message []byte) {
		if e, err := parseEnvelope(message); err == nil && e.isResponse() && idKey(e.ID) == idKey(id) {
			_ = json.Unmarshal(message, &result)
		}
	})
	if err != nil || result.Result == nil {
		return connectOutcome{}
	}
	s.id = header.Get("Mcp-Session-Id")
	s.protocol = result.Result.ProtocolVersion
	s.server = result.Result.ServerInfo
	if s.protocol != who.protocol {
		s.end()
		return connectOutcome{mismatch: &mismatch{endpoint: s.endpoint, asked: who.protocol, answered: s.protocol}}
	}
	if err := s.post(ctx, notificationMessage(initializedNote, nil), func([]byte) {}); err != nil {
		s.end()
		return connectOutcome{}
	}
	return connectOutcome{session: s}
}
