---
status: accepted
---

# The side-panel view reaches the app through tool calls, and its picture over loopback WebRTC

Date: 2026-11-28

Refines ADR 0168, which gave a host with a side panel "another transport, not
another UI" and left the transport open.

## Context

A host that implements MCP Apps can show a server's view in its conversation's
side panel. Measured with a prototype in ChatGPT desktop 26.1111 on Windows:

- A tool hidden from the model (`_meta.ui.visibility: ["app"]`) that carries
  `_meta["openai/ui"].entrypoints: [{ "type": "thread" }]` appears in the side
  panel and opens its view, for a server configured in `config.toml`.
- The view cannot fetch loopback: the request fails at once, although the host
  lists the loopback origin among the allowed connect domains.
- The view's tool calls reach the app through `weftcut mcp` in about 6 ms.
- WebRTC signaled over those calls, with only the `127.0.0.1` candidate,
  connected in under 0.2 s and carried a media track at 15 fps. On macOS a LAN
  candidate waited on the firewall's prompt; the loopback one did not.
- ChatGPT keeps a view by its `ui://` address: after the app changed, the old
  view ran until the address changed.
- A signaling request that reached the editor before its bridge listened was
  dropped and waited out its timeout.

The MCP Apps spec (2026-01-26) has a view's default CSP refuse every request,
its own files included, and lets a server check the client's declared UI
capability before it lists UI tools.

## Decision

- **One UI, a second transport.** The page's modules run in the view
  unchanged; `transportToolcall.js` fills the seam `transportLoopback.js`
  fills, over a hand-written MCP Apps bridge (handshake, `tools/call`, size,
  teardown). The view is one generated, committed HTML document with every
  module and the stylesheet inline.
- **The address is the content.** `ui://weftcut/side-preview-<hash>.html`,
  `<hash>` from a SHA-256 of the document, computed the same way by the binary
  and the app. A check fails when the committed document is stale.
- **One definition, two servers.** The entry tool, the view and its sync tool
  are defined in `cli/companion/panel/entry.json`. The `weftcut` binary answers
  the entry and the view itself, with or without the app, and drops the app's
  copies from what it passes through; the app serves all three to a session
  that connects over HTTP. The comparison of `weftcut mcp` against HTTP covers
  them.
- **Listed by capability, not by host.** Only a client that declares
  `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app` is listed the
  entry, the view and the sync tool. The only host-specific datum is the
  thread entrypoint in the entry's `_meta`.
- **State, events and control over one app-only tool**, `side_preview_sync`.
  Events come from a polled viewer in the hub: a poll is held at most a second,
  since a host may run a view's calls one at a time, and a view counts as
  watching for 30 s after its last poll. Every outcome the view acts on is an
  answer, not a tool error.
- **The view's calls are not the agent's.** A tool whose
  `_meta.ui.visibility` leaves out `model` is called by a view: neither the
  activity service nor the request log records it. An activity row would wake
  the view's next poll; a held poll crosses the log's slow-op threshold and
  would show in the status bar as an agent call.
- **The picture is a data channel carrying the page's framed chunks**, from
  the one encoder the page uses. The view offers over `side_preview_sync`; the
  editor answers with its `127.0.0.1` host candidates only, which Chromium
  gathers only under `allow-loopback-in-peer-connection`, and no ICE server.
  An offer before the editor's bridge attached, or one it leaves unanswered
  for 5 s, is answered `not_ready`, and the view asks again. An open channel
  counts as a page showing the picture, so an export still holds it.
- **A blocked picture says so**: a connection that draws nothing within 5 s of
  its answer, or fails first, ends in a message that points at the side
  preview, never a black frame.
- **With the app closed** the view offers to start it (`launch_weftcut`), and
  on the start screen to open the most recent project; both through tools the
  model has too.

Rejected:

- **A media track.** It is what the prototype measured in real ChatGPT, but it
  would be a second encoder beside the page's, and a second picture path to
  keep equal. The data channel reuses the page's stream, framing and keyframe
  gating; the view's `openPicture` is the seam where a track could replace it.
- **JPEG stills over tool calls**: encoded whole per frame and per view, and
  neither a first picture nor a fallback in the prototype.
- **A long-held poll**: a host that serializes a view's calls would hold its
  controls behind it.
- **Gating on the client's name**: host differences are data (ADR 0167), and
  a capability is what the spec says to check.
- **The `@modelcontextprotocol/ext-apps` bundle** in the view: half a megabyte
  for the five messages used.
- **The app alone serving the view**: a session that starts while the app is
  closed would have no entry to open, and nothing to start the app from.

## Consequences

- Whether ChatGPT desktop declares the UI capability for a `config.toml`
  server is not documented. If it does not, the gate must go, in the binary and
  the app alike.
- A session that starts with the app closed lists the sync tool only after the
  app's `tools/list_changed`; the view reaches it by calling, not by listing.
- The view's `launch_weftcut`, `read_project` and `open_project` calls are
  recorded as agent activity, as those tools are for the model.
- A failing sync call leaves no row in the request log either; the view says
  what it can no longer reach.
- The data channel is new in real ChatGPT: the prototype carried a media track
  there. A host that refuses data channels shows the blocked message.
- A change anywhere in the companion UI is a new view address, so a host
  reloads the view after any app update that touched it.
