# playback-perf

A local-only benchmark of the **whole preview playback loop** under N
simultaneous video tracks: tick → anchor → composite → present. Where
[decode-bench](decode-bench.md) profiles one clip at the `DecodeSession` seam,
this names which *stage* is the wall and at what *track count*. Script:
`apps/desktop/e2e/scripts/playback-perf.mjs`. Results and lessons so far:
[playback-perf findings](notes/playback-perf-findings-2026-07.md).

It is an instrument, not a gate: exit `0` when the matrix completed, `2` when
the run could not be *measured* (no build, no hook, no fixture) — never
non-zero because playback was slow. GPU numbers off a headless runner are
meaningless, so it never runs in CI.

## Running it

Windows for the ffmpeg-hardware route; software and WebCodecs routes are
cross-platform. From `apps/desktop`:

```bash
npm run napi:build && npm run napi:build:decode   # close the dev app first; it locks the .node
npm run build:e2e                                  # the __weftcutTest hook; plain build tree-shakes it away
cd e2e && npm run bench:decode:fixtures            # shared fixture matrix (~2.5 GB, gitignored)
npm run bench:playback                             # from e2e/
```

The bench drives the built bundle in `out/`, not the dev server: rebuild
`build:e2e` after every renderer change you want measured. `npm run e2e --
--playback-perf` runs it after Playwright.

| flag | default | notes |
|---|---|---|
| `--codec h264,hevc,prores,hi10p` | `h264` | fixture is `<codec>-<resolution>` from `BENCH_MATRIX` |
| `--resolution 1080,2160` | both | composition is created at this size |
| `--route hw,sw,webcodecs` | all | see route pinning |
| `--max-tracks N` | 8 | sweeps 1..N, stops after 2 consecutive non-smooth cells |
| `--tracks 1,3,5` | — | explicit list; disables the early stop |
| `--window-s` / `--warmup-s` | 20 / 5 | measured window and warm-up |
| `--replay-after-warmup` | off | pause, seek to 2 s, replay; counters reset only after every ring brackets the playhead for four 250 ms polls (30 s miss = invalid). Use for heavy spill cells |
| `--barrier MODE` | shipped | hardware read barrier (`HwBarrierMode` in `src/shared/ipc.ts`) |
| `--playback-resolution` | `full` | diagnostic only, never a comparison axis |
| `--trace` / `--ui-probe` | off | Chromium trace (read with `trace-gaps.mjs`) / input-latency probe; perturb the cell, diagnostic only |
| `--tag NAME` | — | suffixes the report file |
| `--report PATH` | — | re-render tables from a saved report |

Each cell is its own app launch over a throwaway `--user-data-dir` (a sticky
per-source downgrade cannot leak), ~60–100 s per cell. Reports go to
`apps/desktop/e2e/bench-results/playback-perf-<date>-<sha>[-<tag>].json`,
rewritten after every cell.

## What a cell is

`(codec, resolution, route, track count)`: a project whose composition matches
the fixture, N clips of one shared media on N tracks, played for a window.

**Route pinning.** All routes use one fixture, so comparisons are never
codec-confounded:

| route | `decode_engine` | env | expected `sourceKind` |
|---|---|---|---|
| ffmpeg hardware | `ffmpeg` | `WEFTCUT_FORCE_HW_LANE=d3d11va` | `native-gpu` |
| ffmpeg software | `ffmpeg` | `WEFTCUT_FORCE_HW_LANE=nvdec` | `sw` |
| WebCodecs | `webcodecs` | — | `webcodecs` |

Windows never advertises `nvdec`, so naming it resolves software before any
probe or `decode_capability.json` write. Every layer is verified through
`activeClipProbe` before and after the window (`sourceKind`, `hwLane`,
`builtFromKey` carrying `:original:`); drift is reported, never published under
the requested label. Hardware cells past the admission budget are legitimately
mixed (`routePure: false`, e.g. 4K × 4–5 tracks = 3 GPU + formal software spills).

**Pinned conditions.** `playback_resolution: full`; `prefer_proxies` false via
the test hook (the raw IPC command does not reach the renderer store); a
per-media override forces Original; both are read back into the cell.

**Quiet gate.** Before measuring, total Electron CPU must stay under 20 % *and*
the derivative-job pill must be absent for four consecutive polls; low CPU
alone passes in the gaps between ffmpeg jobs. A 300 s miss makes the cell
`InvalidRun`. Playback starts 2 s into the 60 s fixture; the window opens only
once `positionUs` is observed advancing, and counters reset after warm-up.

## What it measures

- **Stage timers** (`renderer/render/perf/stageTimers.ts`): `tickInterval`,
  `rafInterval`, `rafLag`, `tickTotal`, `clockTick`, `anchor`, `composite`,
  `audio`, `sceneRebuild`, `layerSweep` and its per-layer sub-stages
  (`ringLookup`, `bitmapUpload`, `blitDrawImage`, `nv12Ingest`, `tenBitIngest`,
  `effects`), `transitions`, `present`. Per-layer stages sum into one per-frame
  total; stages that did not fire record nothing. `tickInterval ≈ rafInterval +
  Δ rafLag`. `present` runs at `UPDATE_PRIORITY.LOW` and lands in the next
  frame's bucket. Profiling is off by default (`stageNow()` returns 0); the bench
  enables it via `__weftcutTest.stageProfilingSet`.
- **Where a tick gap went**: `long-animation-frame` + `longtask` observers and
  an 8 ms `setInterval`, installed by the harness (not `stageTimers.ts`, which
  must not allocate or post tasks). Decision tree: no long frames → the gap
  never reached this thread; script attribution → our JS outside the tick;
  long frames, no script, stalled timer → thread blocked outside script;
  long frames, no script, healthy timer → thread alive, lost a rendering
  opportunity.
- **Decode and delivery** per clip from `Compositor.getPerfSnapshot()`.
- **Frame fate** (`FrameRingFate`, diffed over the window): `pushed`, `stale`
  (refused on arrival), `evict✗`, `flush✗`, `hit`, `clamp`, `repeat`,
  `miss empty`/`miss gap`. `FfmpegSource` counts accepted frames, WebCodecs
  counts frames offered, so a refused frame reads as low fps on one and
  full-rate-into-an-empty-ring on the other; `stale` reads the same on both.
  `repeat` is judder the dropped-frame indicator cannot see; its healthy
  baseline is `presented fps ÷ comp fps` (~50 % at 30 fps on 60 Hz).
- **Conversion backlog** (WebCodecs): outputs awaiting `createImageBitmap`, each
  pinning a hardware decode-pool slot.
- **Hardware read barrier**: p50/p95/max, sample count, thread-seconds per
  wall-second, `fence forced waits` and spin cost. Do not difference a
  `readback` p50 against a deferred mode's.
- **Resources**: per-process CPU/memory from `app.getAppMetrics()` at 2 Hz;
  Windows `typeperf` `VideoDecode`/`3D` engine counters at 1 Hz (machine-wide,
  empty off Windows).
- **Motif reads**: per-Motif rows and the `perf.motifReader` snapshot (lane
  reads, misses, fallbacks, `scaleDiv`, median stage times). Motif frames are
  read at Playback Resolution
  ([ADR 0154](adr/0154-motif-frames-are-read-at-preview-scale-through-one-reader.md)).

## Verdict

| failure mode | smooth requires |
|---|---|
| decode starvation | dropped frames ≤ 1 % of comp frames |
| paint collapse | presented fps ≥ 90 % of the leg's 1-track baseline |
| judder | `tickInterval` p99 ≤ one comp-frame budget |

The judder criterion catches a loop stalled by a synchronous wait, which
presents late but never selects a stale frame and so reads as zero drops.
**Max smooth tracks** is the largest monotone smooth prefix.

## Trusting a number

- **Quiet machine.** GPU counters are machine-wide; close anything that
  decodes or renders, including a second app instance.
- **Same session, shapes not milliseconds.** Absolute numbers drift 15–25 %
  over ~2 h of benching (tracks GPU state via the barrier). Run baseline and
  candidate back to back (`--tag base`, `--tag cand`, rebuilding `build:e2e`
  between) and compare ceilings and ratios.
- **WebCodecs magnitudes are one sample each**; read ceilings, and repeat before
  recording a changed ceiling.
- **Check validity columns first**: `lanes`/`routePure`, `routeDrift`,
  `quietReached`/`quietGate`, `replayGate`, barrier sample count. Errored cells
  report `{kind: "error" | "invalid"}` and the batch continues.
- For admission expectations read `window.api.previewGpu.budget()`
  (`sessions`, `codedPixelArea`); main's reservation stays authoritative.

Read the report in order: verdict and limiting reason → tick p50 vs p99 (p99
many times p50 = stalled, not overloaded) → `rafInterval` vs `rafLag` and the
tick-gap table → `ms per wall-sec` *before* share of `tickTotal` (the tick has
never exceeded ~1 ms of a 16.7 ms budget) → barrier, CPU split, ring depth.
Deeper fields (`ringAtEnd`, `perClip[].barrierN`, `longFrames.frames[]`,
`timerCadence.worst`) live in the JSON cell.

Traps that have produced wrong conclusions:

- A green gate may not have exercised the variant; report what was *applied*.
  A negative control must fail in the right shape (`--barrier none`: every Δ a
  multiple of `pool_size`).
- A scripted play that no-ops reads as a perfect cell; assert the playhead moved.
- Price minority-of-frames costs with a sum; any percentile hides them.
- Renderer counters cannot see producer-side waste inside libavcodec; probe
  natively (a `#[ignore]` test driving `SwVideoStream` A/Bs in seconds).
- Two similar magnitudes are not a shared cause; remove the suspect and re-measure.
- A replay clock tick is not decoder recovery; keep the ring-coverage gate.

## Extending

- **Fixture**: add a `<codec>-<resolution>` row to `BENCH_MATRIX` in
  `e2e/scripts/gen-decode-bench-fixtures.mjs`.
- **Stage**: add to `STAGE` and `STAGE_NAMES` in `stageTimers.ts`, bracket with
  `stageNow()`/`stageAdd()`, add to `HOT` in `playback-perf.mjs` to print it.
  Never call `performance.now()` directly in an instrumented hot path; probes that
  allocate or post tasks belong in the harness.
