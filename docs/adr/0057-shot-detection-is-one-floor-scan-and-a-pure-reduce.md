---
status: accepted
---

# Shot detection is one floor scan and a pure reduce

## Context

Shot detection runs ffmpeg's `scene` filter over a source and keeps every frame
whose change score exceeds a threshold. The threshold used to be baked into the
filter string (`select='gt(scene,{s})'`) AND folded into the report's cache key,
so each value of `sensitivity` was a fresh whole-source decode. That shape was
fine while the only caller was an agent that asked once at the default. It is
the wrong shape for a person: the whole point of a review surface is to move the
threshold and watch the boundaries follow, and a minutes-long decode per move
makes the control unusable.

Two measured facts made the alternative obvious.

**The decode costs the same at any threshold.** The `scene` filter runs during
the decode either way; the value only decides how many metadata lines come out.
Tightening the threshold upward is therefore free — every candidate above a
higher line is already in the set a lower line produced — and only loosening it
below what was scanned costs a rescan.

**Per-shot stats are what tie the cost back to the threshold.** Brightness,
motion and sharpness are sampled by spawning ffmpeg three times per detected
shot. At a low threshold on motion-heavy footage that multiplies the scan cost
by the candidate count, and the candidate count is exactly what the threshold
decides. Measured on handheld 1080p30 footage at the 320 px stat width, a
threshold of 0.05 admits about 1.4 candidates per second (mostly motion noise),
0.2 roughly a quarter of those, and 0.4 about the real cuts; a static screen
recording never exceeds 0.009. A stats pass at 0.05 would run hundreds of
extractions per minute of footage.

Two more facts about the ground kept the change small. `build_shots` (candidates
plus a minimum spacing → shot spans) and `clip_report` (a source report narrowed
to a window) were already pure functions in the Rust `jobs::shot` module; a
re-derivation needed a napi exit, not an algorithm. And the two writers of shot
cuts — the agent's `auto_split_by_shot` and the clip menu's "Mark shot cuts" —
each called the detector and then mapped, frame-snapped and deduplicated the
result on their own, so "markers land where splits land" rested on two call
sites happening to agree.

## Decision

1. **One deliberately low scan per source, `FLOOR_SENSITIVITY = 0.05`, timing
   only.** `floor_opts()` names it: stats and event flags OFF, minimum shot
   length fixed. It is cached per source (the VSHOT sidecar), so a second call on
   the same source skips ffmpeg. Every threshold at or above the floor is
   reachable from this one report without I/O; nothing below it is ever offered,
   because nothing below it was emitted.

2. **`reduce` is a pure Rust function and the only re-derivation.** It filters
   the scanned candidates by `score > sensitivity` (strict, matching ffmpeg's
   `gt`), feeds the survivors to the existing `build_shots` at the asked-for
   spacing, and narrows to a window. It is exposed as `Backend::reduce_shot_report`
   and never re-implemented in TypeScript: a second copy of the score filter and
   the spacing merge would be a twin of the invariant the Rust unit tests already
   pin, free to drift.

3. **Stats carry over only onto an identical span.** A reduced shot inherits
   brightness, motion, sharpness and flags only when the scanned report measured
   that exact `(t_start, t_end)`; a merged or truncated span is a different shot,
   and its numbers are absent, never a neighbour's. Because the floor scan is
   timing-only, that means the review surface shows stats as absent until a
   stats pass over the reduced spans exists. Absent renders as absent, never as
   zero.

4. **One canonical cut list, one snapping site.** `shotCutList` in
   `main/state/hybrids.ts` is the sole producer of a cut list — either the
   detector's at given or default parameters, or an explicit list a person
   reviewed — and `cutsToTimeline` is the only place a source boundary is mapped
   to the timeline, snapped to the composition's frame grid and deduplicated.
   `auto_split_by_shot`, `drop_shot_markers` and the renderer's `apply_shot_cuts`
   all funnel through it, so a split and a mark of the same request land on
   identical frames by construction rather than by convention.

5. **An explicit list is validated whole or refused whole.** Finite numbers,
   strictly ascending, each strictly inside the layer's source window; the first
   offender is named by index in a structured `InvalidArgument`, and nothing is
   dispatched. An empty list, or a detector that finds no interior boundary, is
   an idempotent no-op that writes no history entry.

6. **The detection defaults live in Rust only.** `DEFAULT_SENSITIVITY` and
   `DEFAULT_MIN_SHOT_US` back `parse_shot_opts`, `floor_opts` and a
   `Backend::shot_default_opts()` getter that TypeScript reads at runtime. No TS
   literal states them, so a default-parameter apply cannot drift from where
   `analyze_clip` says the cuts are.

7. **`sensitivity` survives as a wire and persistence field only.** The name
   reads backwards — a higher value yields fewer cuts — and no control is
   labelled with it. The human control is a line over the candidate scores; its
   meaning is its position, and the axis is labelled by what it measures.

## Considered options

**Keep rescanning per threshold.** Rejected. Every move of a threshold control
would be a whole-source decode; the review surface would be a slider that takes
minutes to answer.

**Reduce in TypeScript, keeping Rust untouched.** Rejected. The score filter and
the minimum-spacing merge are the invariant `build_shots` owns and its tests
pin; a TS copy is the fifth Rust/TS twin this codebase has been removing one by
one, and the two would disagree on exactly the frames that matter — the ones
within a frame of a boundary.

**A floor scan with stats on.** Rejected. It re-couples scan cost to the
threshold through the candidate count, which is the property the split exists
to remove. Stats over the spans a person actually keeps are a separate, cheaper
pass and belong to a follow-up.

**A floor of zero.** Rejected. At zero every frame with any change is a
candidate — on a smooth synthetic source that is every frame — so the report
grows without bound and the score strip becomes noise. 0.05 sits at the measured
edge of the motion-noise band on real footage while still admitting far more
than any usable threshold keeps.

**Letting each writer keep its own detector call.** Rejected. The Panel needs to
apply a list the user filtered, so the list has to become an argument; once it
is one, two producers of it is one too many.

## Consequences

- **Any threshold at or above the floor is free**; loosening below it would need
  a fresh scan, and the UI does not offer it.
- **The review surface's stats are absent in this version.** The floor scan is
  timing-only by design, so brightness, motion, sharpness and flags appear only
  once an on-demand stats pass over reduced spans exists.
- **`analyze_clip` keeps its own scan.** The agent tool defaults to stats and
  events on, which the floor report cannot serve, so a source analyzed by the
  agent and reviewed by a person holds two cache entries until that stats pass
  lands. Their BOUNDARIES agree: `auto_split_by_shot` and the pool's "Analyze
  shots" count reduce the floor report at the same defaults `analyze_clip` uses.
- **The pool's "Analyze shots" is a cache warmer.** It warms the floor report
  the review surface reads and reports a count from a reduce at the defaults;
  the Panel is the authoritative display.
- **`min_shot_us` merging happens relative to the layer's window.** `reduce`
  is asked for `[src_in_us, src_out_us]`, so a candidate within the minimum
  spacing of a clip edge merges into that edge rather than surviving as a shot
  that the interior filter then discards.
- **The source-to-timeline mapping is still speed=1**, one addition. When
  variable speed lands, `cutsToTimeline` is the one site to teach a remap —
  which is the point of having one.
