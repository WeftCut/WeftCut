---
status: accepted
---

# Motif frames are read at preview scale through one reader

Date: 2026-10-30

## Context

Off Windows, a stored Motif frame crossed `motif:read` as full straight RGBA
(33,177,600 bytes at 4K) and became an `ImageBitmap` from `ImageData` on the
page's main thread. On an M1 (issue #89, data in #62) a cached 4K Motif gave
271 / 284 / 334 late frames at Full / 1/2 / 1/4 and 0 when hidden; the same
Motif at 1080p gave 0; a larger cache did not help (linear playback reads each
frame once). Playback Resolution did nothing because frames always arrived at
full size. Lane choice, fallback and leasing were spread across five modules
with three read routes, one of which caught any failure and read again.

A bench comparison (`test/issue-62-fair-transport`, `b94cd511`) ran every lane
in one app on the same 4K frames with exact pixels and corrupt-frame rejection.
Typical content (~1 MB/frame), latency p50 / page main-thread p50 / throughput
with three reads in flight:

| Lane | Windows (i5-13400, RTX 3050) | M1 8 GB |
| --- | --- | --- |
| Full RGBA IPC | 71 ms / 31 ms / 20 fps | 52 ms / 16 ms / 33 fps |
| Texture lane, native downscale 1/2 | **50 ms / 0.6 ms / 49 fps** | — |
| Scaled RGBA over `ipcRenderer` 1/2 | 52 ms / 8 ms / 42 fps | 48 ms / 4.4 ms / 52 fps |
| Renderer worker, WASM zstd + BLAKE3 + JS scale 1/2 | 95 ms / 0.9 ms / 18 fps | 96 ms / 0.4 ms / 21 fps |
| Utility process → `MessagePortMain` → renderer worker 1/2 | 55 ms / 0.1 ms / 40 fps | **50 ms / 0.08 ms / 51 fps** |

Native 4K stage costs: zstd 3–34 ms, BLAKE3 8 ms (AVX) / 20 ms (NEON),
downscale 11–17 ms. In WASM/JS, BLAKE3 took 38 ms and the downscale 32–93 ms.
Posting from main's own thread cost it 12–37 ms per frame to serialize.

## Decision

- **One reader owns every stored-frame read.** `MotifFrameReader` (one per
  document) has one operation, read `(cacheKey, frame, scaleDiv)` →
  `ImageBitmap`, or null when the frame is absent or invalid. Preview,
  scrubbing, export and finalization call only this. Live capture is not a
  read and stays full size.
- **One native core** reads, decompresses, verifies BLAKE3 and downscales.
  Only delivery differs: Windows uploads the scaled frame into a texture slot
  sized for the divisor (ADR 0078); macOS and Linux run the core in one
  app-wide utility process that posts scaled RGBA on a `MessagePortMain` to a
  per-document reader worker, which makes the bitmap. Windows falls back to
  the utility lane when a slot cannot be used. Full RGBA over IPC, the preload
  `ImageData` path, catch-and-retry and `motif_read_cached_frame` are gone.
- **Main stays the authority on addresses and coverage.** Requests name
  `(hash, frame, scaleDiv)`, never a path; the utility resolves it under the
  raster root and workspace generation main gives it, with `MotifFrameStore`'s
  address check. Misses go to main with the generation; stale generations are
  ignored. Main is not on the read path.
- **A transport failure is not a miss.** The reader restarts the lane and
  retries once; then preview keeps its previous frame and export fails.
  Null would drop a good frame from coverage and re-capture it.
- **Preview reads at Playback Resolution** (`playbackScaleDiv` 1 / 2 / 4);
  export and finalization read at 1. Alpha-weighted box filter, output size
  rounded up. The divisor is part of the L0 identity; a live capture serves
  every divisor. `MotifSprite` draws at the Motif's logical size.
- **At most three reads in flight per document.** BLAKE3 stays: inventory is
  stat-only, so the read is the only content check.

## Consequences

- No lane sends full-size pixels to the page's main thread. 1/2 and 1/4 cut
  Motif upload and L0 memory 4× and 16×. At Full the utility lane moves the
  work off the page but is not faster (M1: 64 ms, 32 fps).
- A new long-lived utility process loads the native addon and restarts with
  backoff after a crash. Diagnostics appear as `motifReader` in the
  compositor perf snapshot.
- Open: BLAKE3 is ~40% of M1 latency and the downscale is scalar; the Windows
  30 / 70 ms read split seen in #62 (post-upload GPU copy) is unexplained.

Rejected: WASM decode in a renderer worker (slower than the IPC it saves;
dense frames still cost the page 18 ms); posting from main's thread;
scaled RGBA over `ipcRenderer` (4–8 ms of page main thread per frame per
Motif); the utility lane on Windows (49 vs 40 fps typical, 28 vs 24 dense).
