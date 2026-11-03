---
status: accepted
---

# Shot detection is one floor scan and a pure reduce

Date: 2026-09-02

## Context

Shot detection runs ffmpeg's `scene` filter over a whole source. With the
threshold in the filter string and the cache key, every threshold was a fresh
whole-source decode (minutes), which makes a review surface where a person
drags the threshold unusable.

- The decode costs the same at any threshold: the filter runs during decode
  either way; the value only decides how many candidates are emitted. Every
  candidate above a higher line is already in a lower line's set.
- Per-shot stats (brightness, motion, sharpness) cost three ffmpeg extracts
  per shot, so stats tie scan cost back to the candidate count. On handheld
  1080p30 at the 320 px stat width, 0.05 admits ~1.4 candidates/s (mostly
  motion noise), 0.2 a quarter of that, 0.4 about the real cuts; a static
  screen recording never exceeds 0.009.
- Splits and markers each mapped and snapped detector output on their own, so
  "markers land where splits land" held only by convention.

## Decision

1. One scan per source at `FLOOR_SENSITIVITY = 0.05`, timing only
   (`floor_opts()`: stats and events off), cached in the VSHOT sidecar keyed by
   content hash, tier and options. Nothing below the floor is offered.
2. `jobs::shot::reduce` (Rust, pure) is the only re-derivation: candidates with
   `score > sensitivity` (strict, as ffmpeg's `gt`), then `build_shots` at the
   asked spacing, narrowed to `[src_in_us, src_out_us]`. Exposed as
   `Backend::reduce_shot_report`; never re-implemented in TypeScript.
3. A reduced shot inherits stats only when the scan measured that exact span.
   Review-surface stats come from an on-demand per-span measurement with its
   own sidecar keyed by (content hash, tier) and addressed by span, so a
   boundary that survives a threshold move keeps its numbers. Absent is never
   zero.
4. `shotCutList` (`main/state/hybrids.ts`) is the sole producer of a cut list
   (detector at given/default parameters, or an explicit reviewed list), and
   `cutsToTimeline` the only site mapping source cuts to the timeline, snapping
   to the composition frame grid and deduplicating. `auto_split_by_shot`,
   `drop_shot_markers` and `apply_shot_cuts` all go through it.
5. An explicit list is validated whole (finite, strictly ascending, strictly
   inside the source window) or refused with the first offender's index. No
   interior boundary is an idempotent no-op with no history entry.
6. Detection defaults (`DEFAULT_SENSITIVITY` 0.4, `DEFAULT_MIN_SHOT_US`
   500 000) live in Rust only; TS reads `Backend::shot_default_opts()`.
7. `sensitivity` is a wire/persistence name only (higher = fewer cuts); no UI
   control carries it.

## Consequences

- Any threshold at or above the floor is free; below it would need a rescan.
- `pick_source` picks the tier (quick proxy, full proxy, original) of a new
  scan; lookup checks every tier, so a report scanned on the original survives
  a proxy landing. Measurements follow the report's tier.
- `analyze_clip` keeps its own stats-on scan and cache entry. Its boundaries
  agree with the floor reduce at the same defaults, and one measurement
  function serves both, so their numbers agree too.
- `reduce` is asked for the layer's source window, so a candidate within
  `min_shot_us` of a clip edge merges into the edge.
- `cutsToTimeline` maps through the layer's timing (`localAtContent`), so
  retimed clips go through the same single site.

Rejected: rescanning per threshold (minutes per move); reducing in TS (a second
copy of the invariant `build_shots` tests pin, disagreeing at boundary
frames); floor scan with stats (re-couples cost to threshold); floor 0 (every
changed frame is a candidate; unbounded report); one detector call per writer
(the Panel must pass a reviewed list, so one producer).
