# Decode-strategy benchmark (decode-bench)

A permanent, local-only benchmark of preview decode at the `DecodeSession`
seam, the same seam [`SourceDecoderPool`](preview.md#decode) uses in the app.
It compares decode strategies on the identical original file and supplies the
numbers behind the native-decode deferrals (zero-copy, hardware export
readback; ADR 0029).

- Driver: `apps/desktop/src/renderer/render/decoder/decodeBench.ts`. It owns a
  private `SourceDecoderPool`, never the app's, so runs are deterministic.
- Orchestrator: `apps/desktop/e2e/scripts/decode-bench.mjs`, over Playwright
  `_electron` like the [conformance suite](conformance.md). One app session
  per fixture × run, strategies run serially.
- Fixtures: `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs`, 60 s
  synthetic clips: `h264-1080`, `h264-2160`, `hevc-1080`, `hevc-2160`,
  `vp9-1080`, `av1-1080`, `hi10p-1080` (HEVC Main10; the name is historical),
  `prores-1080`, `prores-2160`, `dnxhr-1080`, `mpeg2-1080`. VC-1/WMV3 has no
  fixture: ffmpeg has no encoder for it.

## Strategies

| `--strategy` | Path | Where |
| --- | --- | --- |
| `webcodecs` (default) | Lite engine, in-renderer `VideoDecoder` over `weftcut-media://` Range reads | all |
| `native` | Standard engine `FfmpegSource`, `forceLane: "hardware"`: d3d11va → RGBA shared texture → `GpuTransport` | Windows |
| `sw` | Standard engine `FfmpegSource`, `forceLane: "software"`: libavcodec → NV12/I420P10 bytes → `SwTransport` | all |
| `native-copyback` | Standard engine, lane **not** forced; NVDEC/VAAPI/VideoToolbox → `av_hwframe_transfer_data` → `SwTransport` | Linux, macOS |

- `native` covers what d3d11va may host: 8-bit H.264/HEVC/VP9
  (`shared/hwLaneEligibility.ts`). 10-bit shared-texture import is blocked, so
  `hi10p-1080` has no `native` cell.
- `sw` covers the WebCodecs-blind rows (ProRes, DNxHR, MPEG-2). `sw` cells on
  interframe rows are run only as baselines for `native-copyback`.
- `native-copyback` on Linux covers 8-bit H.264/HEVC/VP9; on macOS the
  VideoToolbox lane also admits ProRes and 10-bit. Forcing `hardware` on
  Linux/macOS would route to the Windows-only `GpuTransport` and silently fall
  back to software, so the driver feeds `pickInitialLane` the fixture's codec,
  pixel format and size and lets the real one-frame probe resolve the lane.
  The orchestrator sets `WEFTCUT_FORCE_HW_LANE=<--hw-lane>`, which pins main's
  `decodeCap:probeHw` walk to that lane. Every result records `hwLane`, and a
  run that resolved to software is an error
  (`native-copyback: resolved to software …`), never a mislabelled number.

## Scenarios

- **Throughput** (`throughput`): 2 s warm-up, then a 30 s window with the
  request anchor at the ring frontier and the ring evicted (`setAnchor`) every
  tick. `fps` = `FrameRing.pushCount` / wall seconds; **×realtime**
  (content-seconds per wall-second) is the headline. `endedAtEof` marks a
  fixture drained before the window ended.
- **Seek** (`seek`): 40 targets cycling forward-near (+0.2 s), forward-far
  (+15 s), backward-near (−0.5 s), backward-far (−20 s); each sample is
  `requestFrameAt(T)` → `ring.containsPts(T)`. The ring is never cleared, so
  in-ring hits and real seeks separate by category. P50/P95/max per category.
- **Cold start** (`coldstart`): 10 × `acquire()` → `requestFrameAt(5 s)` →
  first frame → `release()`; iteration 1 is reported apart from 2–10.
- **Resources** (throughput window only): per-process CPU from
  `app.getAppMetrics()` at 2 Hz (native decode lands in **main**, WebCodecs in
  renderer + GPU). GPU engines from Windows `typeperf` (`VideoDecode`, `3D`)
  at 1 Hz; on Linux `native-copyback` streams `nvidia-smi` decoder
  utilization (`dec mean %`, NVDEC only, not the copy/PCIe engine). Both are
  machine-wide; macOS has no GPU sampler. A fast decode that drains the fixture
  in ~2 s yields ~1 GPU sample, so its column can read `—`.

Each scenario has a 90 s timebox.

## Harness contracts

- **The throughput driver must evict the ring.** `FrameRing` evicts only on
  `setAnchor`. Without it every frame stays resident (~8 MB per 1080p
  ImageBitmap); after ~1300 frames d3d11va surface allocation fails beside
  Chromium's GPU process, the session halts, and `frames ÷ 30 s` reports a
  false ceiling ~30× too low. A native reading that is a low fixed multiple of
  realtime with `endedAtEof` false means suspect eviction first (the pool-sweep
  `eofReturns`/`finalEof` columns flag the halt).
- **Throughput is bounded by feed rate**: the driver re-nudges on a polling
  cadence (`--throttle-ms`, default 10) and the pump caps in-flight input, so a
  decoder far faster than WebCodecs can saturate `fps`; ×realtime plus
  `endedAtEof` still show the margin.
- **Near-realtime lanes re-decode.** Re-requesting at the frontier re-decodes
  the GOP prefix on a lane that is not much faster than realtime (NVDEC
  `h264-1080`: `pushCount` ~710 vs ~180 unique frames). Decoder utilization on
  those lanes is driver-inflated, not a saturation ceiling, and unchanged by
  `--throttle-ms 0`.

## Findings

**Windows `native` (d3d11va).** The hardware decoder sits mostly idle at 1080p
and 4K; throughput beats WebCodecs at both, and seek latency (`av_seek_frame` to
the nearest keyframe plus a short decode-forward) is decisively better. The
per-frame poke → `createImageBitmap` → ack round-trip is a minor share of the
frame interval at 1080p and grows with pool depth at 4K without capping
throughput, so there is no case for reworking the per-frame coordination.

**Linux NVDEC, RTX 3050** (`h264-1080`, 3 runs, `3b961042`): ~22–24 fps,
~0.20×realtime (re-decode churn above), NVDEC util ~88 % mean, CPU main ~4 %
/ renderer ~1.4 %; seek P95 forward-near/forward-far/backward-far
~75/~460/~865 ms; cold first frame ~435 ms. `hevc-1080`/`vp9-1080` run at
similar fps with ~50 %/~37 % util.

**Linux VAAPI, Intel iGPU** (3 runs, `7fbdc75e`): `h264-1080`, `hevc-1080`,
`vp9-1080` all resolve `hwLane: vaapi` at ~14 fps (~0.1×realtime), forward-far
P95 ~1.1–1.2 s, cold first frame ~0.6–0.75 s; same churn shape as NVDEC.

Host CPU for copy-back is already near zero, so zero-copy DMA-BUF and hardware
export stay deferred. A forward-only drive that isolates the copy-back lane's
true decode rate and PCIe cost has not been built.

**macOS VideoToolbox, base M1** (3-run medians, `e7315089`):

| fixture | lane | fps | ×realtime | CPU main / renderer % | seek fwd-far P95 ms | cold first ms |
|---|---|---|---|---|---|---|
| `h264-1080` | software | 430.2 | 14.3 | 54.7 / 15.2 | 342 | 214 |
| `h264-1080` | videotoolbox | 253.5 | 8.5 | 9.6 / 9.3 | 1225 | 678 |
| `hevc-1080` | software | 390.6 | 13.0 | 54.0 / 14.6 | 423 | 247 |
| `hevc-1080` | videotoolbox | 261.0 | 8.7 | 9.6 / 9.0 | 1123 | 643 |
| `hi10p-1080` | software | 307.1 | 10.2 | 59.8 / 12.0 | 589 | 369 |
| `hi10p-1080` | videotoolbox (I420P10) | 157.7 | 5.3 | 14.9 / 14.5 | 1347 | 856 |
| `h264-2160` | software | 92.2 | 3.1 | 48.2 / 13.9 | 1329 | 831 |
| `h264-2160` | videotoolbox | 75.7 | 2.5 | 9.1 / 13.1 | 3323 | 2103 |
| `prores-2160` | software | 59.1 | 2.0 | 39.3 / 10.2 | 183 | 33 |

The lane buys main-process CPU (~3–4× less per frame, ~2× for 10-bit), not
fps: Apple Silicon software decode is faster, and VideoToolbox session
open/reopen makes cold start and far seeks 2–3.5× slower. Base M1 has no
ProRes engine (platform-codecs boundary 11), so `prores-2160` has no
videotoolbox cell.

### macOS VideoToolbox copy-back

The ProRes headline case needs an M1 Pro/Max or M2+ host (tracked in #35).
From `apps/desktop/e2e`, after `npm run bench:decode:fixtures`:

```bash
node scripts/decode-bench.mjs --strategy sw --fixture prores-2160 --runs 3
node scripts/decode-bench.mjs --strategy native-copyback --hw-lane videotoolbox --fixture prores-2160 --runs 3
```

On a host without a ProRes engine the second command errors
`native-copyback: resolved to software`; that is the probe declining.

## Scope

- Same-source pairing only: it answers "which decoder is faster", not
  "original vs proxy" (the quick proxy's scrub advantage is out of scope).
- Not a CI gate: hosted runners have no GPU decode engine. CI does build and
  unit-test the native-decode component on all three OSes and generates the
  `dnxhr-1080,mpeg2-1080` fixtures for the `@serial` software-family gates.
- Informative, not pass/fail: the exit code is non-zero only on a harness or
  `--self-check` failure.
- Known asymmetry: WebCodecs reads through `weftcut-media://` Range requests
  (`MediaRangeSource`), native strategies read the file path. That is each
  path's real I/O cost and is not normalized.

## How to run

From `apps/desktop`:

```bash
npm run napi:build            # core addon; close the dev app first (it locks the .node)
npm run ffmpeg:fetch          # ffmpeg/ffprobe sidecar
npm run build:e2e             # build with the window.__weftcutTest hook
# for native, sw, native-copyback:
npm run ffmpeg:fetch-lgpl     # LGPL FFmpeg dev libs into resources/ffmpeg-lgpl/<os>
npm run napi:build:decode     # @weftcut/native-decode; needs libclang (FFMPEG_DIR defaults to the fetched dir)
```

`napi:build:decode` sets `LIBCLANG_PATH` only on Windows; macOS and Linux find
libclang through Xcode CLT / `libclang-dev`. On Windows the `native` strategy
also needs `resources/ffmpeg-lgpl/win/bin` on `PATH` at run time.

From `apps/desktop/e2e`:

```bash
npm run bench:decode:fixtures   # idempotent; --only a,b for a subset (full set is ~10 GB), --force to regenerate
npm run bench:decode            # full matrix, webcodecs strategy
```

`$FFMPEG` / `$FFPROBE` override the PATH lookup. Flags (after `--` via npm):

- `--strategy webcodecs|native|sw|native-copyback`
- `--hw-lane nvdec|vaapi|videotoolbox` (default `nvdec`; `native-copyback` only)
- `--fixture <name>|all` (default `all`)
- `--scenario throughput|seek|coldstart|all` (default `all`)
- `--runs N` (default 3; the table shows medians)
- `--pool-size N` / `--pool-sweep` (`native` only; shared-texture pool depth,
  default 3; the sweep runs throughput at 3, 6, 9, 12)
- `--throttle-ms N` (driver pacing, default 10; 0 = unthrottled)
- `--self-check`: WebCodecs throughput twice on `h264-1080`; exits 1 if the
  two `fps` readings differ by ≥ 5 %. Run it after changing machine or
  drivers.

Run on a quiet machine: the GPU counters are machine-wide.

## Report

Each run writes `apps/desktop/e2e/bench-results/<date>-<gitsha>.json`
(gitignored; pool sweeps add `-poolsweep`) and prints a markdown table.

```
{ env, strategy, runs, cells: [ { fixture, perRun: [ … ] } ] }
```

- `env`: Electron/Chromium, GPU device IDs, ffmpeg version, git SHA, platform,
  date.
- `perRun[]`: one entry per repetition keyed by scenario, each a
  `BenchResult`. The table shows medians of fps, ×realtime, forward-far P95,
  cold first frame, mean GPU decode %, and `hwLane`.
- A failing scenario reports `{ kind: "error", error }` (a timebox reads
  `timeout after <n>ms in phase <phase>`); a session that dies records
  `{ harnessError }` for that run and the batch continues.
