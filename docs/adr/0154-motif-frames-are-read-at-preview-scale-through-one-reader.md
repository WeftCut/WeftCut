---
status: accepted
---

# Motif frames are read at preview scale through one reader

Date: 2026-10-30

This revises ADR 0078's CPU path: off Windows, baked Motif frames no longer
cross IPC as full straight RGBA.

## Context

ADR 0078 moved baked Motif frames off PNG so that Windows could upload them
into persistent D3D11 slots without sending pixels over IPC. Other platforms
kept a CPU path. On that path `motif:read` returns the whole decoded frame as
straight RGBA, and the preload builds an `ImageBitmap` from `ImageData` on the
renderer main thread. At 4K a frame is 33,177,600 bytes.

Issue #89 reported macOS stalls with cached 4K Motifs. An M1 run on `ebadd5e0`
(issue #62) located the cost:

- Playback had 271 / 284 / 334 late frames at Full / 1/2 / 1/4, and 0 with the
  Motif hidden. Playback Resolution did not help, because a Motif frame arrives
  at full size whatever the preview shows.
- A 4K Motif in the root composition had 381 late frames, and the same Motif at
  1080p had 0. Color-only Groups had 0. A larger Motif cache did not help (341):
  linear playback reads each frame once, so the cost is the read itself.

Video already handles this. `DecodeTransport` hides the lane behind one seam,
and Playback Resolution becomes a divisor (`playbackScaleDiv`) applied before
frames cross the process boundary. Motif reads have no such seam. A read can
take three routes:

- the `motif:read` handler, with the texture lane or the store's RGBA
  fallback;
- `MotifFrameCache.readBitmap`, which catches any failure and reads again;
- `motif_read_cached_frame`.

Choosing a lane, falling back and leasing textures are spread across
`frameTransport.ts`, `preload/motifFrames.ts`, `MotifFrameStore`,
`MotifGpuTransport` and the cache.

### Measurements

A fair comparison was run on the bench in `test/issue-62-fair-transport`
(`b94cd511`; results in issue #62).

- Every lane ran in one app on the same 4K frames, verified BLAKE3 and scaled
  with the same filter.
- Content: sparse, typical (about 1 MB per frame) and dense (32.5 MB, close to
  incompressible).
- Every lane produced exact pixels and rejected a corrupted frame.

Typical content, latency p50 / page main-thread time p50 / throughput with three
reads in flight:

| Lane | Windows (i5-13400, RTX 3050) | macOS (M1, 8 GB) |
| --- | --- | --- |
| Today: full RGBA IPC | 71 ms / 31 ms / 20 fps | 52 ms / 16 ms / 33 fps |
| Today: Windows texture lane | 71 ms / 0.7 ms / 34 fps | — |
| Texture lane, native downscale before upload (1/2) | **50 ms / 0.6 ms / 49 fps** | — |
| Native downscale in main, scaled RGBA over `ipcRenderer` (1/2) | 52 ms / 8 ms / 42 fps | 48 ms / 4.4 ms / 52 fps |
| Renderer worker: WASM zstd + BLAKE3 + JS scale (1/2) | 95 ms / 0.9 ms / 18 fps | 96 ms / 0.4 ms / 21 fps |
| Main posts scaled pixels on a `MessagePortMain` to a renderer worker (1/2) | 54 ms / 0.1 ms / 41 fps | 50 ms / 0.08 ms / 51 fps |
| **Utility process posts scaled pixels on a `MessagePortMain` to a renderer worker (1/2)** | 55 ms / 0.1 ms / 40 fps | **50 ms / 0.08 ms / 51 fps** |

Other results:

- **Dense content.** The utility lane reaches 24 fps on Windows and 32 fps on
  M1. The scaled texture lane reaches 28 fps.
- **Native stage costs at 4K.**

  | Stage | Windows | M1 |
  | --- | --- | --- |
  | zstd | 6–34 ms | 3–31 ms |
  | BLAKE3 | 8 ms (AVX) | 20 ms (NEON) |
  | Downscale | 12–17 ms | 11–12 ms |

- **In WASM and JS.** BLAKE3 took 38 ms. The downscale took 32–93 ms.
- **Posting from main's own thread.** Serializing each reply took 37 ms on
  Windows and 12 ms on M1.

## Decision

- **One reader owns every stored-frame read.** The renderer gets a
  `MotifFrameReader` with one operation: read `(cacheKey, frame, scaleDiv)`.
  It returns an `ImageBitmap`, or null when the frame is not stored or is
  invalid.
  - Lane choice, process and worker lifetime, verification, downscaling,
    texture leases and fallback stay behind it.
  - `MotifFrameCache`, preview, scrubbing, export and export finalization call
    only this operation.
  - Live capture (a frame rendered by the offscreen page because it is not
    baked yet) is not a read. It keeps its current path and its full size.
- **One native core does the work.** It reads the file, decompresses it
  (zstd, and LZ4 for old frames), verifies BLAKE3 over the pixels and
  downscales. Only the last step differs by platform:
  - **Windows**: the texture lane. The core runs on the pool's native thread,
    then premultiplies and uploads a scaled frame into a slot sized for the
    divisor. The renderer receives a slot key, as today.
  - **macOS and Linux**: a utility process. The core runs there, and the
    process posts scaled straight RGBA on a `MessagePortMain` to a renderer
    worker. The worker makes the `ImageBitmap`. Neither main's thread nor the
    page's main thread touches pixels.
  - Linux was not measured. It follows macOS because the mechanism is the same
    Electron and Chromium code, and it is measured with the same bench after
    the change.
- **Windows falls back to the utility lane, and nothing else remains.** If a
  texture slot cannot be used (GPU budget, a failed import), the read goes
  through the utility lane, which starts on first use. The
  following are deleted in the same change:
  - full RGBA over `motif:read`;
  - the preload's `ImageData` path;
  - the catch-and-retry in `MotifFrameCache.readBitmap`;
  - `motif_read_cached_frame`.

  There is no flag and no intermediate lane.
- **Main stays the authority on addresses and coverage.**
  - Requests name `(hash, frame, scaleDiv)`, never a path.
  - Main gives the utility process the current raster root together with the
    workspace generation, and replaces both on a workspace switch.
  - The utility builds the path under that root, with the same address check
    as `MotifFrameStore`.
  - Requests go from the renderer worker straight to the utility process; main
    is not on the read path.
  - A frame that is absent or fails verification is reported back to main
    with the generation. Main drops it from coverage and admits a replacement
    capture (ADR 0144), as a read in main does today. A report from an older
    generation is ignored.
- **One utility process serves the app.**
  - Every window shares it. It starts on the first read (on Windows, on the
    first fallback).
  - Each renderer document gets its own port; a reload or navigation retires
    the port, as texture leases are retired today.
  - After a crash it restarts with backoff and a log line, without a dialog.
- **At most three reads are in flight per document**, as on the texture lane
  today. macOS and Linux use one renderer worker per document.
- **A transport failure is not a miss.** If the utility process exits, or a
  port or slot fails, the reader restarts the lane and retries. It does not
  return null, because null would drop a good frame from coverage and
  re-capture it. If the retry fails too, preview keeps the previous frame and
  export fails with an error. Neither marks the file bad.
- **Preview reads at Playback Resolution.**
  - The divisor comes from `playbackScaleDiv`, the same 1 / 2 / 4 that video
    uses. Export and finalization reads always use 1.
  - Downscaling is an alpha-weighted box filter, so transparent texels do not
    darken edges.
  - The output size is the input size divided by the divisor and rounded up.
    A partial edge block averages only the texels it covers. Windows slots are
    allocated at the rounded size.
  - The fit fraction is not followed: divisors stay discrete and bound the
    cache.
- **The divisor is part of the frame's identity in L0.** A 1/2 bitmap and a
  full bitmap of the same frame are different entries. A resolution change
  misses and refills; it does not clear the cache. A stored read matches only
  its exact divisor: until the new frame arrives, preview keeps the previous
  frame, as on any miss. A live capture is full size, the only size that frame
  exists in, so its entry serves every divisor; asking again at the divisor
  would only capture it again.
- **`MotifSprite` keeps the Motif's logical size.** A smaller bitmap is drawn
  at the manifest width and height, so geometry, anchors and the gizmo do not
  change with the divisor.
- **BLAKE3 stays.** Inventory is stat-only (ADR 0144), so the read is the only
  content check. Native verification costs 8–20 ms at 4K. The `.wfrm` format,
  its header and the zstd codec (ADR 0145) are unchanged.
- **The reader reports diagnostics in `perf.motifs`.** It reports:
  - the lane used;
  - the number of Windows fallbacks;
  - transport failures and restarts;
  - the current divisor;
  - median stage times: file read, decompression, verification, downscale,
    and upload or bitmap.

  These are internal perf snapshots, not UI.

### Rejected

- **Decoding in a renderer worker with WASM.** WASM BLAKE3 and a JS downscale
  cost more than the IPC they save. Dense frames still cross the page's main
  thread, which cost 18 ms per frame.
- **Posting from main's own thread.** Serializing into the port costs that
  thread 12–37 ms per frame.
- **Scaled RGBA over today's IPC.** Its throughput is the same, but it costs
  4–8 ms of the page main thread per frame for each Motif. It is not kept as
  a step on the way.
- **The utility lane on Windows too.** On Windows the scaled texture lane is
  faster (49 against 40 fps on typical content, 28 against 24 on dense
  content). The texture pool stays anyway for live capture.

## Consequences

- No lane sends full-size pixels to the page's main thread, and nothing sends
  raw RGBA over `ipcRenderer`.
- 1/2 and 1/4 preview cut Motif upload and L0 memory by 4× and 16×. L0 holds
  proportionally more frames at reduced preview.
- The change is complete when:
  1. One conformance suite passes on every lane, including the Windows
     fallback, and on all three CI platforms. It checks:
     - exact pixels against the reference downscale;
     - rejection of corrupt or truncated frames, with the miss reported to main;
     - transport failure kept distinct from a miss;
     - reports from an older generation ignored.
  2. The #62 playback cases on M1 show late frames and `perf.motifs` lag near 0
     for a 4K Motif in a Group at 1/2.
  3. The same cases on Windows do not regress. The run records whether the
     30 / 70 ms split remains.
  4. The removed paths are gone from the code: the `rgba` kind of `motif:read`,
     `motif_read_cached_frame` and the preload `ImageData` path.
- The utility process is a new long-lived process. It loads the native addon
  and has to be restarted after a crash.
- At Full, preview still reads 33 MB per 4K frame. The utility lane moves that
  work off the page but is not faster (M1: 64 ms, 32 fps on typical content).
- Follow-ups, not part of this change; each gets its own ticket after the
  numbers are re-measured:
  - BLAKE3 is the largest stage on M1 (about 40% of the latency). It could run
    on several threads or overlap with the downscale.
  - The downscale is scalar and could use SIMD or split rows across threads.
- Group and transition render targets still allocate at resolution 1. That is
  a separate decision.
- The Windows 30 / 70 ms read split seen in playback (issue #62) is not
  explained yet. The keyed-mutex wait is ruled out (0.1 ms). Most of the
  full-size cost comes after the upload, in the GPU-process copy and the read
  barrier. It is re-measured once the scaled lane is in place.
