# Color picker feasibility — 2026-09-13

## Verdict

On the tested Windows desktop, Electron can implement a frozen-screen picker
with an independently rendered full-display overlay, custom magnifier, native
pixel capture, click interception and focus restoration. No Rust capture backend
was required for this case. This does not establish live desktop capture or
cross-platform parity.

Disabling the chosen effect and extracting the full composite is NOT a general
implementation of "sample that effect's input". Actual project shaders demonstrate
the mismatch with both a downstream effect and an upper composited layer.

## Environment and evidence

- Electron 44.1.1 / Chromium 152.0.7977.65, Windows, real WebGL rendering.
- One physical screen: 1920 × 1080, 110% scaling, rotation 0, SDR sRGB/BT709.
- Electron display bounds: 1746 × 982 DIP; scale factor 1.100000023841858.
- Latest complete probe: `2026-09-13T06:05:45.034Z`, exit 0, `pass: true`.
- Actual desktop evidence: `out/desktop-overlay-218010116.png`, visually inspected.
  The custom magnifier and center marker are fully visible at bottom right,
  outside the small controller window, together with the bottom shortcut hint.
- `out/results.json` preserves sample values, screen metadata, input delivery,
  overlay geometry, close counts and focus state. Files are regenerated each run.
- Existing picker/field/effect-panel Vitest checks: **7 files, 59 tests passed**
  in 22.10 s (`colorpick`, `AppColorField.test.tsx`, `EffectsSection.test.tsx`).
  The expected jsdom canvas warning is not GPU evidence; GPU evidence is the
  standalone Electron experiment described below.

## Screen capture and interaction

| Measurement | Observed |
| --- | --- |
| Native screenshot size | 1920 × 1080, independently matched to Windows screen bounds |
| 64 × 64 one-physical-pixel black/white checker | 0 / 4096 RGB mismatches |
| Screenshot acquisition and local validation | 442 ms in the final run; not a benchmark |
| Magnifier at bottom-right edge | Fully within physical display extent |
| OS SendInput at client physical pixel (120, 100) | Selected screenshot pixel (120, 100), RGB #ff0000 |
| Click through to fixture window | 0 fixture click events |
| Commit | One settle, zero remaining overlay windows, controller focused |
| Subsequent OS Escape | One more settle with null, zero overlays, controller focused |

The fixture and overlay are separate BrowserWindows in the same test process.
This proves native window input interception over that fixture, not behavior
over every foreign application's exclusive fullscreen or privileged surface.
Hover was driven through CDP; commit and Escape were native OS input.

Two fractional-DPI traps were encountered and addressed in the probe:

1. `round(display.bounds.width * scaleFactor)` gives **1921**, despite the
   screen and screenshot both being **1920** pixels wide. Integer DIP bounds
   have already lost precision. Use actual capture dimensions and explicit
   per-display transforms; do not treat the product as exact native dimensions.
   Screenshot backgrounds use `capturePixels / devicePixelRatio` CSS dimensions
   rather than stretching to a rounded window viewport.
2. At OS pixel (120, 100), the click handler observed integer CSS coordinates
   (109, 90), producing pixel (120, 99) even with rounding. Pointerdown retained
   (109.09090423583984, 90.90908813476562), which round-tripped correctly. Commit
   from the precise PointerEvent position; rounding also avoids floating-point
   products such as 119.99999 falling into the preceding pixel.

All screenshots are frozen before any overlay is shown. Hover reads the immutable
buffer, so the magnifier cannot feed back into its own sampling. Overlay focus
is intentional and does not cancel the session. UI uses Electron throughout;
the small Windows helper is only test input/independent display metadata.

## Effect-input semantics

`effects.ts` imports production `EffectChain`, `effectOverrides` and actual Pixi
filters. It uses an isolated 64 × 64 WebGL stage and center pixel readback with
`extract.pixels(... resolution: 1)`, matching the existing picker's extraction
discipline. It does not invoke the full editor Compositor or project transport.

| Scenario | RGBA readback |
| --- | --- |
| Target layer input, no effects or upper layers | [64, 128, 32, 255] |
| Only chromakey, disabled through production override | [64, 128, 32, 255] |
| Disabled chromakey followed by brightness +25 | [80, 160, 40, 255] |
| Disabled chromakey under a 50% opaque #2040e0 layer | [48, 96, 128, 255] |

The source pixel stays [64, 128, 32, 255]; the last two readings are colors that
the selected chromakey never received. Thus `excludeEffectId` is sufficient for
the simple single-layer case, but not a precise effect-input contract.

Production follow-up should capture the target layer's texture immediately
before the selected effect, preserve preceding effects, exclude subsequent
effects and compositing, and supply the corresponding coordinate transform.
Generic composition picks can continue to sample the final composite. These
should be explicit source intents, not a silent desktop/composition heuristic.

The production `containMap` also mapped CSS (150,100), preview 320 × 180,
composition 1920 × 1080 to composition pixel (900,600). This is a coordinate
check only: it does not prove original-media resolution or recover detail from
a Quick proxy.

## Remaining validation

- Two actual displays with mixed scaling, negative origins, crossing the screen
  boundary and display removal. Only one display is attached here. Multi-display
  native-size assertions still need an independent monitor-identity join rather
  than the single-display Windows reference used in this run.
- macOS permission, window levels/Spaces, Retina capture and color management.
- Linux X11 and Wayland/Portal behavior; no parity verdict from this Windows run.
- HDR/10-bit, ICC transforms, source-frame sampling and alpha semantics.
- Full-editor effect-input capture with transforms, crop/masks, transitions and
  Quick proxy decode; full-editor undo behavior beyond the existing tests.
- Sustained/live capture and foreign exclusive-fullscreen windows are outside
  this frozen-frame experiment.

Recommended next implementation: preserve the in-app session and transient
commit behavior, replace desktop EyeDropper with a main-process-owned frozen
overlay session, and implement effect-input sampling as a separate renderer
capability. Evaluate Rust only against demonstrated capture/platform gaps.
