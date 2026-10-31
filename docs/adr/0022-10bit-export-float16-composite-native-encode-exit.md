---
status: accepted
---

# 10-bit export uses a float16 WebGL2 composite and a native ffmpeg encode exit

Date: 2026-06-13

## Context

The 8-bit pipeline composites in RGBA8 and snapshots through a 2D canvas, so
10-bit precision dies before encode. WebCodecs encodes 8-bit only and tags by
resolution (ADR 0014). Probes (2026-06-12) found:

- PixiJS's WebGPU backend hardcodes a `bgra8unorm` pipeline target and would
  need an upstream patch; its WebGL2 backend renders `rgba16float` render
  textures stock. The export Worker owns its renderer and can choose a backend.
- Chromium/Electron has no hardware Hi10P decode. Software-decoded I420P10
  frames can `VideoFrame.copyTo`; opaque hardware frames (HEVC Main10) cannot.
  AV1 10-bit decodes to copyable I420P10 only under prefer-software (dav1d);
  the hardware path "succeeds" with `format=null` frames.
- HDR preview is blocked: WebGL cannot present extended range
  (`drawingBufferToneMapping` is unshipped); only a WebGPU canvas with
  `toneMapping: 'extended'` can, which needs the Pixi per-format work above.
- Packed `yuv420p10le` at 1080p30 needs 186 MB/s; 4K needs ~750 MB/s. GPU
  readback is not the bottleneck; the webview→Rust transport is
  ([`export-ipc-transport.md`](../export-ipc-transport.md)).

## Decision

- The export Worker composites on **WebGL2**. For 10-bit HEVC Main10 / AV1
  10-bit and for ProRes, the target is an `rgba16float` `RenderTexture`.
  H.264 output stays 8-bit.
- 10-bit-capable sources (`tenBitExportCapable`: h264 or av1 with
  `yuv420p10le`) ingest through a CPU-plane lane: software decode,
  `copyTo` into I420P10, close the frame at once, upload planes as RG8, and
  unpack to f16 in a GLSL pass (`TenBitIngest`). 8-bit sources keep the
  snapshot ingest into the same f16 target.
- A GPU pack pass (`PackYuv420p10`) applies BT.709 limited-range matrix and
  10-bit quantization; the bytes go to a native `ffmpeg` sink
  (`export/videosink.rs`) that encodes with the probed encoder.
- **The f16 composite is display-referred, gamma-encoded BT.709**, a
  precision carry of the already-encoded signal, not a linear scene space.
  ADR 0014's working-space rule is unchanged.

## Consequences

- Real 10-bit HEVC/AV1 delivery with explicit color tags; the gradient-row
  meter in `export_codecs.spec.ts` gates precision through ingest, composite,
  pack and encode.
- The whole Pixi scene graph is reused; there is no separate native
  compositor.
- 10-bit ships **experimental** (labeled, click confirmed): preview stays 8-bit
  SDR, so the output cannot be guaranteed to match what the user sees; software
  10-bit decode runs below realtime, especially at 4K; HEVC Main10 originals
  have no copyable decode until a 10-bit conform exists.
- Deferred until HDR is a deliverable: HDR preview (WebGPU f16 canvas + Pixi
  per-target formats + HDR-display verification) and a linear/wide working
  space.
