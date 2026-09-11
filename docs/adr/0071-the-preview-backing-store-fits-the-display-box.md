---
status: accepted
---

# The preview backing store fits the display box

The preview canvas rasterizes at the density it is shown at: its backing store
is sized to the device pixels the panel offers, capped at the composition's
own size, and the Playback Resolution knob divides that rather than the
composition. Below the cap the canvas element is placed so that buffer and
screen box coincide pixel for pixel; a text layer that stands still lands its
glyphs on that grid. The composition stays the LOGICAL size throughout; only
`renderer.resolution` and the canvas's box move.

## Context

The preview kept the composition as both its logical and its physical size:
`renderer.resize(composition, composition, knob)` with the knob at 1, 0.5 or
0.25, and CSS contain-fit the canvas into the panel. A 1080p composition in a
~600 px panel was therefore drawn at 1920×1080 and shrunk three-fold by the
browser's compositor, whose canvas blit is a 2×2 bilinear tap with no mip
chain: at that ratio most source pixels are skipped, and glyph strokes of three
or four composition pixels came out one display pixel wide, uneven and soft.
Video hides this in photographic content; text does not. The export, drawn at
composition size and read back 1:1, was sharp, so the softness read as a
preview defect.

Pixi's `Text` rasterizes its glyphs at `fontSize × renderer.resolution` and
re-rasterizes on the `resolutionChange` runner. At a resolution of 1 the
glyphs were exactly composition-sized; every later shrink was resampling.
Nothing Pixi-side could reach the browser's shrink, and nothing browser-side
could be asked to prefilter it.

Measured on the way to the decision (white-on-black 40 px title, 1080p
composition, DPR 1.1): with the buffer fitted but the CSS box left to
contain-fit, the buffer landed one device pixel narrower than its box and the
box's origin half a device pixel off the grid, and the compositor's resample
halved the share of fully-lit glyph pixels against the buffer's own. With the
box written from the buffer and snapped, screen and buffer read identically.
Rounding a still text layer's position to the buffer grid then raised that
share from 36 % to 56 %.

## Decision

- **The buffer follows the room the host offers.** `PixiPreview` observes its
  host element with a `ResizeObserver` (registered in `device-pixel-content-box`
  terms so a DPR change fires it as a panel resize does), takes the room as the
  host's CSS box times the ratio floored to whole device pixels — never rounded
  up past a fractional box, whose `max-height: 100%` would clamp a taller
  canvas and squeeze the blit — and hands `renderer.resize` the composition's
  size with a resolution of `displayFit × knob`, the fit being the limiting
  axis of room over composition. A 0×0 reading (a hidden dock tab) is skipped
  so the last good fit outlives the hide.
- **Below a fit of 1 the canvas box is written from the buffer.** The box is
  the buffer's own size in device pixels, centred in the host and snapped to
  whole device pixels in absolute coordinates (`fittedCanvasBox`), as inline
  `position/left/top/width/height` on the canvas. The compositor's blit is then
  a copy, not a resample. This is why the HOST is observed and not the canvas:
  a box that is written from the fit cannot report the room it has.
- **Capped at 1.** The preview must not show detail the export cannot have: a
  720p composition in a wide panel is drawn at 720p and upscaled, as every NLE
  program monitor is above 100 %. At the cap the inline box is removed and CSS's
  contain-fit owns the canvas as before. The cap also makes a panel larger than
  its composition the exact pre-fit path, byte-identical, which is what keeps
  the E2E pixel gates — whose compositions are small — out of the blast radius.
- **The knob caps the fit: `min(fit, knob)`.** Pixels above the fit are never
  displayed, so a knob that only trimmed those would trim nothing visible and
  save next to nothing — the buffer is already the panel's size, and the knob's
  real saving, the decode divisor, applies regardless. A knob below the fit
  shrinks what is displayed; the box stays the fit's size and the browser
  upscales the smaller buffer into it — the pre-fit look of 1/4 on a small
  panel and of every setting on a large one. Premiere's program monitor
  behaves the same way: 1/2 looks like Full until the monitor is big enough to
  show the difference. The decode divisor keeps the knob's meaning alone
  (Full 1, 1/2 2, 1/4 4); the fit does not thread into `OutScale`.
- **A still text layer snaps to the buffer grid, in preview.** A glyph texture
  drawn at a fractional buffer position is resampled by up to half a pixel, so
  `TextSprite` turns Pixi's `roundPixels` on while a layer's position is the
  same as on the previous frame and off from the frame it changes, so a slow
  slide keeps sub-pixel motion and never steps. Rotation opts out (the quad's
  corners would round independently and shear). Export never snaps: it draws
  at composition resolution, where nothing is resampled and rounding would only
  move a title from where it was authored.
- **The composition size is the composition's.** Below a fit of 1 Pixi
  redefines the renderer's logical size as `pixels / resolution`, a fraction
  of a pixel off the composition — invisible on screen, wrong in a number.
  `PixiPreview` holds the composition's integers itself (`logicalSizeRef`) and
  never reads `app.screen` or `renderer.width/height` for the Compositor's
  size, `containMap`, or an extract frame.

## Consequences

- Text and caption glyphs are rasterized at the density they are displayed at
  and, while still, land on the pixels they are displayed on. Video frames are
  downscaled by Pixi's sampler instead of the browser's, the same bilinear
  class, so no regression there — and a mip chain on the video textures would
  now be read, where before it could not be (the sampler was at 1:1; the shrink
  happened after it).
- A panel resize or DPR change re-rasterizes every `Text` in the scene. The
  observer only calls `resize` when the host's device box or origin actually
  changed.
- A host that moves without changing size is not observed; its origin is
  re-read on the next size change. Window moves are whole device pixels and
  do not disturb the snap.
- Below a fit of 1 the canvas box can sit up to one device pixel inside the
  ideal contain box on one axis and half a pixel off centre; the E2E layout
  gate allows that pixel.
- Readbacks pinned to `resolution: 1` (colour picker, E2E `sampleComposite`,
  conformance PNGs) stay composition-sized. Text glyphs in such a read are the
  preview-density textures upsampled, the same property Half and Quarter
  already had. Filter intermediates stay at resolution 1
  (`Filter.defaultOptions`), so a texel-addressed kernel is identical in
  preview and export.
- The preview no longer rasterizes pixels the panel cannot show. For a 4K
  composition in a 960×540 panel that is 16× fewer fragments at Full.
- `app.screen` is not the composition size any more. A reader that wants the
  composition must take it from the composition.

## Considered options

- **MSDF `BitmapText`** — resolution-independent glyph edges, but it needs a
  pre-generated atlas per font, cannot take an arbitrary system font, supports
  outline and shadow only partially, and rasterizes differently from the
  export's canvas text, breaking preview/export parity.
- **Mipmaps on the text textures** — a Pixi-side sampler setting cannot reach a
  shrink the browser performs after Pixi is done. Without the fit it changes
  nothing; with it, text needs no mipmaps because nothing is shrunk.
- **A per-`Text` `resolution` below 1 with the buffer left at composition
  size** — the glyph texture would be rasterized smaller than its on-canvas
  size, upscaled by Pixi and then shrunk by the browser: two resamples where
  there was one.
- **Rasterize at display size by scaling the stage** (`resize(box, box, 1)` +
  `stage.scale`) — moves every consumer of the logical size off composition
  coordinates, and `Text` would still rasterize at composition size because
  its auto-resolution follows `renderer.resolution`, not the world scale.
- **Leave the box to CSS and pick a resolution whose per-axis rounding lands
  on the browser's box** — the two axes' rounding intervals overlap only when
  the browser snapped the box to the composition's aspect within half a pixel,
  which it does not promise, and even an exact size leaves the flex-centred
  origin fractional. Measured: a one-pixel width mismatch plus a half-pixel
  origin halved the text's fully-lit pixels.
- **`roundPixels` unconditionally** — a title sliding slowly across the frame
  would step by whole buffer pixels; NLE monitors keep sub-pixel motion.
- **Half and Quarter as fractions of the fit (`fit × knob`)** — on a 693 px
  panel 1/2 became a 2× upscale where it had been a 1.4× downscale, a visible
  loss bought with a raster saving of a few hundred thousand pixels, while the
  decode saving was identical either way.
