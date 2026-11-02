---
status: accepted
---

# Constant time remapping preserves content windows

Date: 2026-10-04

## Context

Video, Audio, animated images, Motifs and Group instances need a constant
playback rate. Timeline times are integer µs on per-kind grids (ADR 0037), but
a rational rate applied to them produces non-integer source and keyframe times,
and rounding at every step would drift keys and windows across repeated edits.
Group clocks were offset-only (ADR 0052), so nested rates had nowhere to
compose. The existing `VideoClip.speed` field was stored but never affected
playback.

## Decision

- **A positive constant rational rate per clip**, persisted (schema 3) as
  `time_map: { kind: "Affine", rate: { num, den } }`, with fractional
  remainders stored beside the integral coordinates: `source_phase` on the
  source window, `time_fraction` on keyframes, `fade_phase` on fades. Images
  and Motifs carry an unwrapped `content_window`; image looping happens only
  at frame sampling.
- **A retime keeps the start and the selected content.** It snaps the new end
  to the clip's own grid, derives the actual rate from the snapped duration,
  and scales the clip's own keys and fades by that ratio (ids, curves and
  remainders kept, out-of-span keys included). Child compositions are
  untouched; neighbours do not move; transitions keep duration and provenance.
  Trim keeps the rate; split keeps the mapping and re-bases the right side.
- **Exact arithmetic in one place**: rational i128 in the Rust eval leaf,
  shared with TypeScript through wasm. Nested composition clocks compose
  rational maps and quantize only at the final decoder/frame/sample boundary.
- **One planner** (`renderer/retimePlan.ts`) serves the inspector preview and
  the actor (`retime_layers`); the commit recomputes from live state and
  refuses the whole batch on collisions, locks, illegal transitions, nested
  selected targets or unrepresentable arithmetic. Explicit ids are the whole
  batch; links never expand it.
- **Audio** retimes into immutable 48 kHz per-role PCM stems shared by preview
  and export; pitch is preserved by default; a failed preparation holds
  playback/export instead of substituting raw audio.
- **Only `FrameSampling` is implemented**; `FrameBlending` and `OpticalFlow`
  exist in the type and are refused as unavailable.
- **The schema 2→3 migration drops `VideoClip.speed` and installs rate 1.**
  Promoting the inert field to a live rate would change how old projects play.

## Consequences

- Ungrouping a retimed Group and adding members to one require rate 1.
- Every reader of source time goes through the composed map; a raw
  `t − t_start + src_in` is wrong for a retimed clip.
- Motif `props.speed` is unrelated application content and stays.
