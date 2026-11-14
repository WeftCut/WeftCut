---
status: accepted
---

# The preview beside an agent's chat is a page or a side-panel view, never a card in the chat

Date: 2026-11-15

## Context

Someone working with an agent in a desktop host sees the chat, not the edit.
A prototype served a page from the app's MCP loopback listener and mirrored
the preview into it; measured on Windows, macOS and Linux
(`docs/notes/companion-picture-2026-11.md`):

- With a hardware H.264 encoder the mirror costs the editor's preview nothing
  visible; the page shows 15 fps a few milliseconds behind the editor.
- With a software encoder on a 2-core machine it costs about 10 CPU points
  and a worse p99 on a preview already struggling there.
- With the mirror off the page costs nothing measurable.
- A hidden editor window stopped painting unless background throttling was
  off; a minimized one paints about once a second whatever is set.
- The page works in a plain tab, in DeepSeek Harness's sidebar browser and
  in a frame sandboxed to an opaque origin. ChatGPT's side panel cannot fetch
  loopback, and keeps a view by its `ui://` address across app rebuilds.

A card in the chat is too small for an editing view, and the hosts draw one
per call.

## Decision

- **Two surfaces, by what the host offers** (the host table, ADR 0167): a
  view in its side panel, or a page in its side browser. A terminal gets none.
- **One UI, the transport behind a seam.** The page's modules take a
  transport; the loopback one uses fetch and the page key. A side panel that
  cannot reach loopback gets another transport, not another UI.
- **The picture is the editor's own canvas**, which already holds the final
  composite: captured and encoded only while some page shows it and no export
  runs, decoded by the page with WebCodecs. Background throttling is off only
  while it runs.
- **The page key is not the MCP bearer.** It opens the page's data routes
  only, `/mcp` refuses it, it is kept in the profile, and the app reuses its
  port, so an open page finds the app again after a restart. It travels in
  the link's fragment, which no request carries.
- **The page reads; it never edits.** Player controls and bringing the editor
  forward are all it can ask.

Rejected:

- **A card in the chat**: too small, and drawn per call.
- **JPEG stills**: every frame encoded whole, once per page that asks; the
  stream is encoded once for all of them.
- **Drawing the composition a second time** for the page: twice the GPU work
  for the same pixels.
- **The bearer in the link**: a link is pasted and logged; the bearer edits.
- **A cookie session**: a sandboxed frame with an opaque origin has none.
- **A WebSocket**: a browser cannot put a bearer on its handshake.
- **WebRTC in the side browser**: fetch reaches loopback there; WebRTC adds
  address gathering, and over a LAN address it waited on macOS's firewall
  prompt.
- **The `weftcut` binary serving the page**: it would answer while the app is
  closed with nothing to show.

## Consequences

- The picture needs WebCodecs; a browser without them gets the page with no
  picture, and says so.
- If the stored port is taken at the next start, an open page cannot find the
  app; the agent hands out a new link.
- The key is never rotated by itself; revoking it is later work.
- An export takes the picture away while it runs; the page says so.
