# ffmpeg stall limit: progress alone is too slow a sign of life

Measurement, 2026-10-31. Question: can the ffmpeg watchdog
(`native/src/ffmpeg/child.rs`, `STALL_LIMIT`) stop a child after 60 s without
progress, with at least 5× headroom over the slowest software encode? **No:
libaom-av1 at 4K 10-bit went 78 s before its first frame.** Counting CPU use as
a sign of life closes the gap: no encoder went a second below 7% of a core,
and a wedged child sits at 0%.

## Probe and environment

- Bundled `resources/ffmpeg/linux/ffmpeg` n8.1.3-24-g92611900bb-20261026, the
  2-core Linux dev box, `-threads 2`.
- Input `testsrc2=size=3840x2160:rate=30,format=yuv420p10le`; each encoder at
  the slowest setting the export encoder registry selects.
- Gap: time between rises of `frame` / `out_time_us` in `-progress` output.
  ffmpeg prints a progress block every 0.5 s even when nothing moved, so a
  block on its own is no sign of life.

## Results

| Encoder | Frames | Worst gap | Where | Next gaps |
| --- | --- | --- | --- | --- |
| libx265 `-preset slow -crf 18` | 60 | 17.5 s | before the first frame | up to 8 s |
| libsvtav1 `-preset 6` | 60 | 13.1 s | before the first frame | 10.5 s |
| libaom-av1 `-cpu-used 4 -row-mt 1` | 20 | 77.7 s | before the first frame | 38 s |

- libaom fed through stdin, 12 frames: 32.6 s before the first frame. Its lag
  window is 35 frames; a 42-frame run did not finish within 290 s, so the gap
  for a full window is unknown and longer.
- 5× the libaom gap is at least 389 s, too long to be a useful bound.
- CPU, sampled each second through libaom's lag fill (170 s): never below 7% of
  one core. Longest stretch with no progress and under 1%: 0 s.
- A stuck stand-in (`-re -f lavfi -i color=…:rate=1/3600`) advanced once, then
  sat at 0.0% CPU. The wedged macOS VideoToolbox ffmpeg also sat at 0%
  ([note](macos-runner-videotoolbox-kill-2026-10-31.md)).
- Not covered: a child that spins without progress is never stalled (cancel
  still stops it). Not measured on macOS or Windows.
