---
status: accepted
---

# The composition rate locks once content exists, every layer edge sits on frames with audio slipped in its source, and NDF timecode is made honest rather than joined by drop-frame

Date: 2026-07-25

## Context

- Changing `fps` under existing layers re-snapped every edge, keyframe, marker
  and duration by up to half a new frame, could collapse short layers, and was
  reachable through an ordinary MCP settings patch.
- Audio needs finer placement than a frame: a sync fix or a transient lands
  between frames (one frame at 29.97 is 1601.6 samples). Putting audio EDGES on
  the 48 kHz lattice gave that, but at 29.97/59.94 a frame time is not a sample
  time, so every linked picture/sound pair carried edges up to ~10 µs apart. Any
  edit that read one span or one delta across both members then misjudged the
  other: a ripple delete of the piece before a cut was refused on about four
  cuts in five, and a linked trim never fanned out.
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
- **Every edge on frames.** Every layer's edges, Audio's included, are points of
  the composition frame grid, so a linked pair shares its edges exactly and an
  edit reads one lattice. A move carries every edge by the same whole frames,
  computed once for the mutation and for the timeline's preview of it.
- **Audio precision is a source slip.** A sample nudge moves an audio layer's
  source window by whole 48 kHz samples under fixed edges; the mixer rounds the
  frame edge to its sample at render. The sync offset is derived, never stored:
  the difference between where each same-media member's source time 0 lands.
  Audio automation keys stay on the 48 kHz lattice; they are layer-local and
  never meet an edge.
- **No drop-frame.** NDF timecode only; starting timecode is zero. Where a
  duration is shown at a fractional rate, the wall-clock figure is shown beside
  it.

## Consequences

- An audio cut point is a frame; sound can start or end within a frame only
  through its source slip. A sample-exact butt edit between two audio clips is
  not expressible.
- A slip is refused when it would read source outside the media; silence past
  the media's ends is not represented.
- Projects with audio edges on the sample lattice open with a reported repair:
  edges go to the nearest frame and the source window moves by the samples the
  start moved, so every sample plays where it did. A slipped layer's automation
  keys shift against the sound by under half a frame.
- `composition.duration_us` stays a frame count. `OffGridLayerBoundary` keeps
  its `grid` field for MCP clients; it is always `frame`.
- No schema change: no DF flag, no timecode offset, no stored sync offset.
