---
status: accepted
---

# One request for a Motif frame, one job per cache address

Date: 2026-11-09

## Context

A Motif frame was asked for in five renderer places (cursor, prewarmer, frame
service, export, a broker) and deduplicated three times in main: by a string of
the capture inputs, by pending bake receipts, and by the write queue's map of
writes in flight. Priority was inferred from whether a request carried a
coalesce key, and a key was latest-wins: a second request under it superseded
the first, so a shared job could not lose one subscriber without losing all.
Playback asks for about 30 frames a second per visible Motif against one serial
capture host that takes up to a second per frame, so a frame nobody wants any
more must leave the queue, and a frame two requests want must be captured once.
The seams leaked: a display that joined a pending bake waited for its write and
then read the file; two divisors of one frame captured it twice; a capture after
a read miss was neither checked nor stored; and a `stored` answer to it could
send the frame back to a read that missed again, without end.

## Decision

- **One renderer entry.** Every consumer gets a frame through
  `acquireMotifFrame` with its priority (`current`, `ahead`, `background`), an
  abort signal and a lease. Read-else-capture is one loop in its scheduler.
- **One request on the wire.** A capture names itself with a request id and
  states its priority, its cache address, whether main must keep the frame and
  whether the renderer's read of it missed after main answered it `stored`
  (`afterMiss`). A priority change, up or down, and a cancel are controls of
  that id. Nothing is inferred from keys. A withdrawn request is answered
  `superseded`, not thrown: `ipcMain.handle` logs every rejection with its
  stack, and a cancelled capture is routine.
- **Main serves the three priorities in order.** A capture leaves main's
  queue only when a capture host can take its frame, so a `current` request
  goes before lookahead queued earlier; background waiting
  `backgroundAgingMs` gets a frame between higher ones.
- **One job per cache address and workspace store.** Every request that arrives
  before the capture's lease joins it; the capture runs at the highest priority
  left and is cancelled when the last request leaves. Only a display without
  `afterMiss` stats the store first; persistence never does.
- **At the lease everyone is served.** Each display gets pixels (its own GPU
  copy, or one straightened bitmap shared). A persistence request or a kept
  display makes the write one that waits for a slot; otherwise the frame offers
  a live write. Only a kept display waits for the write.
- **After the lease, the write decides.** A later request waits for it: a
  written frame answers a display `stored` and completes persistence; a failed
  or skipped write starts a new job. Every write of an address is its job's.
- **A read miss is checked once, then captured.** The first capture after a
  renderer read miss goes without `afterMiss`, so main stats the store: a
  stale miss of a stored frame is answered `stored` and read again, and
  captures nothing. Only a miss after that answer sends `afterMiss`, which is
  never answered `stored`; it captures and offers a write like any display, so
  a skipped live write leaves the file as it was. The read miss already
  dropped the frame from main's coverage, so preparation counts it as missing.
  The renderer rejects a `stored` reply to `afterMiss` as a `miss` rather
  than reading a third time.
- **Failures by code.** A capture failure with its own code fails every
  request; a texture-output failure before the lease moves the session to
  bitmaps and captures again for all; one in the readback after the lease
  moves the session first and captures again for persistence; a failed write
  costs persistence its frame and never costs a display its pixels.
- Captures without an address (parameter previews, PNGs) are never shared.

## Consequences

- A display joined to a bake gets its pixels at the lease instead of after the
  write and a read, at the cost of one more GPU copy on Windows.
- Two divisors of one frame, and a preview and an export of it, share a capture.
- A stale read miss costs one stat and a second read, not a capture. A
  corrupt stored file costs that too, then one recapture, then backoff, never
  a loop.
- A display joined to a bake that times out fails with it instead of capturing
  again on its own.
- Resources are reserved once per job, when its capture reaches a host,
  borrowed from the plan of the first export in it at that point. A queued job
  holds nothing: at 4K a reservation is about 143 MiB, so jobs charged while
  they wait would be refused `capacity` with no pixels in hand. An export that
  joins later is not charged, which its plan allows: the plan budgets a
  capture in flight per producer frame whether or not that capture is shared.
  A refusal by that plan fails every request in the job `capacity`. The charge
  lasts until the job ends, even when the export has withdrawn, so that
  export's finalization can wait for one capture.
- While an export holds its plan, the editor's own captures are refused
  `capacity` and export frames are charged to the plan. The refusal is answered
  `{ kind: 'capacity', detail }` like `superseded`, not thrown, and the preload
  frame port turns it back into the same `capacity` MotifError: the preview
  cursor and the lookahead back off on the preview retry delays.
- A running capture is never preempted: a cancel during its render still costs
  that render, and the caller drops the result.
- Renderer and main must speak the same wire; both ship in one app build.

Rejected: deduplicating only in the renderer (bakes, exports and documents live
in different places); keeping coalesce keys beside request ids (two ways to
withdraw a capture, and a shared job still lost every subscriber with one).
