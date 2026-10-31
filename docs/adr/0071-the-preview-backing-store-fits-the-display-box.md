---
status: accepted
---

# The preview backing store fits the display box

Date: 2026-09-11

## Context

The preview used the composition as both its logical and its physical size,
and CSS contain-fit the canvas into the panel. A 1080p composition in a
~600 px panel was drawn at 1920×1080 and then shrunk about 3× by the browser
compositor. That blit is a 2×2 bilinear tap with no mip chain. Glyph strokes 3–4
composition pixels wide came out one display pixel wide, uneven and soft.
Export, read back at 1:1, was sharp. No Pixi-side setting can reach a shrink
the browser applies after Pixi has finished.

Measured on a white 40 px title, 1080p composition, DPR 1.1: when the buffer
was fitted but CSS still owned the box, the buffer was one device pixel
narrower than the box and its origin was half a pixel off the grid. That
halved the share of fully lit glyph pixels. Writing the box from the buffer
fixed it. Rounding a still text layer to the buffer grid then raised the share
from 36 % to 56 %.

## Decision

- The renderer resolution is `min(1, scale, knob)`. Here `scale` is the zoom
  (or the fit while the view is Fit), and `knob` is the playback resolution.
  The logical size stays the composition. The cap at 1 means the preview never
  shows detail the export cannot have. The knob caps the fit rather than
  multiplying it, and the decode divisor stays the knob's alone.
- `PixiPreview` observes the host (not the canvas) with `ResizeObserver` in
  `device-pixel-content-box` terms and floors to whole device pixels. Below a
  fit of 1, the canvas box is written inline from the buffer, centred and
  snapped to device pixels (`fittedCanvasBox`), so the compositor's blit is a
  copy.
- `TextSprite` sets `roundPixels` only while a layer is still and unrotated.
  Moving text keeps sub-pixel motion. Export never snaps.
- The composition size is held in `logicalSizeRef`. `app.screen` and
  `renderer.width/height` are fractional below fit 1 and are never read as
  the composition size.

## Consequences

- Text is rasterized at display density. Video is downscaled by Pixi's
  sampler instead of the browser's (same bilinear class).
- A panel resize or DPR change re-rasterizes every `Text`.
- Readbacks pinned to `resolution: 1` (colour picker, E2E samples, conformance
  PNGs) and filter intermediates stay composition-sized, so kernels match
  export.
- A 4K composition in a 960×540 panel rasterizes 16× fewer fragments at Full.

Rejected: MSDF `BitmapText` (needs per-font atlases, partial outline and
shadow support, breaks parity with export); mipmaps on text (cannot reach the
browser's shrink); per-`Text` resolution below 1 (two resamples); scaling the
stage instead (moves every consumer off composition coordinates);
unconditional `roundPixels` (slow slides step); knob as a fraction of the fit
(on a 693 px panel, 1/2 became a 2× upscale).
