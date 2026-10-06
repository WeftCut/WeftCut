# Controlled playback calibration prototype

This experimental Windows test measures the production playback pipeline in an
isolated Electron process. Settings → Performance can start/cancel it and
save its recommendation, then apply it separately. Test media ships with Windows
builds; saved recommendations persist across restarts. The older
[project-based timing prototype](performance-calibration-prototype.md) remains
available for comparison.

## Coverage

| Configurable resource | First-version treatment |
| --- | --- |
| Concurrent hardware-decoded videos | Measure each count from 1 through 8 |
| Combined coded-pixel budget | Passing count multiplied by 3840 × 2160 |
| Per-video GPU buffer slots | Fixed at the shipping default during measurement; never recommended or overwritten |
| Frame, animation, filmstrip and waveform caches; animation GPU memory and sessions | Fixed baseline; not calibrated or overwritten |

Only `preview_gpu_sessions` and `preview_gpu_pixel_area` are measured in the
candidate family. A passing count of N does **not** imply 4N simultaneous 1080p
decoders. H.264 4K/60 fps is a reference, not certification of other workloads.
The current settings policy derives a shared-texture recommendation from that
load and copies the user's cache budget into the saved profile; these are not
additional measurements. See [performance settings](performance-settings.md).

## Run

In the app, open **Settings → Performance → Test this computer (experimental)**.
The editor pauses playback. **Save recommendation** records a result without
changing runtime settings. **Restore computer test profile** applies its budgets
and throughput guards. **Restore automatic** returns to product defaults without
deleting the saved result. Machine/build/protocol mismatches disable restoration.
Cancel, a closed test window or a failed run never applies settings. The owner
process also cancels testing on application exit. Test reports and the child's
isolated profile are retained beneath the OS temporary directory in
`weftcut-performance-calibration/run-*`.

Windows dev/build/E2E preparation generates or validates the synthetic reference;
the Windows package includes it via `extraResources/performance-calibration`.
Other platforms do not generate or package this currently unsupported test.

From `apps/desktop`, with native dependencies available:

```sh
npm run napi:build:decode
npm run bench:calibration:reference
npm run build:e2e
npm run bench:calibration:controlled -- --plan-only
npm run bench:calibration:controlled
```

The fixture generator uses FFmpeg's moving `testsrc2` at genuine 60 fps. It
produces 20 seconds of 8-bit H.264 High, 4K, approximately 40 Mbps, with an
eight-second GOP and no audio. Generation is outside the timed run. The local
reference is about 95.53 MiB. FFprobe checks its format, frame count and duration;
a SHA-256 manifest pins its bytes. `FFMPEG` and `FFPROBE` override the bundled
Windows tools. Generated media and reports are ignored by Git.

Both plan-only and execution verify the existing fixture. Execution records a
plan ID, JSON, HTML and a final screenshot beneath
`.scratch/performance-calibration/controlled-<timestamp>/`. The ID includes the
versioned protocol and fixture hash. Main and renderer reject mismatched build
protocols. Ctrl+C terminates the owned test process and preserves partial data;
a six-minute watchdog bounds an unresponsive run.

## Measurement contract

- Always run the fixed 1–8 sequence. Neither hardware identity, historical
  results, user budgets nor earlier cells select the starting point or skip
  later cells. Reproducible inputs do not imply identical measurements.
- The parent process first reserves the fixed run's estimated working memory in
  the app-wide resource authority. Insufficient capacity rejects the entire run
  before launch; it never changes the test scene or silently skips cells. The
  reservation lasts until the child exits, including cancellation and failure.
- Build scenes in memory. Do not create projects, import media, generate proxies,
  thumbnails or waveforms, or bootstrap the normal editor stores and jobs.
- Reuse native decoding, production GPU IPC, `FfmpegSource`, `FrameRing`, decoder
  pools, `Compositor`, `PlaybackEngine`, and the presented renderer's slot fence.
  Shared presentation initialization is used by both editor and test host.
- Decode originals at full resolution. Present a visible 4×2 layout in a
  3840×2160 composition at 60 fps, with a fixed 1280×720 backing canvas. Every
  requested video has an independent decoder and visible sprite.
- Read the adapter name, vendor/device IDs and LUID from each actual decoder's
  D3D11 device. Missing identity, changed devices, software fallback, stopped
  clock, missing presentation or an incomplete reset invalidate measurement.
- Reuse the Electron process and Pixi device across cells. Recreate the scene,
  compositor, decoder pool and audio clock; wait for native leases, frame rings
  and pending slot acknowledgments to reach zero. OS and driver caches are not
  reset. Native hardware support is freshly probed once per process.
- Start at two seconds, warm up for 1.5 seconds, then observe eight seconds.
  Record readiness, sampling and cleanup separately, along with one-second
  cumulative observations, actual PTS advances, presentation submissions,
  dropped/late counters and the longest unchanged frame.

The eight-second window and thresholds (2% dropped-plus-late frames and a
100 ms maximum hold) are **experimental**, not validated product defaults.
Summing dropped and late counters is conservative and can count overlapping
events. No frame progress with an otherwise functioning pipeline is a slow
result, not automatically an invalid experiment. Unsupported hardware or a
broken pipeline must never produce a performance recommendation.

## Candidate presets

Maximum uses the contiguous passing prefix of the eight measured counts.
Standard uses `floor(Maximum × 2/3)`; Less uses `floor(Maximum / 3)`. Each has a
one-video floor and the corresponding 4K pixel budget, so small capacities can
produce identical tiers. Fractions of budgets do not promise the same fractions
of free CPU/GPU resources.

If all completed cells are slow, the report labels a one-video configuration
as **conservative**, not a pass. Invalid, missing or duplicate cells suppress
the recommendation. The developer CLI never applies settings; the settings
integration requires an explicit user action.

## Local observations

On 2026-10-05, the actual decoder reported an NVIDIA GeForce RTX 3050 OEM. An
eight-cell run completed in 122.89 seconds: approximately 64.08 seconds sampling,
12 seconds configured warmup, 3.95 seconds first-frame readiness and 41.77 seconds
cleanup. Renderer preparation was 0.124 seconds, excluding process launch.
The report is `controlled-2026-10-05T15-49-26.867Z/report.json` under the scratch
directory. It contained no console/page errors.
All eight cells recorded successful presentation submissions. These counts can
exceed 60 per second on a high-refresh display; distinct decoded-frame advances
are measured separately against the 60 fps source.

One stream advanced normally; higher counts stalled. Normal-editor checks with
the same reference, 60 fps composition, layout and 1280×720 backing canvas also
exposed stalls. These observations do not establish a hardware limit: lifecycle
and playback behavior still need investigation, and the measurements are not
yet evidence that the two hosts have equivalent throughput. Keep recommendations
explicitly experimental while that comparison and repeatability checks remain open.

Cleanup is a material optimization target before shortening the sampling
window. A shorter media file alone does not shorten a fixed observation window.
The old 30 fps matrix used a different workload and cannot serve as a direct
speedup comparison.
