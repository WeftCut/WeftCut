# Preview thread split: moving decode or Pixi off the main thread does not help

Point-in-time spike, 2026-10-26. It asked whether decoding 4K WebCodecs video in a Worker,
or running the whole compositor in a Worker on an `OffscreenCanvas`, keeps the preview
playhead smooth. The answer is no. The stall is in the GPU process, behind
`createImageBitmap(VideoFrame)` on hardware frames, not in renderer JavaScript.

The probe is the standalone Electron app on the archived branch `poc/preview-thread-split`
(`poc/preview-thread-split/`). Its `FINDINGS.md`, `results-run2.md` and `results-run3.md`
hold the full tables.

## Environment measured on

- Windows 11, i5-13400, RTX 3050 (display GPU), 60 Hz display.
- Electron 44.9.3 / Chromium 152.
- One isolated Electron process per measurement, in a visible 1480×960 window. It was
  started from an interactive scheduled task so the renderer had a real GPU.
- Load: 1–3 copies of the 4K/30 fps H.264 decode-bench fixture
  (`e2e/fixtures/decode-bench/h264-2160.mp4`).
  - Demuxed with mediabunny and decoded with WebCodecs `prefer-hardware` (D3D11; every run
    reported `hwSupported: true`).
  - Frames were presented on their timestamps from a pacing clock.
- 15 s of sampling after 3 s of warm-up per cell. The full matrix ran twice.

Re-verify when the Electron major changes, or before relying on it for the ffmpeg d3d11va
shared-texture lane. That lane was not measured here.

## Arms

| Arm | Main thread, per frame | Worker, per frame |
| --- | --- | --- |
| decode-raw | hardware decode, `VideoFrame.close()` at once | — |
| decode-only | decode + `createImageBitmap`, bitmap closed at once | — |
| upload-only | one static 4K `ImageBitmap` per stream re-submitted through Pixi (WebGPU) | — |
| main | decode + `createImageBitmap` + Pixi (today's shape) | — |
| decode-worker | Pixi only; bitmaps arrive transferred | decode + `createImageBitmap` |
| all-worker | nothing | decode + `createImageBitmap` + Pixi on an `OffscreenCanvas` |

## Results at three 4K streams (two repetitions)

| Arm | rAF p99 (ms) | rAF gaps > 50 ms in 15 s | `setInterval(16)` p99 | Long Tasks |
| --- | --- | --- | --- | --- |
| idle (0 streams) | 18.1 / 18.0 | 0 / 0 | 17.9 | 0 |
| decode-raw | 17.6 / 17.1 | 0 / 0 | 17.8 | 0 |
| decode-only | 50.3 / 50.2 | 30 / 22 | 17.6 | 0 |
| upload-only | 17.0 / 17.2 | 0 / 0 | 17.9 | 0 |
| main | 67.1 / 68.3 | 78 / 81 | 17.7 | 0 |
| decode-worker | 67.1 / 68.0 | 43 / 75 | 17.5 | 0 |
| all-worker | 99.8 / 83.7 | 81 / 87 | 17.7 | 0 |

- The decoder kept a full look-ahead: lateness was −123 to −128 ms at p99 in every decoding
  row.
- `createImageBitmap` on a hardware frame cost the renderer 0.3–1.3 ms at p99.

## Verdict

1. **The thread split changes nothing.**
   - At three streams, `main`, `decode-worker` and `all-worker` all have a rAF p99 of
     67–100 ms.
   - `all-worker` is the worst in both repetitions, although the main thread runs no
     per-frame JavaScript there.
   - This reproduces the earlier in-app result: the preview compositor in a Worker did not
     help.
2. **Main-thread JavaScript is not the bottleneck.** `setInterval(16)` stays at 17.5–18 ms
   p99 with zero Long Tasks in every row. Only vsync-driven frames are late.
3. **The cost is `createImageBitmap(VideoFrame)` on hardware frames.**
   - The two halves alone are clean: hardware decode (`decode-raw`) looks like idle, and
     three 4K Pixi uploads per frame (`upload-only`) run at 17 ms p99.
   - Adding one `createImageBitmap` per frame stretches rAF to 50 ms, even with nothing
     displayed.
   - The work is a GPU-process copy (and an NV12 colour conversion) into a shared image. It
     runs on the GPU main thread that also issues the compositor's frames.
   - The frame ring (ADR 0004) snapshots every decoded frame this way.
4. **The response is bimodal.** One stream of `decode-only` is often worse than two (50 vs
   34 ms p99). Treat this as GPU scheduling or power state, not a capacity curve.

## Next steps (not done)

- **Stop copying.**
  - Options: WebGPU `importExternalTexture`, `copyExternalImageToTexture`, or WebGL
    `texImage2D` with a `VideoFrame`. All of them avoid the shared-image snapshot.
  - The cost: frames are held until they are rendered. This is bounded by the decoder's
    ~13-slot pool (ADR 0004) and by the colour-trust rules of ADR 0021/0040.
  - The obvious next arm is to measure these import paths under the same load.
- **Take a GPU-process trace** (`chrome://tracing` or ETW) to see which stage delays
  BeginFrame.
- **Measure the ffmpeg d3d11va shared-texture lane inside the app** (calibration prototype).
  It shares the GPU but not the decoder plumbing or copies.

Do not propose renderer-side thread splits for preview smoothness without new evidence that
contradicts this note.
