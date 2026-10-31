# playback-perf findings — 2026-07-26/27

What the [playback-perf](../playback-perf.md) matrix established. Point-in-time:
re-measure in one session before relying on absolute numbers.

**Environment.** RTX 3050 + i5-13400 (16 threads), Electron 42.4.1 /
Chromium 148, 60 Hz display, 30 fps compositions, H.264/HEVC `yuv420p` GOP 240
(`keyint=240 scenecut=0`), proxies off, `playback_resolution: full`, one media
on N tracks. Commits `c759ec2e`..`7671c078`.

## Max smooth tracks

| leg | max smooth | limit |
|---|---|---|
| 1080p H.264 ffmpeg-hw | 5 (not reached) | tick p99 ~17 ms, 0 % drops at 5 |
| 1080p H.264 ffmpeg-sw | 2 | 3 tracks: tick p99 119 ms (main thread stall, see below) |
| 1080p H.264 webcodecs | 2, marginally 3 | 3 tracks: 0–28 % drops across sittings; decode capacity |
| 1080p HEVC ffmpeg-hw | 5 (not reached) | tick p99 18.1 ms at 5 |
| 1080p HEVC webcodecs | ≥ 5 | best leg: 0 % drops, p99 ≤ 25.2 ms |
| 4K H.264 ffmpeg-hw | 1 reliable, 2 intermittent | 2 tracks: 3/5 runs smooth; failures are a live thread losing rendering opportunities |
| 4K H.264 ffmpeg-sw | 0 | 94 % drops at 1 |
| 4K H.264 webcodecs | 0 | tick p99 75–82 ms with 0 drops |
| ProRes 422 / HEVC 10-bit 1080p | 1 (ffmpeg-sw only) | 2 tracks fail on tick tail |

The 1080p H.264 hw-vs-webcodecs result (5 vs 2) plus decode-bench's seek axis
decided that `auto` prefers the Standard (ffmpeg) engine
([preview](../preview.md#decode-engine)). The hardware route also records zero
long animation frames in every 1080p cell; WebCodecs records 2–5 per cell.

## The loop is not the bottleneck

`tickTotal` is 0.2–0.9 ms and `present` 0.2–0.4 ms (2–6 % of budget) in every
cell, while failing cells reach tick p99 38–140 ms. Measured non-levers — do not
re-optimize: snapshot `drawImage` blit (≤ 0.2 ms p95; keeps zero-copy upload
parked), `ringLookup`, audio sweep, `removeChildren`, effect sync (each ≤ 3 % of
the tick), `nv12Ingest` at 1080p (p95 1.3 ms; 9 ms at 4K), VideoDecode ~5 % per
1080p hardware track. Pixi GC runs every 30 s, far slower than the stalls.

## A tick gap is the main thread stopping

An independent 8 ms `setInterval` loses cadence exactly in failing cells
(1080p sw ×3: 903 fires, max 107 ms, 40 gaps > 50 ms) and holds it in passing
ones. Across 96 long frames there was no script over 5 ms and no `longtask`;
89–99 % of each long frame lies before `renderStart`. Large `rafInterval`s are
integer multiples of the vsync. The thread is waiting (1.5–8 % of a core), not
computing, outside Chromium's task accounting. Causes differ by route:

- **ffmpeg-sw follows bytes**: 3 × 9.33 MB NV12 per frame over IPC (≈ 280 MB/s).
  At ¼ playback resolution the same 3-track cell is perfectly clean (p99 17.1 ms,
  0 long frames). Hardware and WebCodecs are smooth on the same canvas.
- **4K WebCodecs follows `ImageBitmap` size**: 33.2 MB GPU-backed bitmaps
  created/closed 30×/s; 4× allocation for 1.34× bandwidth gave 4–6× the stalls.
  GPU engines are identical to the smooth 4K hardware cell (VideoDecode ~49 %).
  Later isolated to `createImageBitmap(VideoFrame)` in the GPU process
  ([thread-split spike](preview-thread-split-2026-10-26.md)).
- **Raster size is not the 4K wall**: ¼ resolution left 4K hw/WebCodecs tails
  unchanged (71.3 → 71.7 ms, 74.3 → 76.3 ms).

## Hardware read barrier

A pool slot may recycle only after Chromium's read GPU-completes. A synchronous
drain costs ~20 ms per frame regardless of size (1080p 19.3 ms, 4K 20.8 ms,
¼ res 20.8 ms) — a fixed flush wait, 0.29–0.71 thread-s/s, ~20× the whole loop.
Deferred barriers fixed it; the shipped `rendererFence` signals on the
presenting device. For the deadline (`FENCE_DEADLINE_MS`), tighter is strictly
better on an idle GPU: 33.3 ms → p99 23.7 ms smooth, 66.7 ms → 34.1 ms stutter.
The ordering spec is a release gate: under `--barrier none` pixel cells fail on
mismatches only.

## Hardware admission

Main admits a GPU preview only if both fit: 5 concurrent sessions and
24,883,200 coded pixels (3 × 3840 × 2160, calibrated at 30 fps; not a pixel
rate). Why:

- 1080p: raising a fixed cap 3 → 5 made 5 HEVC tracks smooth (43.7 % drops →
  0 %) at VideoDecode 11–24 %.
- 4K: three sessions run at 91.9 % VideoDecode; a fourth starved all four
  (99.9 %, 0 fps each, 89 % drops). A plain cap of 3 was not enough either: two
  full-size software spills froze the renderer 17–36 s.
- So a genuine budget refusal above 1080p spills to software at 960×540 and
  half cadence (decode references, skip unselected frames before copy-back).
  Verified 3/3 runs for 4K HEVC and H.264 at 4 and 5 tracks: 0 % drops, every
  ring tracking (H.264 tick p99 43–58 ms = the 4K intermittency, not the cap).
- The slot pool did not size this: the cliff was VideoDecode load; memory was
  mostly the resolution-blind `FrameRing`.

## Fixed mechanisms worth remembering

- **ffmpeg-sw re-seeked every request**, then emitted a 4-frame burst: 137×
  decode amplification on long GOPs, 4× duplicates on intra. Renderer counters
  all read healthy; only a native probe saw it. Fixed by a cross-request cursor
  (`FORWARD_CONTINUE_US` 1 s) and honoring `isLookaheadFull()`.
- **WebCodecs re-seek livelock**: once a clip fell > `FORWARD_SEEK_RESET_US`
  behind, the far-forward reset seeked to a key up to 8 s back, the latch keyed
  on the moving target never held, and every pass re-flushed (1722 stale
  frames, 73 % drops at 3 tracks). Fixed by latching on the key packet
  (`seekedKeyTimestamp`) and flushing only on `backward-beyond-ring`.
- **`FrameRing` is a time window** (1 s ahead, 0.5 s behind), blind to frame
  size: one 4K WebCodecs clip retains ~1.9 GB of bitmaps. A byte budget did not
  fix the livelock; a tighter one made it worse.
- **10-bit on the software route** reached the compositor as 8-bit NV12
  (`tenBitIngest` never fired): a fidelity gap, per ADR 0029.

## Measurement hygiene learned

- The old CPU-only quiet gate returned after ~1.55 s while derivatives still
  ran; 4K results from it (67/68 ms) are invalid. The derivative-pill gate waits
  ~15 s on a fresh 4K import.
- A machine-wide d3d11va outage once yielded zero GPU sessions across seven
  launches; it recovered after ~10 min idle. Keep `*-envfail` artifacts apart.
