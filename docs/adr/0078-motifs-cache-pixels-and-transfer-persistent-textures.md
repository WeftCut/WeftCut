---
status: accepted
---

# Motifs cache lossless pixels and transfer persistent textures

Date: 2026-10-27

## Context

ADR 0017's capture output was PNG. On Windows (Electron 44, D3D11), a 1080p
frame read cost ~31 ms as PNG against ~27 ms as LZ4 RGBA: bitmap creation fell
from 27 to 3.3 ms, but 8.3 MB of ordinary IPC ate the gain. Shared OSR texture
capture took 41.6 ms against 63.8 ms for PNG; native bake readback took a dense
1080p Canvas from 169.8 to 76.6 ms/frame
([findings](../../poc/motif-frame-cache/FINDINGS.md),
[bake](../../poc/motif-frame-cache/BAKE-FINDINGS.md)). LZ4 left a 4.0 GB cache
on a 10,337-frame lyric video and a 32 KB floor for a blank 1080p frame; zstd
level 1 was 31–69% smaller on every measured directory at LZ4's encode speed,
0–5 ms slower to decode, and level 3 saved only 2–7% more
([footprint](../../poc/motif-frame-cache/FOOTPRINT-FINDINGS.md)).

A stored frame must give back the captured pixels, and the read must prove its
decompression produced them; the cache is local and disposable, so tampering is
out of scope. BLAKE3 over the pixels cost a second pass on write and read
(4.7 ms at 1080p, 19 ms at 4K). zstd's content checksum adds 0.6 and 3 ms and
rejected every single-bit flip
([checksum](../notes/motif-frame-checksum-2026-11-06.md)).

Electron's offscreen output reports nothing that ties a paint to a commit: no
BeginFrame control, and its paint metadata drops the frame sequence. Native
rAFs fence layout and commit, not the compositor's raster, so waiting a fixed
number of them is a timing guess. The first texture of a new compositor surface
was observed holding the previous or uninitialised surface even after two.
Only pixels drawn by the page travel with the commit that drew them
([probe](../notes/motif-capture-frame-id-2026-11-08.md)).

## Decision

- **One `.wfrm` file per frame.** A 16-byte header (magic, dimensions), the
  band count and each band's length, then straight RGBA8 split into up to
  eight bands of rows, each one zstd level-1 frame with its content checksum,
  which is the frame's only content check. Bands encode and decode in parallel:
  one zstd frame cannot, and at 4K it was the read's largest stage. Threads
  per frame stay few, because three lanes decode at once beside playback. A
  band's rows are a multiple of 4, so a read scales each band by 2 or 4 on its
  own and never holds a whole decoded frame; the band buffers it reuses are
  shared by every reader and bounded. A band without the checksum flag, or a
  frame in another layout, is a miss. Files are independent and atomically replaced.
  Older caches are not read or migrated: the key namespace moves.
- **Windows moves pixels as persistent D3D11 textures.** The core addon (not
  the optional FFmpeg component) owns bounded pools; handles are shared once
  and per-frame messages carry a slot lease. Bakes read the OSR texture on a
  native worker and encode `.wfrm` after the lease (ADR 0158). Straight alpha
  is premultiplied for import, straight into the pool's own staging texture: a
  shared texture cannot be CPU-writable, and the slot's mutex then covers one
  GPU copy. Only a pool that reads stored frames has one, and its budget
  counts it like the slot. The copy completes before the slot is released; leaving the order
  to the keyed mutex alone moves that wait into the consumer's read barrier.
- **A consumer completes the GPU read before acknowledging a slot**; a failed
  or timed-out consumer retires the texture instead of permitting reuse.
  Native pools outlive every Electron import. The consumer lifetime is a
  document: navigation retires its transport generation.
- **A paint is leased by the frame id it carries.** The capture host page is
  a same-origin shell that frames the Motif at the capture size and keeps
  marker rows below it: one, or as many as a picture narrower than the
  marker needs for it to wrap (`shared/motifs/frameMarker.ts`), so the surface
  keeps the picture's width. The
  Motif sees only its own size. After the frame's seek, with no rendering step between, the shell
  writes a fresh 32-bit id with a magic and a check byte into those rows, and a
  2D canvas paints the id's low byte after it (the canvas witness). A new
  window's first commits can carry the id while every canvas of the page is
  missing, and such a commit never fills in, so a paint carrying the id
  without its witness skips the frame and it renders again
  (docs/notes/electron-chromium-behavior.md). Painting stays on; `OffscreenFrames` reads the marker rows of each paint (a
  texture's on a native worker, a bitmap's in main) and leases the first paint
  carrying the id, releasing the rest.
  Copies and readbacks take the rows above them. No settle wait, no
  stop/start of painting, no surface fence: a new document, size or GPU
  process's stale first paint carries no id or an old one. The host renderer
  runs with checker imaging off, so a frame does not draw before its images
  decode.
- **The bitmap host forces CPU-backed 2D canvases** (`willReadFrequently: true`):
  Electron 44 bitmap OSR can omit an accelerated canvas after navigation,
  which exported transparent frames, and the id cannot see a missing layer.

## Consequences

- The cache key namespace (`surface-v7`) discards frames captured before the
  frame id, the canvas policy and the current layout; collection deletes
  their directories unread. Projects re-bake once after a layout change.
- A texture frame costs the page's own work plus one pass through the
  compositor; in a standalone probe on 61 real Motifs it matched the
  settle-and-restart wait it
  replaced (median 48 against 53 ms at 60 Hz) and every checked frame was
  exact. Raising the frame rate gained nothing for one frame at a time: a
  trace splits the time into the wait for the next BeginFrame, the Motif's
  canvas raster on the GPU process main thread and the copy's completion,
  which ADR 0159 overlaps across frames.
- A bitmap host leases its paints the same way (ADR 0159); no capture takes a
  screenshot.
- Content outside the commit — a worker's OffscreenCanvas, video — is not
  covered by the id.
- An older app version finds no frames under its own namespace and captures
  again. The checksum's 32 bits miss about one random corruption in four
  billion; the header is outside it, but a damaged dimension almost always
  changes the byte count, which the read rejects.
- The addon links libzstd on every platform under the glibc floor (ADR 0143).
- Off Windows, and when a slot cannot be used, frames take the utility lane
  (ADR 0154).

Rejected: BLAKE3 over the compressed bytes (cannot see a wrong
decompression); packing a clip into one file (shared mutable index, no gain on the
measured bottleneck); inter-frame deltas (grow moving content, lose frame
independence); unsynchronised texture capture after paint (returned old
surfaces); paint timestamps or counters as the id (rewritten by the capturer);
the id inside the picture, removed by a second frame (25% slower at 60 Hz);
forcing a capturer restart per frame (slower).
