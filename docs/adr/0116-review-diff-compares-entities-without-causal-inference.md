---
status: accepted
---

# Review diff compares entities without causal inference

Date: 2026-10-17

## Context

The first review diff inferred which edit moved surrounding content: equal
translations became shift groups, carried entities disappeared under a
carrier, approving one row accepted others, and removed footprints and old
positions were reconstructed from neighbouring material. None of that is a
fact available from two snapshots, and the explanations changed with
unrelated edits.

## Decision

- Review compares baseline and current values **by entity identity**. Each
  entity is its own change: added, removed or modified. Equal displacements,
  linked clips and tracks created with a composition stay separate. A change's
  `keys` is a single-element tuple, so grouped changes are not representable.
- No editing intent, ripple cause, carrier, residual motion or operation
  sequence is inferred. Details are computed from the entity's own values:
  timing before/after (start, end, source start/end), rates, param keys,
  effects, flags. A trim is the layer's own window-edge difference at an
  unchanged rate. Timeline times compare only within one composition.
- A marker tied to the same clip on both sides compares its anchor (source
  instant, region length), not its cached `t_us`: riding with its clip is not
  a change.
- Recorded edits outside `compositions` are entities too: `AudioRole` compares
  `gain_db` only (absent = 0 dB), `Media` compares pool membership. Import,
  relink and derivative updates patch every snapshot and the baseline, so they
  are never changes. Role mute/solo, project settings and composition setup are
  preferences; ids, timestamps and counters are bookkeeping.
- Current footprints and baseline footprints are separate fields. A removed
  entity has no current footprint and carries its `before_name`; its ghost is
  drawn in baseline coordinates, labelled as such, apart from current ranges.
  No neighbour mapping or inferred ripple seam is drawn. Activity diffs keep
  their historical facts; later edits never rewrite them.

## Consequences

- A ripple can produce many rows; each is visible and independent.
- A historical ghost can overlap current content; its label states its
  coordinate system rather than claiming material was removed there today.
- "Why did this move" is not this diff's question; anything answering it
  must be a separate module, keeping the diff pure.
- `reviewEntities` owns indexes, equality and touched keys; `reviewDiff` owns
  diff, identity-based location and Group decoration; wire types are in
  `shared/review.ts`; the renderer only formats facts and paints declared
  footprints.
