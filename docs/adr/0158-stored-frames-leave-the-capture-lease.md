---
status: accepted
---

# Stored frames leave the capture lease

Date: 2026-11-05

## Context

Motif capture is one serial chain, and a frame's texture is leased until its
consumer finishes (ADR 0078). A stored frame spent that lease on readback,
straightening, BLAKE3, zstd and the file write, so one frame's disk work delayed
the next frame's capture. That is why a live preview frame was never stored: on
the Windows bench, storing it inside the lease took about half of a first
playback pass. Replays therefore captured every frame again.

Storage itself was written twice, in `captureDisplay` and `persistFrame`, each
with a texture branch and a PNG branch.

## Decision

- **One `MotifFrameWriteQueue` owns every stored frame.** Its one operation is
  `offer(store, address, mode, read)`. It holds at most two frames of pixels and
  one write per address and store. Only the source of the pixels differs: a
  texture readback or PNG bytes.
- **The lease covers the readback, nothing after it.** `read` runs inside the
  lease and returns the step that encodes and stores. Native pixels stay native
  (`MotifTextureEncoder.read` → `MotifRawFrame.finish`), and encoding leaves the
  D3D11 worker so the next readback does not wait for it.
- **A full queue answers by who asked.** A frame someone asked to keep (bake,
  export) waits for a slot inside its lease, which is the backpressure on
  capture. A frame nobody asked to keep is skipped: it can be captured again.
- **A committed preview frame on the texture path stores itself** at its cache
  address, unless both slots are taken, memory is under pressure or the cache has
  no room. Parameter previews have no cache address. PNG hosts store nothing live:
  their cost is unmeasured and they have no readback to separate.
- **A failed write costs the cache, never pixels a display already has.** A
  display no longer fails on a disk error; `persisted: false` tells a joined baker
  and the export's PNG fallback what happened, and `bakeOptional` is gone. A baker
  sees the error itself. A readback failure keeps its existing PNG fallback.
- **Live writes ignore *Continue background processing during playback*.** They
  are the tail of a foreground capture and bounded by the two slots; a setting
  that stops them during playback would stop them when they are most useful.

## Consequences

- Playback of a real 15 s project with 58 Motifs, cold cache, Windows bench, four
  interleaved runs per side, new pictures per second (median of each pass): first
  pass 8.9 → 8.5, second 11.6 → 20.0, third 10.8 → 41.1. Ticks with a Motif not
  ready on the third pass fell from 863 to 154 of 900. No frames dropped on either
  side.
- Warming costs late ticks, the count the preview's dropped-frames indicator shows:
  about 35 per pass before, 41, 60 and 66 now, while capture and reads overlap. Once
  coverage is complete the same project plays at 51 pictures per second with no
  Motif pending and 0–1 late ticks (fifth to seventh pass, one run).
- Readback in the lease costs about 3 ms at 1080p (map 1 ms, copy out 2 ms).
- Live frames count toward coverage, so `motif:bake` snapshots now flow during
  playback, at most every 100 ms.
- A preview uses temporary cache space the user did not ask to spend on
  preparation, up to the existing budget. It stops growing there.
- `motif-bake.spec.ts` requires a live frame to equal a baked frame at its address,
  byte for byte, on content the GPU rasterises the same way every time. Anti-aliased
  content does not: another project or launch can put one edge pixel of a Motif's
  text a level away (alpha 204 or 205), on bakes (2 of 6 launches) and live captures
  (3 of 6) alike. A stored frame ends this for the frames it covers, since preview
  and export then read one file. A frame not stored yet can still differ by that level
  between preview and a later export capture, as it could before.

Rejected: mapping the staging texture after the lease, as OBS does a frame later
(it needs a staging ring and proof that a released texture stays intact, and
is worth it only if readback dominates what remains in the lease); stacking
several capture windows (2–4 windows gave 5 wrong frames in 1,620, cause unknown);
a Windows-only queue beside the PNG writer (the deepest platform branch would grow).
