---
status: accepted
---

# Stored frames leave the capture lease

Date: 2026-11-05

## Context

Motif capture is one serial chain, and a frame's texture is leased until its
consumer finishes (ADR 0078). Storing a frame inside the lease (readback,
straightening, checking, compression and the file write) delayed the next
capture: on the Windows bench it took about half of a first playback pass. So a
live preview frame was never stored, and every replay captured every frame
again. Storage also had two writers, each with a texture and a PNG branch.

## Decision

- **One write queue owns every stored frame**, whoever captured it. It holds at
  most two frames of pixels and one write per address. Only the source of the
  pixels differs: a texture readback or a bitmap capture. The renderer never
  writes a stored frame; it learns from main whether one was stored.
- **The lease covers the readback, nothing after it.** Encoding and the write
  run after the lease, off the D3D11 worker, so the next readback does not wait.
- **A full queue answers by who asked.** A frame someone asked to keep (bake,
  export) waits for a slot inside its lease, which is the backpressure on
  capture. A frame nobody asked to keep is skipped: it can be captured again.
- **A committed preview frame stores itself** at its cache address, unless both
  slots are taken, memory is under pressure or the cache has no room. Parameter
  previews have no cache address.
- **Every captured frame with a cache address is stored.** *Pre-bake all motif
  content* only decides whether frames nobody has asked for are generated;
  Temporary cache space alone limits the disk. *Baked* means the requested
  range is on disk, however it got there.
- **A failed write costs the cache, never pixels a display already has.** A
  baker learns the frame was not stored; an export uses the pixels and leaves
  the frame uncached; a display does not fail.
- **Live writes ignore *Continue background processing during playback*.** They
  are the tail of a foreground capture and bounded by the two slots; stopping
  them during playback would stop them when they are most useful.

## Consequences

- On the Windows bench, later passes read instead of capturing: the third pass
  of a real project rose from 10.8 to 41.1 new pictures per second, the first
  is unchanged, and full coverage plays at 51 with no Motif pending. On a PNG
  host the first pass is unchanged and a restart starts at 36 instead of 3.7
  ([measurements](../notes/motif-live-store-2026-11-05.md)).
- Warming costs late ticks while capture and reads overlap.
- A preview spends temporary cache space the user did not ask to spend on
  preparation, up to the existing budget.
- Live frames count toward coverage, so bake snapshots flow during playback, at
  most every 100 ms.
- A stored frame is one file for preview and export, so they cannot differ on
  it. A frame not stored yet can still differ by one raster level on
  anti-aliased edges between preview and a later export capture.

Rejected: mapping the staging texture after the lease (a staging ring for about
3 ms of readback at 1080p); stacking capture windows (5 wrong frames in 1,620);
a Windows-only queue beside the PNG writer (the deepest platform branch would
grow).
