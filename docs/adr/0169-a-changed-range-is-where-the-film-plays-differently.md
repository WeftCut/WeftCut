---
status: proposed
---

# A changed range is where the film plays differently

Date: 2026-11-16

## Context

The entity diff (ADR 0116) lists what an agent touched, and the mini timeline
painted each change's footprint as a band. That band answered "where should I
watch again" with entity data: a ripple painted every displaced clip as
modified, a removal had no current place and its baseline footprint overlapped
what slid in, and a picture track rippled without its music read as clips that
merely moved. Text diffs avoid the first problem by aligning lines, but a
timeline has parallel tracks whose relative time is content, so aligning one
track at a time would hide desync. Once composited, the film is
one-dimensional: what plays at each instant already holds every track's
relative timing.

## Decision

- **Review compares what plays, aligned as a sequence.** Each composition, on
  both sides, becomes slices over which the same layers and transitions play,
  split where a layer's playback can change (its ends, fades, keyframes, a
  Group's own slices). Two stretches play the same when the same kinds play on
  the same content time, in track order, with equal values where they affect
  playback — ADR 0117's comparison without entity identity, so a razor split or
  a copy of a clip plays the same. Equal stretches are matched in order on both
  sides; a tie between equal content prefers the same entity, then the least
  displacement. Times compare exactly in µs.
- **What stays unmatched between two matches is a changed range**, classified
  by its sides: `removed` where nothing plays now (a cut point when it has no
  width), `added` where nothing played, `added` or `removed` also where every
  entity change playing in it is of that class (a lift over a music bed), else
  `modified`. Silence lengthened or shortened is a `gap` range. Where nothing
  played, each stretch that plays now is its own addition. A cut point is the
  comparison's result — where baseline content stops matching — not a seam
  inferred from neighbours, which ADR 0116 still forbids in the entity diff.
- **Attribution is borrowed, never computed.** A range lists the entity
  changes that play in it (layers, transitions, role gains, a composition's
  track order, and what a Group shows there); it is to review when any is
  unreviewed, the user's own when all are (ADR 0115). A reader of the
  unreviewed list alone gets ranges naming unreviewed changes only, so a user
  edit elsewhere is nothing new to it. A range with no entity change is a bug
  in one of the two comparisons and is logged, never skipped.
- **The range diff replaces the entity band** on the mini timeline and is drawn
  along the Review lane's foot. Clip marks, the change list and the entity
  stat stay with the entity diff; the stat gains how many ranges there are to
  review and how long they run. Removed clips keep a track ghost only where
  their track is empty now. A selected activity's ranges are found between its
  own snapshots and placed where that content plays now.
- Not on MCP yet.

## Consequences

- A ripple across every track reads as one cut point; desync reads as one
  modified range over the whole stretch it affects, stating the offset. A
  music bed that starts before a rippled hole stays put by ripple's rule, so
  the tail after the cut reads as out of sync.
- A razor split, or reused material playing the same, is no range while the
  entity list still lists the new layer.
- Two diffs answer two questions and can disagree by design: a Group whose
  changed part is trimmed away has a "contains changes" badge and no range on
  the outer timeline.
- Cost grows with the slices of every composition, re-sliced only where a
  commit touched; a commit far from any edit matches each slice at the
  displacement of the one before it, without searching.

Rejected: per-entity "moved only" as a fourth stat or class (misses desync,
contradicts 0116's classes); a toggle between the entity band and range band
(one place, two meanings); entity-id signatures (a razor split reads as added);
a frame tolerance (hides sub-frame desync; uniform shifts are already
unchanged); a fourth "desync" state (needs a definition of "only desync" that
the two sides do not give); aligning each track on its own (hides a picture
rippled without its sound).
