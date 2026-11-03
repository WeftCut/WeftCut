# Export frame transport (native engines)

Raw frames cross the Electron process boundary in both export directions over
classic main↔renderer IPC. **Encode-out:** the export Worker packs each
composited frame to the sink's rawvideo format (yuv420p, yuv422p,
yuv420p10le, yuv422p10le) and streams it to a native `ffmpeg` encode.
**Decode-in:** the native `export_sw` session streams NV12/I420P10 frames into
the Worker's export ring. The WebCodecs engine (in-Worker `VideoDecoder`;
`VideoEncoder` → mediabunny fMP4) uses neither.

## Encode-out

1. The Worker composites (`rgba16float` target for yuv420p10le, `rgba8unorm`
   otherwise); a GPU pack pass (`PackYuvPlanar`, or the parity-gated
   `PackYuv420p10`) writes the rawvideo bytes. Readback is PBO + fence
   (`PboFrameReader`): submit frame N, retrieve frame N−1, so the CPU never
   waits on the GPU.
2. The Worker posts the frame buffer (transferred) to the renderer main thread
   as an export `chunk`. `chunk-ack` is the backpressure: one frame in flight,
   with the Worker compositing the next frame while the ack is pending.
3. Renderer → `window.api.videoSinkWrite` → `ipcMain.handle('export:videosink_write')`
   → `video_sink_write`, which writes to ffmpeg's stdin on a blocking thread.
4. `export_video_sink_start` spawns ffmpeg and holds stdin;
   `export_video_sink_finish` drops stdin (EOF) and reaps the child;
   `export_video_sink_cancel` kills, then drops stdin.

There is no socket, port or token.

## Decode-in

Main → renderer → Worker, feeding natively decoded frames to the export
compositor (routing: [ADR 0033](adr/0033-export-decode-joins-the-engine-overlay.md);
consumption: [`render.md`](render.md) § Export decode pipelines):

1. `NativeExportSourceHandle` sends `nd:*` commands (open / decodeRange /
   returnCredit / close); the renderer forwards them to `window.api.exportSw`,
   which drives the `export_sw` session (`src/main/exportSw.ts`).
2. The session decodes GOP-aligned exact coverage of each range and emits
   everything in-band as `ExportSwMsg` (`frame`, `rangeEnd`, `ended`, `error`)
   on the single `exportSw:msg` channel; the renderer re-posts frames to the
   Worker as transferred `ArrayBuffer`s. `rangeEnd` carries the completed
   `[aUs, bUs]` and, once every earlier frame has arrived, proves presentation
   finality for pending `waitForPts` targets.
3. **Delivery order is the contract.** An `ended`/`rangeEnd` overtaking its
   tail frames corrupts the export tail; never split control and frames onto
   separate channels.
4. Backpressure is a credit window: the Rust producer parks at `creditWindow`
   frames in flight, and the handle returns one credit per frame that leaves
   the ring (consumed, evicted or freed). Credits bypass the session's command
   channel so they land mid-range.

## Why IPC

- **Loopback WebSocket** (the earlier transport) measured slower and needed an
  ephemeral listener, a bearer-token handshake, an accept deadline and
  `bufferedAmount` polling.
- **GPU shared-texture import** (Electron offscreen rendering → ffmpeg
  hardware frames): Electron's offscreen shared texture is 8-bit BGRA, so it
  cannot carry the 10-bit lanes; it would add a native dependency without
  retiring this transport.

Classic IPC measured about 1 GB/s; there is no cross-process CPU zero-copy, so
the budget is one copy per frame per hop.

## Known copy

The napi layer copies each frame into an owned `Vec<u8>` because the
`spawn_blocking` write needs a `'static` buffer. It is not a measured hotspot
(export is offline and IPC serialization costs more). The sink logs
`video sink finished: … copy N ms, write N ms (… MB/s stdin)` at finish; read
that from a real 4K export before changing it. If it matters, spawn ffmpeg via
`tokio::process` so stdin is `AsyncWrite` (no copy, no blocked worker).
`export_codecs.spec.ts` is the regression gate for transport changes.
