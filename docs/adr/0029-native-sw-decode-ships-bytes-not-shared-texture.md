---
status: accepted
---

# CPU-resident native decode frames ship as bytes over classic IPC; non-Windows hardware lanes copy back into that transport

Date: 2026-10-31

## Context

- WebCodecs cannot open ProRes, DNxHD/HR, MPEG-2 or VC-1/WMV3
  (`codec_is_blindspot`). The Standard engine decodes them with libavcodec in
  the Electron main process (napi) and must hand frames to the renderer.
- The Windows d3d11va lane shares a GPU texture zero-copy; its speed comes
  from the frame staying a GPU handle end to end. A frame already in CPU memory
  (software decode, or a hardware surface that must be copied back) gains
  nothing from a GPU upload to reuse that path.
- Transport spike (`poc/export-frame-transport/FINDINGS.md`): classic
  `webContents.send` moved ~1 GB/s (327 fps 1080p, 86 fps 4K NV12).
  `MessageChannelMain` was slower, `MessagePortMain` cannot transfer an
  `ArrayBuffer`, and no CPU zero-copy exists across main↔renderer.
- Linux zero-copy (DMA-BUF import through Electron's native-pixmap shared
  texture) carries three unmeasured risk surfaces: DRM format-modifier
  negotiation, multi-GPU import, NVIDIA DMA-BUF export.
- decode-bench: NVDEC copy-back on an RTX 3050 (`h264-1080`) cost ~4 % main /
  ~1.4 % renderer CPU, leaving zero-copy almost nothing to reclaim. On a base
  M1, VideoToolbox copy-back cut main-process CPU from ~55 % (software) to
  ~10 %, at lower but still above-realtime fps.
- NVIDIA's VAAPI shim crashed the copy-back on the reference machine.

## Decision

- **One CPU transport.** The software lane and every non-Windows hardware lane
  deliver frames as packed bytes (8-bit NV12, or tightly packed I420P10 for
  10-bit VideoToolbox sessions) through a napi `ThreadsafeFunction` →
  `webContents.send` → the renderer's `SwTransport`. Hardware lanes (NVDEC,
  VAAPI, VideoToolbox) decode on the GPU and `av_hwframe_transfer_data` the
  surface to CPU; the packed bytes match the software lane's, so nothing
  downstream can tell which lane produced them.
- **No YUV→RGB in Rust.** Bytes cross as YUV with color tags; conversion
  happens once, in the renderer's owned ingest shaders (ADR 0032).
- **Lane order NVDEC → VAAPI → d3d11va → videotoolbox** (`HW_LANE_PRIORITY`),
  walking only lanes `capabilities()` advertises. VAAPI probes each DRM render
  node, because libva's default device is often the wrong GPU on multi-GPU
  hosts.
- **A hardware failure falls back to the software lane** inside the Standard
  engine. It never changes the Decode engine resolution and never downgrades
  to Lite.
- **Export uses the software lane only** (ADR 0033). Zero-copy DMA-BUF and
  hardware export readback stay deferred until decode-bench shows a host-CPU
  cost worth those risk surfaces.

## Consequences

- The per-frame copy is real (~1 GB/s ceiling); preview accepts it.
- Adding a lane is a decode-source swap plus a `capabilities()` entry, not new
  IPC.
- VAAPI copy-back calls `vaMapBuffer2`; a libva without it aborts the process
  on the first mapped frame. The component bundles libva ≥ 2.21 and advertises
  VAAPI only when the symbol resolves (`vaapi_copyback_supported`;
  [platform-codecs.md](../platform-codecs.md#2-vaapi-copy-back-and-libva)).
- `DecodeRoute::NativeSw` records the blind-spot verdict on disk; which lane
  decodes it is a runtime choice (ADR 0030).

Rejected: reuse the d3d11va shared-texture path for CPU frames (an upload for
nothing, Windows-only); `MessageChannelMain` or `SharedArrayBuffer` transport
(slower, or impossible across the boundary); a separate IPC message for
hardware frames (forks an identical transport); reaching NVIDIA through the
VAAPI shim (crashes the copy-back).
