---
status: accepted
---

# The composition rate locks once content exists, audio authors on the 48 kHz sample lattice, and NDF timecode is made honest rather than joined by drop-frame

Date: 2026-07-25

## Context

- Changing `fps` under existing layers re-snapped every edge, keyframe, marker
  and duration by up to half a new frame, could collapse short layers, and was
  reachable through an ordinary MCP settings patch.
- The mixer already renders audio on 48 kHz sample frames, but audio edges and
  automation were snapped to the video frame grid: the stored value was not the
  rendered one, and raising fps changed audio placement precision. An FCP-style
  1/80-frame subframe does not fix this: at 30000/1001 a subframe is 20.02
  samples, so it re-creates a second grid rounded again at render.
- Drop-frame timecode relabels microseconds that are already correct; its only
  consumers are interchange formats (EDL/AAF/OTIO/FCPXML) WeftCut does not
  write.

## Decision

- **Rate lock.** `set_composition { fps }` is refused with
  `FpsLockedByContent { current, requested, layer_count, locked_by }` once a
  layer exists in the live timeline or any history snapshot/checkpoint (an
  unrecorded rate change reaches every snapshot, so undo would otherwise return
  old-grid layers). Markers, a pinned duration and unplaced media do not lock.
  The preset list is complete (23.976/24/25/29.97/30/50/59.94/60) with no custom
  rate. Rate conversion, if ever wanted, is duplicate-and-convert.
- **Audio on samples.** Audio layer edges and audio automation are canonical on
  `round(i × 1e6 / 48000)` — the mixer's own lattice, so zero rounding at
  render. `composition.sample_rate` is only the export target and is not locked.
  `gridForLayerKind` is the single choice, used by the commit validator, every
  mutation snap (including group fan-out) and load repair. A kind-blind snap in
  fan-out or `repairGrid` silently destroys A/V slips, so tests carry negative
  controls.
- **Sync offset is derived**, `audio.t_start − video.t_start`, measured in
  sample indices (at 29.97/59.94 a fresh pair already differs by ~10 µs of grid
  residue). Nudges step by index, never by adding µs (spacing alternates
  20/21 µs).
- **No drop-frame.** NDF timecode only; starting timecode is zero. Where a
  duration is shown at a fractional rate, the wall-clock figure is shown beside
  it.

## Consequences

- Older projects open with a ≤ half-sample (~10 µs) audio repair, reported, as
  ADR 0037's repair-on-load requires.
- Sample precision is not reachable by dragging (one sample is 0.042 px at the
  2000 px/s zoom ceiling); it comes from nudge commands and numeric entry.
- `composition.duration_us` stays a frame count, rounded up over a sub-frame
  audio tail.
- `OffGridLayerBoundary` carries `grid: "frame" | "sample"`.
- No schema change: no DF flag, no timecode offset, no stored sync offset.
