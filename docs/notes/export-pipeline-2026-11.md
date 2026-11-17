# Export pipeline: where the time goes (2026-11-16/17)

**Environment.** Windows 11 desktop (i5-13400, RTX 3050, 60 Hz display, NVENC)
and an M1 MacBook (8 GB, VideoToolbox); Electron 44 / Chromium 152.
**Probe.** A Playwright bench that exported generated sources (20 s of
1080p60 and 4K30 noise patterns with audio, plus built-in Motifs) through the
real export path, timing each stage in the Worker, the runner and main, and
hashing every raw frame main handed to ffmpeg. Single runs unless stated;
run-to-run spread was about ±5 % (±10 % for Motif exports on the Mac). A
remote-desktop session on the Windows machine made its timings unstable;
those runs are discarded.

## Native export locked to the display rate (Windows)

Native-sink 1080p exported at 59–60 fps, each frame's PBO readback taking one
display frame (p50 16 ms, Mac 6 ms). Motif exports paid about three frames
per output frame (20 fps).

- The trigger is any requestAnimationFrame loop in the editor page. With every
  rAF loop stopped, readback took 3.9 ms: 1080p 59 → 94 fps, a warm-cache
  Motif export 20.7 → 79 fps. `--disable-gpu-vsync` had the same effect.
  Minimizing the window removed the wait too. The Chromium mechanism was not
  traced: tracing itself removed the wait.
- Two Pixi loops were running for the whole session: the preview's ticker
  (it renders while paused) and `Ticker.system`, which every Pixi renderer's
  scheduler and the event system's hover check join. The editor uses neither
  Pixi events nor sub-second scheduled tasks (GC runs every 30 s).
- No effect: stopping only the preview ticker (the system ticker kept the
  loop), reduced-motion, more PBO slots, skipping the fence poll,
  `--disable-direct-composition` (Motif exports got slower).
- macOS: stopping the loops changed results by under the run spread.

## Readback

- One `getBufferSubData` per frame costs one wait for the GPU. Reading back a
  full ring at once shares that wait: with the rAF loop running, 1080p
  59 → 115 fps with four frames per batch; eight frames gave no more.
  Raw-frame hashes were identical (4 projects × 1200 frames, both machines).
- With the rAF loops paced away (Windows, fps):

  | frames per batch | 1080p | 4K | Motif 1080p cold | Motif 1080p warm |
  |---|---|---|---|---|
  | 1 | 104–107 | 47 | 20 | 65 |
  | 2 | 124 | 48 | 21 | 38 |
  | 4 | 130 | 44 | 19–20 | 21 |

  With Motif layers, frames left unread on the GPU stall the next Motif
  frames (a warm export's Motif wait 6 s at one frame per batch, 52 s at
  four). The mechanism inside Chromium was not isolated. Exports with Motif
  layers read each frame back before the next; others batch two.
- A fence's status in Chromium changes only at frame boundaries, so polling
  one costs a display frame however early the GPU finished.
- 4K: reading back four 12.4 MB frames costs about 26 ms per frame
  (~480 MB/s through `getBufferSubData`).

## Frame transport (encode-out)

- `ipcRenderer.invoke` per frame, 4K: 32–37 ms round trip (PC), of which the
  renderer's `contextBridge` copy plus serialization ~15 ms, transit ~16 ms,
  main's napi copy and stdin write ~6 ms. Three in flight did not raise
  throughput. Mac: 8 + 10.5 + 7.8 ms.
- A `MessagePort` from main posted to from the export Worker: Mac 4K
  34.8 → 42.4 fps; on Windows the structured clone moved onto the compositing
  thread (no gain), hence a separate sender worker.
- `fetch` POST to a custom protocol from the Worker: ~35 MB/s. Rejected.
- Encoder capacity is not the limit: NVENC took 4K at 98 fps (HEVC 92) from a
  rawvideo pipe with the app's input arguments.
- WebCodecs encode (no raw frames leave the GPU process): Mac 1080p 196 fps,
  4K 48 fps (decode-bound), color charts within the gate as native; Windows
  59 fps at 1080p and 8 fps at 4K. The fixed H.264 codec string (level 4.0)
  fails a 4K encode.

## Motif reads

- Warm texture-lane read stages on Windows (medians): file read 0.2 ms,
  decompress 2.5–4 ms, upload 1.1–2.3 ms, import 1.4–2 ms. A whole read took
  35–48 ms with the rAF loop and 10 ms without it.
- Mac utility lane: about 5.6 ms of work, 17–19 ms per read; three reads in
  flight per document and one frame's layers read one after another. Reading
  a frame's layers concurrently gained nothing (each read slowed), and a
  wider window was refused by Motif capture admission.
- Batching the read barrier's one-pixel readback gained nothing.

## Fixed costs per export

- The audio mix ran before the video: 0.33–0.5 s per 20 s of timeline.
- The first export of a session probes the encoder: 0.73–0.88 s on Windows,
  0.15 s on the Mac; cached afterwards.
