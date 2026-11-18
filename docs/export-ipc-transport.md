# Export frame transport (native engines)

Raw frames cross the Electron process boundary in both export directions.
**Encode-out:** the export Worker packs each composited frame to the sink's
rawvideo format (yuv420p, yuv422p, yuv420p10le, yuv422p10le) and streams it
over a frame port to a native `ffmpeg` encode.
**Decode-in:** the native `export_sw` session streams NV12/I420P10 frames into
the Worker's export ring. The WebCodecs engine (in-Worker `VideoDecoder`;
`VideoEncoder` → mediabunny fMP4) uses neither.

## Encode-out

1. The Worker composites (`rgba16float` target for yuv420p10le, `rgba8unorm`
   otherwise); a GPU pack pass (`PackYuvPlanar`, or the parity-gated
   `PackYuv420p10`) writes the rawvideo bytes into a ring of
   pixel-pack buffers (`PboFrameReader`), as many as the plan's
   `readbackFrames` (`exportReadbackFrames`: one while a Motif plays,
   otherwise up to four frames and 32 MiB; leaner plans read back fewer). When the ring is full, `drain()` reads every pending frame in order, so one wait
   for the GPU serves the batch. There is no fence: Chromium updates a
   fence's status only at frame boundaries, so polling one costs up to a
   display frame per readback.
2. After `export_video_sink_start` spawns ffmpeg, `runExport` asks main for a
   frame port (`export:videosink_port`, main window's top frame only), which
   reaches the page as a window message (a port cannot cross
   `contextBridge`). It hands the port to a sender worker
   (`worker/sinkSender.ts`) and joins the sender to the export Worker with a
   `MessageChannel`.
3. The export Worker transfers each frame to the sender (same process, no
   copy); the sender posts it to main, the one cross-process copy, off the
   compositing thread, and transfers the buffer back for a later frame, so
   an export cycles through the few buffers its plan counts instead of
   leaving one per frame to the garbage collector. Main (`main/exportSinkPort.ts`) writes frames to
   ffmpeg's stdin in arrival order and answers each with the count written,
   or once with the error that ends the stream; no frame is written after a
   failed one. The Worker keeps at most `readbackFrames` frames
   unanswered (`SinkFrameStream`) and settles them all before posting `done`.
4. `export_video_sink_finish` drops stdin (EOF) and reaps the child;
   `export_video_sink_cancel` kills, then drops stdin. Terminating the sender
   closes the port, and main stops writing.

The renderer main thread never touches a frame.

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

- **`ipcRenderer.invoke` per frame** (the earlier encode-out path): the frame
  crossed the renderer main thread and `contextBridge`, a copy each, and
  invocations ran one at a time; a 4K frame took ~32 ms there.
- **A custom-protocol `fetch` upload** from the Worker: measured ~35 MB/s.

There is no cross-process CPU zero-copy, so the budget is one copy per frame
per hop. Measurements: [`notes/export-pipeline-2026-11.md`](notes/export-pipeline-2026-11.md).

## Known copy

The napi layer copies each frame into an owned `Vec<u8>` because the
`spawn_blocking` write needs a `'static` buffer. It is not a measured hotspot
(export is offline and the cross-process copy costs more). The sink logs
`video sink finished: … copy N ms, write N ms (… MB/s stdin)` at finish; read
that from a real 4K export before changing it. If it matters, spawn ffmpeg via
`tokio::process` so stdin is `AsyncWrite` (no copy, no blocked worker).
`export_codecs.spec.ts` is the regression gate for transport changes.
