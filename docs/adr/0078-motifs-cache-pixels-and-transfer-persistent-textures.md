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

The first texture captured from a new compositor surface can be the previous
or uninitialised surface even after two native rAFs: rAFs fence layout and
commit, not the compositor's raster.

## Decision

- **One `.wfrm` file per frame.** 52-byte header (magic, dimensions, codec,
  BLAKE3 of the pixels) + straight RGBA8, written as codec 2 (zstd level 1);
  codec 1 (LZ4) stays readable. Files are independent and atomically replaced.
  PNG caches are ignored and regenerate; there is no migration.
- **Windows moves pixels as persistent D3D11 textures.** The core addon (not
  the optional FFmpeg component) owns bounded pools; handles are shared once
  and per-frame messages carry a slot lease. Bakes read the OSR texture on a
  native worker and encode `.wfrm` directly. Straight alpha is premultiplied
  for import.
- **A consumer completes the GPU read before acknowledging a slot**; a failed
  or timed-out consumer retires the texture instead of permitting reuse.
  Native pools outlive every Electron import. The consumer lifetime is a
  document: navigation retires its transport generation.
- **A texture is leased only from a proven surface.** `OffscreenFrames` fences
  each new surface — main-frame navigation, size change, GPU process restart —
  with one full `Page.captureScreenshot` readback, and never fences a frame on
  a proven surface. A clipped readback is not a fence.
- **The PNG host forces CPU-backed 2D canvases** (`willReadFrequently: true`):
  Electron 44 bitmap OSR can omit an accelerated canvas after navigation,
  which exported transparent frames.

## Consequences

- The cache key namespace (`surface-v3`) discards frames baked before the
  surface fence and the canvas policy.
- One readback per navigation, size change and GPU restart.
- Older app versions read codec 2 frames as corrupt and re-render them.
- The addon links libzstd on every platform under the glibc floor (ADR 0143).
- Off Windows, and when a slot cannot be used, frames take the utility lane
  (ADR 0154).

Rejected: packing a clip into one file (shared mutable index, no gain on the
measured bottleneck); inter-frame deltas (grow moving content, lose frame
independence); unsynchronised texture capture after paint (returned old
surfaces).
