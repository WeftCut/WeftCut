# Motif texture capture: waiting for a frame id instead of settling

Probe, 2026-11-08. Question: can the shared-texture capture prove which seek a
texture shows, and what does that cost against the settle-and-restart wait it
replaces? **Yes, at no cost in speed.** The decision is in ADR 0078.

## Why a page-drawn id

Electron 44's offscreen output gives the host no handle on frame identity. Its
BeginFrame source is a timer with external control hard-coded off. The
capturer rewrites paint timestamps onto a smooth media clock, and Electron
drops the frame sequence from paint metadata. Even CEF's external BeginFrame
is not a capture contract: its maintainers report the matching paint can
arrive before the ack, and a reporter there synchronised on a marker pixel
instead. Pixels the page draws are the one signal that travels with the
commit that drew them.

The id goes into an extra row below the picture rather than into it: no reader
can restore a picture pixel it overwrote, and inverting or blending pixels
carries no id without knowing the original value.

## Probe and environment

- A standalone Electron 44.9.3 app, shared textures, Windows 11, i5-13400,
  RTX 3050. A native reader copies the 48×1 marker row on its own D3D11 device.
- All 61 Motifs of a real lyric-video project, 45 consecutive frames each at
  30 fps, at a 60 and a 240 Hz offscreen frame rate; arms interleaved per Motif
  in random order. The first two frames of each run are left out of timings.
- Every arm was checked on 6 frames per Motif and rate: frame k right after
  k − 1, compared byte for byte with the same frame captured again after
  150 ms of quiet in the same window.

Arms:

- **A** — the previous path: stop painting, render with two native rAFs, fence
  each new surface with a screenshot, restart painting and take the next paint.
- **D** — the decision: shell page and same-origin frame, id in an extra row,
  painting on, take the first paint carrying the id.
- **E** — the id drawn over the picture's last row; take the paint carrying
  it, remove it, take the first paint without it.
- **F / G** — D / E with a capturer restart per paint instead of waiting.

## Results

Per-frame median, ms:

| Arm | 60 Hz | 240 Hz |
|---|---|---|
| A | 52.6 | 52.3 |
| D | 48.1 | 57.8 |
| E | 65.2 | 62.4 |
| F | 69.3 | 51.5 |
| G | 98.2 | 67.8 |

- Checked frames: 3660 of 3660 exact across all arms. Of 24,470 timed frames,
  one timed out: D's first frame in the run's first window, which drew its id
  and then sent no paint for 1.5 s. The app restarts the capturer after
  200 ms without the frame; the restarted capture is checked like any paint.
- Paired by Motif, D against A: −3.1 ms at 60 Hz, −0.2 at 240. E against D:
  +11.4 ms (+25%) at 60 Hz, +2.6 (+6%) at 240.
- Removing E's id took 5–8 ms to paint; a content change on the lightest Motifs
  (1.3 ms of script) took about 29 ms at either rate, the heaviest about 60 ms
  after 48 ms of script. The wait is raster, not the BeginFrame clock, so a
  higher frame rate does not help.
- Reading the marker row: about 1 ms per paint on the reader's thread.

Not measured here: the app itself, slower GPUs, the PNG lane.

## In the app

- A `Page.captureScreenshot` with a `clip` on the capture host left a WebGL
  Motif's later frames blank (Three.js template, first frame right, every later
  frame transparent at any time; the context was not lost). Without `clip` the
  same e2e passed. So a PNG host gets no marker row, and a PNG capture on a
  texture host drops the row from the PNG instead: a scanline's filter reads
  only the line above, so cutting the last lines needs no pixel decode.
