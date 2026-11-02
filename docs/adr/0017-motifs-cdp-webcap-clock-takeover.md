---
status: accepted
---

# Motifs render as web pages captured via CDP, deterministic by clock takeover

Date: 2026-06-10

## Context

An SVG `render(t)` engine bounds authoring to what SVG expresses. An
in-webview HTML route is dead: every `<foreignObject>` raster is
cross-origin-tainted in WebView2 (unreadable, un-encodable, un-uploadable).
The export Worker has no DOM, so whatever produces preview pixels must hand
the Worker finished bitmaps. And a web page runs its own clock, which breaks
scrubbing, re-export and preview == export.

## Decision

- **One capture path for every Motif.** A Motif is a normal HTML/CSS/JS page
  loaded as the top-level document of one reused offscreen Electron
  `BrowserWindow` and captured over the DevTools Protocol via
  `webContents.debugger` — a real browser raster, so taint never applies. No
  per-Motif engine field, no tiering. The portable output is lossless PNG
  from `Page.captureScreenshot` with a transparent backdrop; Windows takes
  shared OSR textures from the same compositor (ADR 0078).
- **Determinism by clock takeover, not cooperation.** The injected runtime
  owns `performance.now` / `Date.now` / timers / `requestAnimationFrame` and
  seeks CSS/WAAPI animations (`getAnimations()`, pause + `currentTime`, never
  cancel or commit, so seeking back works). A Motif is a pure function of `t`
  and never advances itself. 2D/DOM captures at a fixed `t` are byte-identical
  across runs and across Windows/Linux/macOS.
- **Window-as-isolation.** Isolation is the dedicated offscreen window, no
  preload / Node on the `motif:` origin, and a `default-src 'none'` CSP
  (offline) — not an inner sandboxed iframe.

## Consequences

- Capture is round-trip-bound, not pixel-bound: warm sustained capture
  measured ~92 ms/frame (~11 fps) at any resolution (120² ≈ 960²). A
  low-resolution live tier buys nothing, so preview is a RAM-preview model
  (on-demand L0, lookahead L1, persisted L2) whose cost is managed by
  content-frame reuse, not a second renderer.
- Export reuses the same captures: main captures, the Worker receives
  bitmaps; preview pixels equal export pixels by construction.
- GPU-rendered scenes (WebGL, KTX2 transcoding to hardware formats) are
  repeatable per machine, not bit-identical across GPUs. The authoring
  contract (absolute `t`) still holds.

Rejected: engine tiering (three renderers to keep pixel-consistent);
real-time screen capture (no scrubbing, export bound to wall clock);
record-once-then-replay (realtime-bound bake, full re-bake per prop edit;
Remotion and timecut reached the same conclusion); inner opaque-origin iframe
(awkward asset delivery for no isolation gain over the offline window).
