# Performance calibration timing prototype

Automatic hardware detection and in-app calibration are deferred. The product
currently provides fixed simple settings and presets; see
[Performance settings](performance-settings.md). This document preserves the
prototype, measurements and constraints for future work. Selecting a preset
does not run a benchmark.

This developer tool measures how long calibration takes and where time could
be saved. It is not the automatic calibration feature and does not derive machine
limits or preset mappings. The previously discussed 90–120 seconds was a user
experience target, not an estimate supported by measurements.

## Running

From `apps/desktop`, with native modules and the E2E build available:

```sh
npm run bench:calibration
```

Initial preparation requires `npm run build:e2e` and four synthetic fixtures.
Generate the shared 60-second sources, then the separate 20-second calibration
versions:

```sh
node e2e/scripts/gen-decode-bench-fixtures.mjs --only h264-1080,h264-2160,hevc-1080,hevc-2160
npm run bench:calibration:fixtures
```

Fixture generation requires FFmpeg. On Windows, the short-fixture generator
prefers the repository's bundled version; `FFMPEG` / `FFPROBE` can override the
paths. Build and fixture-generation time are excluded from calibration timing.

Calibration defaults to the separate 20-second files in
`e2e/fixtures/decode-bench/calibration-20s/`. It leaves the shared 60-second
fixtures used by other tests unchanged. The generator copies compressed packets
from the beginning of each source without re-encoding. It verifies every packet's
content and timestamp, plus resolution, format, frame rate and keyframes at
0/8/16 seconds. Actual duration is approximately 20.067 seconds because of frame
reordering at the end. Validation results are saved in `manifest.json` and
archived with each run's report. These assets are not shipped with the app yet.

Each run creates isolated settings, test projects, `plan.json`, `report.html`
and `report.json` under `.scratch/performance-calibration/<timestamp>/`. The
complete fixed plan is saved before measurement. Reports show its identifier,
execution status for each item and reasons for incomplete items. Normal user
settings and projects are not modified. Open the HTML in a browser; the JSON
retains raw playback and process snapshots taken every 500 ms. Reports are
written after each phase, preserving completed work after an error. Ctrl+C stops
the run. Test directories are retained for inspection rather than deleted.

To inspect the plan without launching the app, generating fixtures or building:

```sh
npm run bench:calibration -- --plan-only
```

The same test protocol version and explicit configuration produce the same plan
identifier. It covers test order, windows, seek targets, initial budgets and
isolation policy; it does not imply identical hardware or measurements. The
current plan does not skip stages based on hardware capabilities. Every video
fixture uses the same explicitly selected track counts.

## Test coverage

| Test | Default workload | Separately recorded overhead |
| --- | --- | --- |
| Video | H.264 / HEVC × 1080p / 4K; 30 fps, originals, full resolution | Separate launch, project creation, import and background-task wait per fixture |
| Concurrent playback | 1, 2, then 3 videos; repeat 3 videos | Adding layers, first-frame wait, warmup and sampling |
| Seeking | 10 s, 10.5 s, 16 s, 1 s; nearby, across-keyframe and backward seeks | Wait for all video layers to bind their target frame; 5-second timeout per seek |
| Animation | One 1080p video with countdown; first playback and replay | Adding animation, warmup and sampling; animation frame lag |

Each window defaults to 1.5 seconds of warmup and 4 seconds of sampling. These
are adjustable experimental parameters, **not validated sampling durations**.
The four video scenarios each have four windows, plus two animation windows:
18 windows in total, with a minimum of 72 seconds of active sampling and
27 seconds of configured warmup waits. Launch, preparation, first-frame waits
and seeking add time. Sampling time alone is not total elapsed time.

Short run:

```sh
npm run bench:calibration -- --only h264-1080 --tracks 1 --window-s 2 --warmup-s 0.5 --quiet-s 3 --no-motif
```

Longer-window comparison:

```sh
npm run bench:calibration -- --only h264-2160 --tracks 3 --window-s 12 --quiet-s 60 --no-motif
```

`--tracks` selects ascending track counts to observe, not a measured upper limit.
The last count is repeated. `--quiet-s` is the maximum wait for background work,
not a fixed sleep. A timeout flags possible interference; degradation during
that interval cannot be attributed directly to decoder capacity. `--no-seek`
and `--no-motif` help separate costs. See `--help` for all options.

`--fixture-set full` uses the original 60-second fixtures and restores the
24-second seek target for comparison or longer sampling. The default short
fixtures support 1.5 seconds of warmup followed by 12 seconds of sampling.
Custom windows must satisfy: 2-second start + warmup + sampling + 2-second margin
≤ fixture duration. The executor also checks remaining duration after warmup
to avoid mistaking end-of-stream for a performance failure. Shorter fixtures
do not shorten the 4-second sampling windows; they mainly reduce asset size
and work triggered by import.

## Interpreting results

- The prototype relaxes hardware-video admission only in isolated settings so
  default session-count and pixel-area limits do not truncate the test. Cache
  budgets and per-video buffer slots retain shipping defaults. Reports save
  the actual configuration.
- Each layer's original-source and hardware paths are checked before and after
  sampling. Software fallback is not a hardware pass. Samples record content
  clock, picture submissions, dropped frames, frame-interval p99 and per-layer
  decode counters. Picture submissions include repeated frames and are not
  equivalent to effective video frame rate.
- A short window without anomalies means only that this observation did not
  trigger the screening conditions. It proves neither stability nor the
  machine's maximum capacity. A result for three videos says nothing about four.
- Background preparation includes normal import-triggered proxies, analysis
  and timeline jobs. Whether in-app calibration can omit or prepare these in
  advance must be evaluated using the measured phase costs. Setting the wait to
  zero does not preserve comparability by itself.
- Animations use normal prebaking and caching. First playback is not strictly
  cold-cache playback, and replay does not guarantee all cache hits. Raw
  animation snapshots are available for inspection.
- The prototype does not measure cache capacity limits, waveforms, every
  animation type, continuous scrubbing, high bit depth, audio, thermal
  throttling, system-wide available graphics memory or GPU utilization. CPU
  statistics cover Electron processes, excluding standalone FFmpeg children.
  These results cannot populate every advanced setting or establish sustained
  stability.

Compare preparation and active-sampling costs first, then compare short and
long windows near the observed limit. Decisions to shorten tests should follow
measurements rather than a promised total duration.

## Future hardware detection and execution constraints

The following constraints have been agreed. Reporting the actual decoder GPU
identity is not implemented yet. The prototype uses fixed track counts from
explicit options, fresh settings and projects, and no history-based starting
point.

- **Do not schedule tests from historical results.** Previous local scores,
  run counts, recommended budgets and scores from similar machines must not
  select starting points, omitted stages or repeat counts. Historical reports
  are for viewing and comparison after a run.
- **Identify the actual decoding device.** Read identity from the native decoder
  session opened for this run. On Windows D3D11VA, the existing FFmpeg hardware
  device context exposes a D3D11 device whose DXGI adapter can provide its name,
  vendor/device IDs and a device identifier for this run. Neither the first GPU
  in Electron's list nor the desktop-rendering GPU establishes decoder identity.
  Check both probe and measurement sessions. Flag device changes or fallback
  during sampling instead of combining them into one hardware result. Report
  unknown identity explicitly when it cannot be established.
- **Fix initial conditions.** Make the test version, fixtures, initial budgets,
  app-controlled cache state and warmup rules explicit. Previous recommendations,
  daily advanced settings and persisted capability-probe caches must not change
  the starting point or omit the initial probe. Information from the current run
  may be reused within that run according to fixed rules.
- **Make plans inspectable.** Record hardware facts, test version, inputs,
  planned stages and skip reasons before measurement. Instantaneous free RAM or
  graphics-memory budget is for safety checks and environment reporting, not
  implicit selection of a higher starting load. Do not change user settings
  before testing finishes.
- **Controlled execution does not mean identical measurements.** Background
  load, temperature, driver scheduling and system caches can still affect timing
  and frame drops. Reports must distinguish test rules from observations.

**The selected design uses a fixed sequence.** Determine loads, order, windows
and repeat counts before measurement. Results from this run do not adapt later
stages: no adaptive load changes or early completion because performance clearly
passes or fails. If errors or cancellation prevent execution, retain the plan
and record why items were not completed. Do not substitute a lighter workload
and present it as completion of the original plan. Future capability-based
skips must also be decided before measurement using versioned rules and recorded
reasons.

Plan generation is a function without history inputs, and its result is frozen.
The executor consumes the plan's windows and seek sequence directly. Isolated
settings explicitly contain the complete initial budget, avoiding inheritance
from daily advanced settings. Node tests cover deterministic planning,
immutability and incomplete-run reporting.

## Local observations on 2026-10-05

The machine had an i5-13400 and approximately 32 GiB of RAM. GPU enumeration
listed an RTX 3050 OEM and UHD 730. The local summary report is
`.scratch/performance-calibration/review.html`; run subdirectories retain raw
snapshots. The initial run and first longer-window comparison below used the
original 60-second fixtures, now selectable with `--fixture-set full`.

The initial run took **194.57 seconds**: sampling 72.59 s, background waits
56.94 s, warmup 31.38 s, launch and project creation 18.98 s, first-frame waits
6.09 s, 16 seeks totaling 3.96 s, and other work approximately 4.63 s. Both 4K
background waits reached the 15-second limit. The initial animation lasted only
5 seconds and did not cover its entire window, so its performance conclusions
are invalid; its timings remain useful for process analysis.

In a longer-window comparison with three H.264 4K videos, background work became
quiet after approximately 16.33 s. Two 12-second windows recorded 51 and 186
dropped frames while retaining hardware decoding of originals. Approximately
the first 2 seconds of the first window showed only 3 drops and a frame-interval
p99 of 7.1 ms; the full window's p99 reached approximately 2518.7 ms. Short-window
frame intervals can miss later stalls. Both complete windows showed problems,
so the current three-video budget is not a validated stable upper limit.

The animation prototype now sets countdown's `seconds` property, validates the
layer duration and checks animation coverage in every sampling snapshot. A
separate first-playback/replay check with 4-second windows included animation in
8/8 snapshots for both windows. Maximum sampled lag was 4 frames initially and
1 frame on replay. Replay improved the observed frame lag.

The next candidate for improvement is import-triggered work and repeated
initialization. Earlier ideas to end warmup based on observed state or stop
early on clear performance failures are superseded by the fixed-sequence
decision above. Savings and false-negative rates for shorter tests have not
been established. Seeking took less than 4 seconds in total and is not the
first target for removal.

### Comparison with 20-second fixtures

The four videos decreased from **717.93 MiB to 243.29 MiB**, a 66.1% reduction.
Compressed packets and timestamps match the sources, retaining three keyframes.
Original fixtures and other tests are unchanged. Animation duration continues
to follow the sampling window, approximately 10 seconds with default options.

The complete short-fixture run took **169.62 seconds**, 24.95 seconds (about
12.8%) less than the initial run. Background waits fell from 56.94 s to 34.20 s;
playback sampling still took approximately 72.50 s. All 18 playback windows and
16 seeks completed; every seek succeeded, and video layers retained hardware
decoding of originals. Three H.264 4K videos still showed dropped frames, and
HEVC 4K still reached the 15-second background-wait limit.

These are two observations on one machine, not a repeated randomized comparison.
The earlier run had incomplete animation coverage; the later run used the fix.
Smaller files can reduce preparation work but cannot proportionally reduce
fixed sampling time. This observation does not establish the same benefit on
other machines.
