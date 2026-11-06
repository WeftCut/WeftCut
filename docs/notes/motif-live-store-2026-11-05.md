# Motif live store: playback with every captured frame stored

Bench, 2026-11-05/06. Question: does storing every captured Motif frame
outside the capture lease (ADR 0158) speed up later passes without slowing the
first? **Yes on both capture hosts.** On the PNG host the utility lane, not
capture, then sets the limit at Full.

## Probe and environment

- A real 15 s project with 58 Motifs, cold cache, played pass after pass. Four
  interleaved runs per side (before / after) unless noted. The figure is new
  pictures per second, the median of each pass.
- Windows: Windows 11, i5-13400, RTX 3050, texture capture and texture lane.
- PNG host: the same machine booted into Linux, PNG capture, utility lane,
  WebGL preview.
- One slow run on this bench is noise; nothing here rests on a single run.

## Windows

| Pass | before | after |
| --- | --- | --- |
| 1 | 8.9 | 8.5 |
| 2 | 11.6 | 20.0 |
| 3 | 10.8 | 41.1 |

- Ticks with a Motif not ready on the third pass fell from 863 to 154 of 900.
  No frames dropped on either side.
- Late ticks (the preview's dropped-frames indicator) were about 35 per pass
  before; after, 41, 60 and 66 while capture and reads overlap. With coverage
  complete the project plays at 51 pictures per second with no Motif pending
  and 0–1 late ticks (fifth to seventh pass, one run).
- Readback inside the lease costs about 3 ms at 1080p (map 1 ms, copy out 2 ms).

## PNG host

- First pass 3.5 → 3.6, about 80 captures on both sides. Capture is the ceiling
  while warming, at about 155 ms a frame, of which the PNG takes about 110.
- Seventh pass 10.2 → 33.7; late ticks 75 → 153 of about 890, none dropped.
  After a restart the first pass runs at 36 instead of 3.7.
- From the fourth to the seventh pass after a restart (two runs) it holds at
  20–24 pictures per second, with a Motif pending on about three quarters of
  ticks. Without stored frames it reached 10.
- The utility lane is the limit there. A 1080p frame takes about 20 ms to cross
  from the utility to the reader worker, 13 ms of it blocking the utility's one
  thread, so reads top out near 50 per second with nothing else running. When
  playback falls behind, about 80% of prewarm frames arrive after the playhead
  has passed them. At 1/2 Playback Resolution the project plays at 51 pictures
  per second with no Motif pending and about 9 late ticks (six passes, two
  runs).
- macOS was not measured.

## Raster stability

Anti-aliased Motif content is not byte-stable across launches. An edge pixel of
text can come out one level apart (alpha 204 or 205): on bakes in 2 of 6
launches and live captures in 3 of 6. Integer-aligned rectangles came out
identical every time; `docs/agents/testing.md` (Pixel equality) has the test
rule that follows.

## Rejected while building it

- Mapping the staging texture after the lease, as OBS does a frame later. It
  needs a staging ring and proof that a released texture stays intact, and is
  worth it only if readback dominates what remains in the lease.
- Stacking several capture windows: 2–4 windows gave 5 wrong frames in 1,620,
  cause unknown.
