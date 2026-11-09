# The elastic capture-host pool, measured

Scenario runs of 2026-11-10 against the 2026-11-10 baseline (origin/main
59407acc, `captureHosts` 2 and 4), three runs per configuration, medians. The
Windows bench (RTX 3050, memory target 11264 MiB) and an M1 8 GB (target
2816 MiB). Layouts: L1 52 lyric Motifs back to back; L2 video under 4–5
stacked Motifs; L4 8 Motifs entering within 2 s; L6 1 heavy WebGL and 3
light; L8a L2 with a side capture every 500 ms; L10 7 visible at once.

## Results with `captureHosts` 4 (before the cap rose)

- L2 rebuilt 563 (bench) / 414 (M1) windows a minute on 2 hosts, 21 / 36 now;
  cold playback 2.6 → 27 fps and 1.9 → 12 fps; `current` queued p95 384 → 19
  ms and 274 → 14 ms.
- L6 and L7 behave as with 4 fixed hosts (5 builds a minute, 28 fps); L7's
  edits rebuild 82 / 71 windows a minute against 530 / 415.
- L8a: side traffic no longer rebuilds what plays: 587 → 144 builds a
  minute, cold 2 → 27 fps on the bench.
- L1: every Motif's host was there at its first current frame (warm-hit 1.0
  against 0.73 / 0.45); click-seek first frame stays 235 / 287 ms p50: a seek
  to a Motif not shown recently still builds its window.
- L4 (8 visible on 4 hosts): 268 → 136 builds a minute with a 1 s residency;
  2 s cut builds to 100 but held the picture 2.2 s p95; 0.5 s raised the
  `current` queue. 1 s kept.

## Sizing

- `captureHosts` 8 on the bench: L10 109 → 4 builds a minute, 22 → 25 fps,
  `current` queue p95 22 → 0 ms; L4 136 → 66 builds, 6 → 14 fps; process
  tree 2.4–3.2 GB of 11 GB.
- On the M1 8 allowed hosts opened 7–8 at start, when the app took about
  1.0 GB; the app then grew to about 2.0 GB without its hosts and the tree
  sat at 2.9–3.1 GB, pressured 27–60% of the time, `current` frames
  serialized on the governor's floor (60–120 refusals a run, each retried)
  and no faster than with 4. Counting hosts at full size (`hostMemoryMib` or
  the median measured, whichever is more) did not stop it: the room is used
  by the app after the hosts open. `hostMemoryPercent` 25 caps the hosts'
  share of the target: about 4 hosts on the M1, the cap on the bench.
- Measured host working sets: bench p50 128, p90 193 MiB; M1 p50 104, p90
  186 MiB (lyric drafts are the large ones). `hostMemoryMib` stays 130.
- Warm lead measured (median build + first step): bench p50 129, p95 275,
  max 721 ms; M1 p50 265, p95 411, max 515 ms. `hostWarmLeadMs` 450 is only
  used before the first measurement; `presenceLookaheadMs` 2000 covers the
  worst lead.
- `hostAgingMs` 2000 against 5000 on L8a: 155 against 144 builds a minute,
  same fps; 5 s kept as the bound on side traffic's wait.
