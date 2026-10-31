---
status: accepted
---

# Native-decoded YUV converts to RGB in owned shaders; the browser converts only its own decoders' frames

Date: 2026-10-31

## Context

ADR 0014 allows browser color conversion only where a gate proves it honors the
tags. That proof was measured on WebCodecs decoder-produced `VideoFrame`s.
Frames from native decode reach the compositor two other ways: as CPU planes
over IPC (ADR 0029) and, on Windows, as d3d11va shared textures.

- **Buffer-defined frames.** Chromium converts an `ArrayBuffer`-constructed
  `VideoFrame` with BT.601 coefficients whatever `colorSpace` says;
  `drawImage` and `createImageBitmap` share that converter. On a bt709/limited
  chart: yellow `B 0→10`, blue `B 253→240`, SSIM-to-source 0.616 (native lane)
  vs 0.892 (proxy lane). Output tags were right while pixels were wrong.
- **Shared textures.** NV12 shared textures converted by `createImageBitmap`
  left both color math and tag precedence to Chromium. Its WebGPU ingest paths
  (`copyExternalImageToTexture`, `importExternalTexture`) render a 601-tagged
  frame differently from the `drawImage` reference, and
  `copyExternalImageToTexture` drops `VideoFrame.colorSpace`. No web API path
  is both zero-copy and free of browser color math.
- Probes: a native matrix-only shader reproduced the `drawImage` reference
  to the byte through the WebGPU path that mangles raw NV12, and
  `importSharedTexture({ pixelFormat: 'rgba' })` is byte-exact end to end with
  an sRGB-passthrough tag.
- Natural-content SSIM barely weights chroma and grayscale ramps reconstruct
  identically under any matrix; only saturated charts exposed the defect.

## Decision

- **CPU planes never become browser-converted `VideoFrame`s.** They ride the
  ring as `NativeNv12Frame` / `TenBitFrame` and convert in the owned passes
  `Nv12Ingest` / `TenBitIngest` (GLSL for the WebGL export worker, a WGSL twin
  for the WebGPU preview). `coefForMatrix` (`render/tenbit/yuv10.ts`) is the single
  coefficient selector: BT.601 for `smpte170m`/`bt470bg`, else BT.709, range
  explicit. `VideoClipSprite.updateFrame` accepts only `BrowserConvertibleFrame`,
  so the forbidden route does not type-check.
- **The d3d11va lane converts NV12→RGBA8 on the decode device** with a
  session-owned pixel shader into `R8G8B8A8_UNORM` pool slots, imported as
  `rgba` tagged `{bt709, srgb, rgb, full}`. The browser only moves bytes. The
  shader's constants derive from Rust twins of `coefForMatrix` and
  `Nv12Ingest`'s range normalization, pinned by golden unit tests; both lanes
  point-sample chroma.
- **Not `VideoProcessorBlt`.** Its math is driver-defined and cannot be pinned
  to the goldens.
- **WebCodecs decoder frames keep browser conversion** under ADR 0014's gates.
- **Every owned lane is gated with saturated charts** (709/601 ×
  limited/full): `export-prores-fidelity`, `preview-sw-color`,
  `preview-hw-color`, plus `color-conformance` for decoder-frame delegation.

## Consequences

- Preview and export, software and hardware lanes share one coefficient
  source; drift between the Rust twins and the renderer fails the goldens.
- RGBA slots cost ×2.67 the NV12 VRAM plus one full-screen pass and a staging
  copy per frame. A same-sitting playback A/B against NV12 showed 1080p×5 and
  4K×2 equivalent; 4K×3 failed in both variants (decoder saturation).
- A new CPU-plane format (4:2:2, HDR, capture surfaces) needs its own frame
  kind, owned ingest and chart gate; `new VideoFrame(bytes)` + browser
  conversion is forbidden.
- 10-bit shared-texture preview is blocked: Electron offers no 10-bit integer
  RGB `pixelFormat` (`rgba|bgra|rgbaf16|nv12|nv16|p010le`) and hand-built P010
  imports come back null/black, so a future lane must use `rgbaf16`.
- If Chromium fixes buffer-frame tag handling, reverting to delegation still
  needs fresh per-lane verification and buys nothing.
