---
status: accepted
---

# Frames cross processes on two carriers, and one host owns every session

Date: 2026-11-18

## Context

Decoded frames leave the main process four ways: preview bytes (software and
copy-back hardware), preview shared textures (d3d11va), export-decode bytes,
and Motif's shared textures. Each had its own channels, message types copied
by hand between Rust, main, preload and renderer, its own teardown order and
its own "the window that asked is gone" cleanup. Their contracts lived in
comments: which message may overtake which, who may return a credit, that an
untagged texture belongs to the announce before it.

Measured on this stack
([`byte-frame-transport-2026-11-18`](../notes/byte-frame-transport-2026-11-18.md)):

- A frame that crosses `contextBridge` is copied on the page's main thread.
  Two 4K software streams played at 17 fps on Windows for that reason alone.
- Posting a frame on a `MessagePortMain` costs main 1.6× (Windows) to 2.3×
  (macOS) a `webContents.send` of the same bytes; a 4K native-decode export
  ran 10 % slower with it.
- The spike behind ADR 0029's "classic IPC is fastest" ran without context
  isolation and never paid the bridge copy.

## Decision

- **Two carriers.** *Bytes*: an owned buffer and a lease the consumer returns
  by id. *Slots*: a pooled shared texture named by slot and generation, read
  and then released. A producer speaks one message type, `DecodeMsg`, defined
  in Rust and generated into TypeScript.
- **A pipeline keeps only its driver**: preview chases a target, export covers
  a range, Motif pulls by address. Sessions run on one native runtime
  (registry, thread, bounded close, panic → one terminal error).
- **One host in main** admits a session (one per id, its reservation held
  until it closes), serves it on one port and ends it once: on `close`, or
  when the document that asked goes away. The port is created by the
  admission, never before it, so an open refused for any reason leaves no
  port behind. The preload likewise refuses an id it already holds, and a
  failed open undoes only what it created.
- **Main sends with `webContents.send`; the preload holds the session's port**
  and posts each message on to the consumer with the frame transferred.
  Nothing crosses `contextBridge`, and frames never ride a `MessagePortMain`.
- **`close` goes by session id on the route opens take.** A port carries
  per-frame traffic only. Two routes to main are not ordered against each
  other: a close sent up a port arrived behind the next open, which main then
  refused while the old session still held its memory.
- **A shared texture travels with its tag**, and one reader in the preload
  maps tags to imports for video and Motif alike.
- **A slot is released when the page's own GPU queue has run the read.** The
  one-pixel readback is the fallback where there is no such queue.

## Consequences

- The channel verdict of ADR 0029 and the credit paragraph of ADR 0033 are
  rewritten there to match.
- A new byte or texture producer needs a driver and a spec for the host, not a
  protocol.
- Receiving a byte frame still costs the page a deserialization. A worker
  between the preload and the page, or a producer outside main, removes it in a
  decode-free probe; neither is built or measured end to end.
- Motif's pool policy (adoption, retirement, budget waits, leases) and the
  encode exit's frame window stay where they are: they are policies, not
  transport.
