# Preview thread split: does moving decode or Pixi off the main thread help?

Date: 2026-10-26. Windows 11, i5-13400, RTX 3050 (display GPU), Electron 44.9.3 /
Chromium 152, 60 Hz display. One isolated Electron process per measurement, a
visible 1480×960 window, run from an interactive scheduled task so the renderer
has a real GPU. Each cell is 15 s of sampling after 3 s of warm-up; the full
matrix ran twice (`results-run2.md`, rows `r1`/`r2`).

The load is 1–3 copies of the 4K/30 fps H.264 decode-bench fixture
(`apps/desktop/e2e/fixtures/decode-bench/h264-2160.mp4`), demuxed with
mediabunny and decoded with WebCodecs `prefer-hardware` (D3D11 via Chromium;
every run reports `hwSupported: true`). Packets are fed 150 ms ahead of a
pacing clock; frames queue per stream and are presented on their timestamp,
so a drop is a frame whose time passed before a composite picked it up.

## What was measured

| Arm | Main thread does per frame | Worker does per frame |
|---|---|---|
| idle | rAF monitor only | — |
| decode-raw | hardware decode, `VideoFrame.close()` at once | — |
| decode-only | hardware decode + `createImageBitmap`, bitmap closed at once | — |
| upload-only | re-submit one static 4K `ImageBitmap` per stream at 30 fps through Pixi (WebGPU) | — |
| main | decode + `createImageBitmap` + Pixi (today's shape) | — |
| decode-worker | Pixi only; bitmaps arrive transferred | decode + `createImageBitmap` |
| all-worker | nothing | decode + `createImageBitmap` + Pixi on an `OffscreenCanvas` |

Metrics, all on the main thread unless noted: rAF interval percentiles (what a
DOM playhead feels), count of rAF gaps over 50 ms, `setInterval(16)` cadence
(event-loop responsiveness without the compositor), Long Tasks, and from the
compositing side the composite submission interval, frames dropped and
presentation skew. `createImageBitmap` cost and decode lateness come from
wherever the decoder runs.

## Results (run 2, both repetitions; ms unless noted)

| arm | streams | rAF p99 (r1 / r2) | rAF gaps > 50 ms | timer p99 | long tasks | composite interval p99 | dropped / presented | cib p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| idle | 0 | 18.1 / 18.0 | 0 / 0 | 17.9 | 0 | – | – | – |
| decode-only | 1 | 50.3 / 50.8 | 17 / 18 | 17.6 | 0 | – | – | 0.4 / 0.8 |
| decode-only | 2 | 33.7 / 33.6 | 3 / 0 | 17.8 | 0 | – | – | 1.3 / 0.6 |
| decode-only | 3 | 50.8 / 50.3 | 40 / 19 | 17.7 | 0 | – | – | 0.5 / 0.3 |
| upload-only | 1 | 17.2 / 17.4 | 0 / 0 | 17.8 | 0 | 35.5 / 35.7 | 0 / 450 | – |
| upload-only | 2 | 17.2 / 17.1 | 0 / 0 | 17.7 | 0 | 35.5 / 34.6 | 0 / 900 | – |
| upload-only | 3 | 17.0 / 17.2 | 0 / 0 | 17.9 | 0 | 34.5 / 35.0 | 0 / 1350 | – |
| main | 1 | 17.0 / 17.1 | 0 / 0 | 17.8 | 0 | 34.7 / 34.7 | 0 / 450 | 0.5 |
| main | 2 | 34.0 / 33.6 | 6 / 1 | 17.7 | 0 | 57.8 / 64.1 | 2 / 898, 72 / 828 | 0.5 |
| main | 3 | 67.1 / 68.3 | 78 / 81 | 17.7 | 0 | 99.7 / 100 | 423 / 933, 480 / 876 | 0.4 |
| decode-worker | 1 | 17.1 / 17.9 | 0 / 0 | 17.7 | 0 | 34.6 / 36.3 | 0 / 450 | 0.9 |
| decode-worker | 2 | 33.5 / 17.7 | 1 / 0 | 17.8 | 0 | 61.1 / 47.3 | 78 / 824, 2 / 898 | 0.6 |
| decode-worker | 3 | 67.1 / 68.0 | 43 / 75 | 17.5 | 0 | 91.9 / 100.6 | 132 / 1221, 420 / 936 | 0.8 |
| all-worker | 1 | 17.2 / 17.7 | 0 / 0 | 17.6 | 0 | 35.3 / 36.3 | 0 / 450 | 0.5 |
| all-worker | 2 | 33.7 / 33.4 | 4 / 2 | 17.6 | 0 | 42.6 / 37.1 | 0 / 900 | 0.5 |
| all-worker | 3 | 99.8 / 83.7 | 81 / 87 | 17.7 | 0 | 104.3 / 98.4 | 288 / 1065, 366 / 990 | 0.6 |

Decode lateness was −123 to −128 ms at p99 in every decoding row: the hardware
decoder stayed a full look-ahead ahead of the clock at 3 × 4K, so decode
throughput is not the limit.

## Run 3: the decoder alone versus the decoder plus `createImageBitmap`

Same host, same fixture, two repetitions each (`results-run3.md`). `decode-raw`
closes every hardware `VideoFrame` as it arrives; `decode-only` additionally
calls `createImageBitmap(frame)` and closes the bitmap. Neither displays
anything.

| arm | streams | rAF p99 (r1 / r2) | rAF max | rAF gaps > 50 ms | timer p99 | long tasks |
|---|---:|---:|---:|---:|---:|---:|
| idle | 0 | 18.0 / 17.4 | 19.4 | 0 / 0 | 17.7 | 0 |
| decode-raw | 1 | 17.6 / 18.2 | 18.9 | 0 / 0 | 17.6 | 0 |
| decode-raw | 2 | 17.2 / 17.3 | 19.3 | 0 / 0 | 17.7 | 0 |
| decode-raw | 3 | 17.6 / 17.1 | 19.1 | 0 / 0 | 17.8 | 0 |
| decode-only | 1 | 50.4 / 18.0 | 67.5 | 20 / 2 | 17.7 | 0 |
| decode-only | 2 | 33.5 / 33.4 | 51.2 | 1 / 0 | 17.8 | 0 |
| decode-only | 3 | 50.3 / 50.2 | 67.4 | 30 / 22 | 17.6 | 0 |

Hardware decoding three 4K streams, by itself, leaves the renderer's frame
pacing indistinguishable from idle. Adding `createImageBitmap` on each
hardware frame, with the result thrown away, is what stretches rAF to 50 ms.

## Readings

1. **The thread split changes nothing.** At three streams, `main`,
   `decode-worker` and `all-worker` all sit at a rAF p99 of 67–100 ms with
   75–87 gaps over 50 ms in 15 s and a composite interval p99 of ~100 ms. The
   `all-worker` arm, where the main thread executes no per-frame JavaScript at
   all, is the worst of the three in both repetitions. This reproduces the
   earlier in-app observation that moving the preview compositor into a Worker
   did not help.
2. **The main thread's JavaScript was never the bottleneck.** In every row the
   `setInterval(16)` cadence stays at a p99 of 17.5–18 ms and Long Tasks are
   zero, including the `main` arm at three streams. `createImageBitmap` on a
   hardware `VideoFrame` costs 0.3–1.3 ms at p99, not the 12 ms measured for
   CPU NV12 buffers in `poc/export-frame-transport`. The event loop is idle
   while rAF stretches to 83 ms: only vsync-driven frames are late.
3. **The disturbance is `createImageBitmap(VideoFrame)` on hardware frames.**
   `upload-only` pushes three 4K textures through Pixi every frame (≈3 GB/s
   of uploads) with a rAF p99 of 17 ms and zero drops. `decode-raw` decodes
   three 4K streams and is indistinguishable from idle. `decode-only` adds one
   `createImageBitmap` per frame, displays nothing, and stretches rAF to a p99
   of 50 ms. That call costs the renderer under 1 ms because the work happens
   in the GPU process: a copy (and for NV12 a colour conversion) from the
   decoder's texture into a shared image, on the same GPU main thread that
   issues the compositor's frames. The renderer sees it as late BeginFrames,
   and no renderer-side thread arrangement can change that. The frame-ring
   design (ADR 0004) snapshots every decoded frame into an `ImageBitmap`, so
   the production WebCodecs lane pays this on every frame.
4. **It is bimodal rather than linear.** One stream of `decode-only` is worse
   than two in three of four repetitions (50 vs 34 ms p99), and `main` at one
   stream is clean while `decode-only` at one is not. Treat these as GPU
   scheduling or power-state effects to be investigated with a GPU-side
   trace, not as a capacity curve.
5. **The lever is to stop copying.** WebGPU `importExternalTexture` samples
   the decoder's texture in place and `copyExternalImageToTexture` /
   WebGL `texImage2D` accept a `VideoFrame` directly; all of them avoid the
   shared-image snapshot. The cost is holding `VideoFrame`s until they are
   rendered, which is bounded by the hardware decoder's ~13-slot pool
   (ADR 0004), and the colour-trust rules of ADR 0021/0040 for which paths may
   convert YUV. Measuring those import paths under the same load is the
   obvious next arm; it was not part of this spike.

## What this does and does not cover

- This is the WebCodecs hardware lane. The production Windows path for
  originals is ffmpeg d3d11va with native-converted RGBA shared textures
  (ADR 0040); it shares the same GPU, but not the same decoder plumbing or the
  same copies, so its interaction with the compositor needs its own
  measurement inside the app (the calibration prototype is the existing tool).
- 4K/30 synthetic `testsrc2` content at 40 Mbps; no audio clock, no effects,
  no Motifs, no timeline UI.
- Sampled rAF is a proxy for "the playhead stutters". A GPU-process trace
  (`chrome://tracing` or ETW) would show which stage delays BeginFrame; this
  spike does not include one.

## Reproduce

Windows, from the checkout root with `node_modules` installed and the
decode-bench fixture generated:

```sh
node poc/preview-thread-split/run.mjs --tag=<name> --repeat=2
node poc/preview-thread-split/run.mjs --tag=<name> --arms=idle,decode-raw,decode-only
```

Results land in `poc/preview-thread-split/results/<tag>/` with a `summary.md`.
Over SSH the runner must be started by a scheduled task with an Interactive
principal, otherwise Electron has no desktop GPU (see
`apps/desktop/bench/hosts/pc.ps1` for the pattern). On Linux the spike runs
with `--no-sandbox --enable-unsafe-swiftshader` for a mechanics check only;
the numbers there mean nothing.
