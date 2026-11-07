---
status: accepted
---

# Motif captures are pipelined paints

Date: 2026-11-08

## Context

Off Windows, a Motif frame was a CDP screenshot after a settle of two
animation frames, then decoded again to be stored or shown. On a bitmap host
that cost about 161 ms per 1080p frame on the Windows bench and 260 ms on a
2-core Linux box (61 real Motifs). Earlier attempts to take the bitmap paint or
`capturePage` instead returned the previous or a blank frame on a quarter of
captures, because nothing proved which frame a paint showed.

The frame id marker row (ADR 0078) proves it. A Chrome trace of the texture
path then showed where a frame's time goes once its JavaScript has run: the
wait for the next BeginFrame (up to one frame interval), the Motif's canvas
raster replayed on the GPU process main thread (about 10 ms for a light 1080p
Motif), and the copy's completion (about 8 ms). Each frame ran these strictly
after the previous one, so the renderer idled about three quarters of the time.

## Decision

- **Every capture is a leased paint.** Both hosts keep the marker row. A
  texture host leases shared textures; a bitmap host (Linux, macOS, Windows
  after a texture failure) leases the paint's bitmap, straightened natively to
  RGBA for the display and encoded natively for the cache. PNGs for MCP
  previews and covers are encoded from the leased pixels. No capture takes a
  screenshot, and Motifs have no settle setting.
- **Frames are pipelined.** The shell's render returns once the frame's
  rendering step has run; the capture queue then renders the next frame of the
  same page while up to three earlier frames are still on their way to a paint.
  Paints arrive in frame order, so a paint carrying a later id retires every
  earlier expected frame as skipped, and a skipped frame renders again. A
  navigation or resize waits for the frames in flight. The bake coordinator
  keeps up to three frames of its chosen clip in the queue, so background
  preparation reaches the pipeline too, and decides the order again as each
  frame settles.
- **A host window shows one document.** A window's first top-level document
  is the only one a bitmap host paints with real alpha
  (docs/notes/electron-chromium-behavior.md), so another Motif or content
  version gets a new window: the script-free shell loads first, then the
  runtime, then the Motif in the shell's frame. A new window costs about what
  a navigation did.
- **A texture-output failure switches the session to bitmaps**, including a
  failed readback; the frame at hand is captured again as a bitmap. The
  bitmap host keeps 2D canvases on the CPU (ADR 0078).
- The capture host paints at 120 Hz.

## Consequences

- Probe on 61 DECO Motifs, Windows bench (RTX 3050), median per frame: bitmap
  paint 53 ms against 161 ms for the screenshot (0.32×), every verified frame
  identical to a quiet screenshot; pipelined bitmap with CPU canvases 29.6 ms;
  shared texture 39.2 ms one at a time, 21.2 ms pipelined (0.57×). On the
  2-core Linux box the bitmap paint took 74 ms against 260 ms.
- A light Motif is now bound by the frame clock and the GPU process's canvas
  raster; a heavy one by its own JavaScript, which only parallel hosts could
  overlap.
- `capturePage` stays unused: it needed a second try on a quarter of frames
  and failed with `UnknownVizError` on both systems.
- The probe's screenshot cross-check could not see the alpha loss after a
  navigation: the DECO Motifs are opaque and a screenshot keeps alpha. The
  e2e Motifs with transparent backgrounds caught it.
- Real macOS hardware has not run the bitmap lease.
