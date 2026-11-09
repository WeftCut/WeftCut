# Motif seek hold: why seeks still flashed black

Probe, 2026-11-09. Question: a seek onto a Motif still showed the black canvas
for a moment although the preview holds its last picture while a Motif has
nothing to show. Was the 500 ms hold too short, or did a failure end it?
**Neither, mostly: the hold was timed from an earlier visit.** The fix and the
hold's rules are in `docs/motifs.md` §Compositor.

## Probe and environment

- The Windows bench (Windows 11, i5-13400, RTX 3050), shared-texture lane,
  default `captureHosts` (2), an e2e scratch project at 1920×1080 and 60 fps
  holding copies of a real lyric-video project's 52 Motif drafts, 61 spans back
  to back with nothing under them. Three runs, Pre-bake on in two.
- A temporary log of every hold's start and end (frame shown, limit reached,
  failure with its code), where each first frame came from, and every capture
  window opened. Pixel samples about every 80 ms forced composites, which
  shifts timing a little.

## Results

- A hold's start time outlived the visit. It was cleared only while the Motif
  was on the playhead, and a seek, play or pause did not clear it. A Motif
  left before its frame landed came back with a hold already past its limit:
  seek onto it, leave after 40 ms, return 1.5 s later: black on 6 of 6 returns
  without Pre-bake, for 28–63 ms each. During playback, crossing into a Motif
  touched 10 s earlier showed no hold and 310 ms of black. With Pre-bake on,
  0 of 6, because its frames were already in memory.
- The limit itself was rarely reached. A paused cold seek's first frame took
  p50 240–295 ms, p95 336 ms at most; a frame captured for a seek took at most
  497 ms. Only the first Motif after the project opened ran past 500 ms.
- Failures: every one seen was `superseded`, which never counted. A
  `capacity` refusal ended a hold in a user's live session once; it could not
  be reproduced here.
- Capture windows: 57–70 opened in about two minutes per run, 55–68 of them
  closing another; opening took p50 90–103 ms, at most 396 ms.
