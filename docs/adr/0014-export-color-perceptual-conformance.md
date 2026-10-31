---
status: accepted
---

# Color converges at gated chokepoints; the working space is the output space

Date: 2026-06-12

## Context

Sources arrive as 601/709, limited/full, 8/10-bit and HLG/PQ. Several platform
components do silent, wrong color math:

- Pixi's WebGPU upload (`copyExternalImageToTexture`) ignores
  `VideoFrame.colorSpace` and converts every frame as BT.709/limited, a
  destructive mis-convert for 601 or full-range frames.
- Chromium converts a buffer-defined (ArrayBuffer-constructed) `VideoFrame` as
  BT.601 regardless of its stamped `colorSpace` (ADR 0032).
- Chromium's WebCodecs encoder (hardware and software) ignores the input
  frame's `colorSpace` and tags output by resolution (BT.709 for HD);
  `VideoEncoderConfig` has no color field.
- The decoder follows its config over the bitstream VUI, and mediabunny reads
  only the mp4 `colr` atom, never the VUI. A colr-less proxy therefore decoded
  under the bt709/limited default (full-range decoded as limited, 601 as 709).
- The browser 2D-canvas paths (`drawImage`, `createImageBitmap`) do honor a
  decoder-produced frame's matrix and range.

Measured on the color-patch fixtures: reverting the export `drawImage` snapshot
scored ~22 on the perceptual gate (PSNR 22.6 dB vs 42 dB); a faithful 601→709
export scores ≈0 (worst channel 2 codes). A matrix-roundtrip check (force both
files to the source matrix) reported the same error for right and wrong pixels,
so it could not detect the regression.

## Decision

- **All color conversion happens at explicit, gated chokepoints, as early as
  it is well-defined; everything downstream is color-naive.** The working
  space is the delivery space: an sRGB composite and BT.709 limited output.
  There is no wide working space and no output transform. The 10-bit lane
  carries the same display-referred signal at higher precision (ADR 0022).
- A chokepoint is legitimate in two forms:
  - **Verified delegation**: the browser 2D-canvas converters, for
    decoder-produced frames only. Preview converts at decode output
    (`createImageBitmap`); export snapshots each frame in `VideoClipSprite`
    (`drawImage`). Never bind a raw `VideoFrame` to Pixi.
  - **Owned parameters**: conversions we pin and version: the ffmpeg proxy
    recipes (`source_color_args` + `-movflags +write_colr`, so every proxy is
    self-describing), the CPU-plane ingest shaders (ADR 0032), and any future
    tone map (explicit curve and dither flags, never defaults).
- Placement: matrix/range per frame at decode/snapshot; tone map and gamut
  reduction once per asset at proxy generation.
- Decode config: `withDefaultColorSpace` layers the target's `colr` tag over
  the ffprobe source tag over a resolution default, for originals and proxies.
- **The analyzer is the arbiter.** A chokepoint is trusted only while a gate
  asserts its output. The color gate is perceptual (`media_conformance
  --color`): decode the output by its own tags, the source forced to its
  matrix/range, and compare displayed RGB.

## Consequences

- A 601 source exports as a correctly converted 709-tagged file, and a
  full-range source exports limited. Both are normalization, not bugs.
  Relabeling HD output to a non-standard matrix was rejected.
- HDR sources currently reach the composite through Chromium's implicit
  HDR→SDR tone map, a tolerated gap: unconfigurable and able to drift with
  Electron updates. 10→8-bit is a truncation (~4× step loss on the gradient
  fixture). The candidate fix is a proxy-time tone map (`zscale` → `tonemap` →
  709 + dither).
- New pixel paths must prove tag-honoring against the analyzer or convert at an
  owned chokepoint first.
- Revisit trigger: if HDR or wide-gamut output becomes a deliverable, ingest
  converges into a wide working space and an explicit per-target output
  transform becomes a second chokepoint. The gating discipline is unchanged.
- The zero-copy `importExternalTexture` path is parked; see
  [`render.md`](../render.md#frame-upload-the-snapshot-rule).
