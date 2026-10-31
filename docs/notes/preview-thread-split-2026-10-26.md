# Preview thread split: moving decode or Pixi off the main thread does not help

Spike, 2026-10-26. Question: does 4K WebCodecs decode in a Worker, or the whole
compositor in a Worker on an `OffscreenCanvas`, keep the preview playhead
smooth? **No.** The stall is in the GPU process, behind
`createImageBitmap(VideoFrame)` on hardware frames. Renderer JavaScript is not
the cause. This repeats the earlier in-app result: a compositor in a Worker
made preview p99 worse.

Do not propose renderer-side thread splits for preview smoothness without new
evidence that contradicts this note.

## Probe and environment

- Standalone Electron app on the archived branch `poc/preview-thread-split`
  (`poc/preview-thread-split/`). `FINDINGS.md` and `results-run{2,3}.md` there
  hold the full tables.
- Windows 11, i5-13400, RTX 3050, 60 Hz. Electron 44.9.3 / Chromium 152. One
  visible 1480×960 window per measurement, started from an interactive
  scheduled task so the renderer had a real GPU.
- 1–3 copies of `e2e/fixtures/decode-bench/h264-2160.mp4`, demuxed with
  mediabunny and decoded with WebCodecs `prefer-hardware` (D3D11), presented on
  timestamps. 3 s warm-up, then 15 s of sampling. The full matrix ran twice.
- Not measured: the ffmpeg d3d11va shared-texture lane. Re-verify when the
  Electron major version changes.

## Results at three 4K streams (two runs)

| Arm (per frame) | rAF p99 ms | rAF gaps > 50 ms / 15 s |
| --- | --- | --- |
| idle | 18.1 / 18.0 | 0 / 0 |
| decode only, `VideoFrame.close()` at once | 17.6 / 17.1 | 0 / 0 |
| decode + `createImageBitmap`, nothing drawn | 50.3 / 50.2 | 30 / 22 |
| static 4K bitmaps re-uploaded through Pixi | 17.0 / 17.2 | 0 / 0 |
| main: decode + bitmap + Pixi (today's shape) | 67.1 / 68.3 | 78 / 81 |
| decode + bitmap in Worker, Pixi on main | 67.1 / 68.0 | 43 / 75 |
| everything in Worker (`OffscreenCanvas`) | 99.8 / 83.7 | 81 / 87 |

- `setInterval(16)` p99 stayed at 17.5–18 ms with zero Long Tasks in every
  row. Only vsync-driven frames were late.
- The decoder kept full lookahead (p99 lateness −123 to −128 ms).
  `createImageBitmap` cost the renderer only 0.3–1.3 ms p99. Its real cost is a
  GPU-process copy plus NV12 conversion into a shared image, on the GPU main
  thread that also issues compositor frames.
- The response is bimodal: one stream is sometimes worse than two (50 vs 34 ms).
  Treat this as GPU scheduling or power state, not a capacity curve.

## Open leads (not done)

- Avoid the copy: WebGPU `importExternalTexture` or
  `copyExternalImageToTexture`, or WebGL `texImage2D(VideoFrame)`. Frames
  would then be held until drawn, which is bounded by the ~13-slot decoder pool
  ([ADR 0004](../adr/0004-imagebitmap-snapshot-frame-ring.md)) and by the colour
  rules.
- Take a GPU-process trace to see which stage delays BeginFrame.
- Measure the d3d11va shared-texture lane in the app.
