---
status: accepted
---

# A link propagates, a Group composes

Date: 2026-10-04

## Context

"These travel together" (an A/V pair, a B-roll shot with its voice-over) and
"this is one thing" (a lower-third build, a reusable title, a scene animated as
a unit) are different requests. Every NLE users come from keeps them as two
features — Link and Nest (Premiere), Link and Compound (Resolve), Precomp
(After Effects). The editor had one mechanism, a flat propagating member set,
and called it a Group, so the second intent had no home and the word users
reach for was spent on the first.

## Decision

1. **Link** is the propagation relationship: `{ id, label?, members }` in
   `Composition.links`; move/trim/split fan out, nothing renders.
2. **Group** is a composition placed as one layer (After Effects' precomp,
   Premiere's nest).
3. **Root and Groups share one `Composition` shape**, addressed through
   `Project.compositions: Record<Uuid, Composition>` and `Project.root_id`. A
   special root plus `sub_compositions` would give every walk, mutation and
   validator a twin path, and twin paths drift.
4. **A Group layer is media-bearing.** Its params are
   `CompositionRefParams { composition, src_in_us, src_out_us, … }`, the source
   duration being the referenced composition's `duration_us`, so trim clamping,
   split's source distribution and keyframe re-basing apply as they do for
   `VideoClip` and `Audio`.
5. **Single lattice.** Every composition's `fps`, `sample_rate` and `channels`
   equal the root's (`CompositionLatticeMismatch`); width and height may differ.
   A Group on another rate would put its `src_*` window on a different grid from
   the parent's `t_*`. Rate change is a property of the Group *layer*
   (`time_map`, ADR 0092), not of the composition.
6. **Overhang is tolerated in state, clamped at the gesture.** Validation never
   rejects `src_out_us > duration_us`; a trim drag clamps to the duration and
   past the end the Group renders nothing. Otherwise a delete inside a Group,
   which autofit-shrinks it, would be refused because a parent's window
   overhangs.

## Consequences

- Every per-composition walk (export decode set, motif pre-bake, fonts, audio,
  snapping, the Rust mixer) recurses through `CompositionRef` with a composed
  time mapping; a flat `tracks[].layers[]` walk is never the whole project.
- No Group layer is retrimmed when its composition grows or shrinks; widening
  a window is the user's act.
- `Project` round-trips through serde to Rust, so shape changes land in both
  languages at once.

Rejected: keeping "Group" for propagation (costs the vocabulary the feature is
for); per-Group fps (time remapping under another name); rejecting overhang in
the validator (turns a delete inside a Group into a refusal about its parent).
