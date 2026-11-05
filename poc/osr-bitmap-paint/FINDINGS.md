# Bitmap OSR `paint` as the Motif capture output

Can `webContents.on('paint')` on a bitmap offscreen window replace
`Page.captureScreenshot` on hosts without shared-texture capture?

**Verdict: on GPU compositing, yes for pixels and speed; on software compositing,
no, because alpha is wrong. `capturePage()` is the better first candidate: it
matched the PNG, alpha included, on every host run, and needs no encode. See
[`capturePage`](#capturepage). macOS and Linux with a GPU were not run.**

Electron 44.9.3, Chromium 152. Synthetic pages at 1920x1080 unless stated. Each
frame draws its number as a barcode, so staleness is read from the pixels.

| Host | Compositing |
| --- | --- |
| Windows 11, i5-13400, RTX 3050 | GPU (`gpu_compositing: enabled`) |
| Same, `--disable-gpu` | Software |
| Linux VM, 2 cores, no GPU, Xvfb | Software |

## Correctness against a PNG of the same state

Rule: settle 3 rAFs, `invalidate()`, wait until paints stop for the quiet window,
keep the last. Quiet windows 34 and 67 ms; sequential, navigation and resize.

| Host | Samples | Frames differing from PNG | Pixels off (>2 of 255) |
| --- | --- | --- | --- |
| Windows GPU | 520 | 0 | 0 |
| Windows software | 192 | 64 (the `dom` page) | up to 4490, plus wrong alpha |
| Linux software | 336 | 84 (the `dom` page) | up to 573834 on stale frames; 4489 otherwise |

On Windows GPU, 10 samples read a wrong barcode on the canvas or WebGL row while
matching the PNG byte for byte, so this is not specific to `paint`. Cause not
investigated. The reference check covered the DOM row only.

## Alpha

50% red over a transparent page. The PNG is `0,0,128,128` (BGRA, premultiplied)
in every run.

| Host | `paint` reads |
| --- | --- |
| Windows GPU | `0,0,128,128` in all 12 samples that produced a paint |
| Windows software | `127,127,255,255`, `0,0,192,192`, `63,63,255,255`, `0,0,128,128`; varies between runs |
| Linux software | The same set |

`0,0,192,192` and `63,63,255,255` are the layer blended twice. The `--disable-gpu`
run reproduces this on Windows, so it follows software compositing, not the OS.

## Cost, Windows GPU, p50 ms

Time from settled render to bitmap, and synchronous main-thread work within it.

| Page | PNG output | PNG main thread | `paint` output | `paint` main thread |
| --- | --- | --- | --- | --- |
| 1080p DOM | 140 | 12 | 2 | 2 |
| 1080p dense canvas | 387 | 17 | 2 | 2 |
| 4K DOM | 342 | 43 | 8 | 8 |
| 4K dense canvas | 1165 | 61 | 8 | 8 |

**These `paint` columns do not measure capture.** The first paint after
`invalidate()` is the cached bitmap re-emitted before the call returns (25/25 on
all three hosts), so 2 and 8 ms are the `toBitmap()` copy; output equals main
thread because nothing else happened. See
[Time from change to bitmap](#time-from-change-to-bitmap) for the real path. With
the quiet-window rule, output is 36-63 ms at 34 ms quiet and 69-95 ms at 67 ms.

Not measured: delivering the bitmap. A bake only encodes it, but live preview must
carry 8 MB (33 MB at 4K) to the renderer. ADR 0154 records 12-37 ms of main-thread
serialization per frame for that.

## Where `paint` comes from

Read from Electron v44.9.3 and Chromium 152.0.7977.167.

- With hardware acceleration, `paint` is fed by `FrameSinkVideoCapturer`, Chromium's
  tab-capture pipeline. Without it, by a software output device writing into a
  retained canvas (`osr_render_widget_host_view.cc:214`,
  `osr_host_display_client.cc`).
- Each delivered frame is copied into a `backing_` bitmap on the UI thread, wanted
  or not, and `invalidate()` only re-emits `backing_`
  (`osr_render_widget_host_view.cc:635-637`, `:916-921`). Electron's API text says it
  "generates a new one"; in bitmap mode it does not.
- The capture requests the whole frame on each sampled damage, not a patch
  (`frame_sink_video_capturer_impl.cc:1185-1192`).
- A screenshot forces a redraw, then copies the surface, then encodes
  (`render_widget_host_impl.cc:2274-2293`, `:3850-3856`). `capturePage()` is the copy
  alone (`electron_api_web_contents.cc`, `WebContents::CapturePage`). The encoder is
  the only thing `optimizeForSpeed` and `format` change (`page_handler.cc:137-150`).

Inferred, not verified:

- Software alpha: `0,0,192,192` is exactly a 50% layer over an uncleared 50% layer,
  which the retained canvas would produce.
- 240 fps worsening the first paint: rAFs run at that rate, so three of them last
  12.5 ms instead of 50 ms and end before the capture lands.

## Time from change to bitmap

Sink armed before the render, no settle, no `invalidate()`; the first paint holding
the new frame. p50/p95 ms, n=25, 60 and 240 fps ranges, 1080p. No paints missed.

| Host | DOM | Translucent | Dense canvas | `toBitmap` |
| --- | --- | --- | --- | --- |
| Windows GPU | 11-12 / 22 | 11 / 22-26 | 11-12 / 23 | 1.4 |
| Windows software | 17 / 44-45 | 3-5 / 5-15 | 9 / 21-24 | 1.4-1.9 |
| Linux software | 53-88 / 93-138 | 11-17 / 17-26 | 30-42 / 49-91 | 7-14 |

Frame rate does not change the GPU result. Reading the page's own barcode is what
identifies the frame here; production has no such stamp yet.

## `capturePage`

`wc.capturePage(undefined, { stayHidden: true, stayAwake: true })`, then
`toBitmap()`, compared with a PNG taken right after.

After settle 3, across sequential renders, navigation and resize:

| Host | Samples | Differ from PNG | Rejected |
| --- | --- | --- | --- |
| Windows GPU | 196 | 0 | 0 |
| Windows software | 147 | 0 | 0 |
| Linux software | 147 | 0 | 0 |

- Alpha: `0,0,128,128` over `0,0,0,0`, identical to the PNG, in 6 of 6 fresh
  documents per host, including both software hosts where `paint` fails.
- Fewer settles are not safe. Settle 0 was wrong on up to 22 of 25; settle 1 on up
  to 4 of 25; settle 2 on 3 of 12 after navigation on Linux, heavy page.
- 6 of 1480 captures rejected, all at settle 0-2 and 5 of them right after a
  navigation or resize. The error text was not recorded.
- There is no forced redraw, so settling is still a timing assumption. These pages
  are synthetic; ADR 0078 records that rAFs do not settle a real Motif's raster on a
  new surface.

Full-frame cost at 1080p, p50 ms; `capturePage` adds its `toBitmap` copy (4-8 ms),
while the PNG still has to be decoded:

| Page, host | PNG | PNG fast | JPEG q1 | `capturePage` |
| --- | --- | --- | --- | --- |
| DOM, Windows GPU | 138 | 76 | 61 | 11 |
| Dense canvas, Windows GPU | 462 | 116 | 51 | 25 |
| DOM, Windows software | 214 | 133 | 125 | 43 |
| Dense canvas, Windows software | 490 | 98 | 51 | 16 |
| DOM, Linux software | 351 | 200 | 179 | 100 |
| Dense canvas, Linux software | 764 | 235 | 76 | 38 |

JPEG q1 is a candidate for the ADR 0078 fence: per the source, only the encoder
differs from the PNG path. A JPEG fence followed by `capturePage` was not run.

## Choosing the frame

No signal says a paint holds the settled frame. Over 25 samples per cell, Windows
GPU:

| Cell | First paint right | Last paint right |
| --- | --- | --- |
| 60 fps, settle 2 | 29/75 | 75/75 |
| 60 fps, settle 3 | 75/75 | 75/75 |
| 240 fps, settle 2 | 12/75 | 75/75 |
| 240 fps, settle 3 | 12/75 | 75/75 |

- The first-paint column is the re-emitted bitmap, so it only shows whether the
  capture landed before the settle ended.
- This run armed its sink after the settle, so a paint that landed during the settle
  counted as missing: without `invalidate()`, 101 of 300 renders showed no right
  paint. With the sink armed first, none were missed.
- Raising the frame rate makes the first paint worse.
- The quiet window is a timing assumption, not proof. On Linux software, a 34 ms
  window returned stale frames after navigation (2/15) and resize (5/12) on the
  heavy page. 67 ms had none in that run, and 1/15 after navigation in an earlier
  run that applied the overrides before loading.

## Host constraints

- Apply size and overrides after each navigation. Applied only before loading,
  Windows emits no paint at all (12 of 12 windows-and-documents with GPU).
- `paint` follows the window, not the emulated size. On Linux, a window exactly
  the screen size becomes 1919x1079 (real X11 and Xvfb); 1280x720 and 3840x2160 on
  a 1080p screen are exact. A screenshot still returns 1920x1080.
- `app.getGPUFeatureStatus()` read at startup said software on the GPU host; read
  it after a window has rendered.

## `optimizeForSpeed` on the existing PNG path

Screenshot p50 ms, default to `optimizeForSpeed: true`, n=15.

| Page | Windows GPU | Linux software | PNG bytes |
| --- | --- | --- | --- |
| DOM | 135 to 71 | 344 to 199 | 1.3x |
| Dense canvas | 372 to 103 | 763 to 245 | 2-2.4x |

Decoding on the main thread was about 60% slower on the dense canvas. Pixels were
not compared in this mode.

## Reproduce

```sh
# Xvfb with a screen larger than the capture avoids the 1919x1079 case.
electron poc/osr-bitmap-paint/rule.cjs --user-data-dir=<dir> --out=<file> --n=20
electron poc/osr-bitmap-paint/alpha-order.cjs --user-data-dir=<dir>
electron poc/osr-bitmap-paint/sequence.cjs --user-data-dir=<dir> --out=<dir> --n=25
electron poc/osr-bitmap-paint/main.cjs --user-data-dir=<dir> --out=<dir> --n=20 --stages=timing
electron poc/osr-bitmap-paint/capture-sources.cjs --user-data-dir=<dir> --out=<file> --n=25
```

`main.cjs`'s `correct`, `nav` and `resize` stages take the first paint and predate
the selection rule; use them only to see how often that choice is wrong.
