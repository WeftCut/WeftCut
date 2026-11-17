---
status: accepted
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
- **A modified range qualifies its sync.** Where the layers playing in it
  moved by different amounts, it states the largest spread, the sound's lag
  against the picture when all sound moved as one and all picture as one, and
  that sound's role; when what plays apart is all picture or all sound, it
  says which, so it never speaks of sound where none is. Bound sync is broken (`sync_bound`) when members of one
  link, or dialogue and picture, play apart. It is *out of sync* only
  (`only: 'sync'`) when every layer playing on either side is the same layer
  playing the same content with the same values elsewhere on the other side,
  and so is every transition, save baseline content gone at the range's onset
  within the offset: the hole the rest closed up over. Adjacent pieces join
  only when they state the same sync. This qualifies a range the alignment
  already found; it changes neither the alignment nor the classes.
- **Attribution is borrowed, never computed.** A range lists the entity
  changes that play in it (layers, transitions, role gains, a composition's
  track order, and what a Group shows there); it is to review when any is
  unreviewed, the user's own when all are (ADR 0115). A reader of the
  unreviewed list alone gets ranges naming unreviewed changes only, so a user
  edit elsewhere is nothing new to it. A range with no entity change is a bug
  in one of the two comparisons and is logged, never skipped.
- **The range diff replaces the entity band** on the mini timeline and is drawn
  on the editor's ruler: a range is a stretch of the film's clock, and the
  Review lane stays the agent's tacks. A loose desync (out of sync only, no
  bound sync broken) is drawn as one fact: a dashed foot only, the ruler's
  body left to its ticks, with a light wash under the pointer or the focus;
  every desync marks its onset with a tick, and with ⇄ where the
  ruler has room. The mini timeline's band is too thin to say more and draws
  every modified range alike. A press there still scrubs; the hover names the range.
- **A range is reviewed as a whole.** A double press on the ruler, or a press
  on the mini timeline's band, focuses the range itself, not one of its
  changes; after every recompute it is found again by the changes of its own
  it shares (its layers and transitions, never a composition's track order or
  a role's gain, which every range they play in lists; most shared, then
  nearest span) and goes when none is left. It is the film's, not a row's: it
  stays while the bands of the timeline on screen paint it, whichever tab the
  panel shows, and goes with another timeline. The panel heads
  its framed rows with one flat bar: play, the range's line, which of the
  timeline's ranges it is between the way to its neighbours, close. A press on
  a framed row points at that change with the range kept as context; Esc
  steps back, then lets go. Alt+↑/↓ walk the ranges of the timeline on
  screen without wrapping, and unlike a focus they seek: the playhead parks on
  the range's start, a cut point on the cut. A walk names where it landed (or
  that none is left that way) in the status line and leaves the panel as it
  is. Shift+Space plays the focused
  range, else the one under or after the playhead, from 1 s before it to
  0.5 s after (a cut point 2 s either side); the transport pauses there, any
  play, pause, seek or scrub drops that stop, and in and out points are left
  alone.
- Clip marks, the change list and the entity stat stay with the entity diff:
  every change keeps its mark, its row and its class. A mark and a row are as
  loud as the ranges that list the change: a solid edge where a changed range
  does, a faint hairline where none does (displaced only, or a change with no
  playback effect: "plays the same") or only a loose sync range lists a
  modified change ("out of sync only"): the clip itself plays what it did, and
  the ruler already marks the relation. Weight is read from `change_ids`,
  never from time overlap, and never hides, reorders or counts a change. The
  stat gains how many ranges of the film there are to review and how long
  they run: the root's, which already hold what each Group shows. Removed clips keep a track ghost only where
  their track is empty now. A selected activity's ranges are found between its
  own snapshots and placed where that content plays now.
- Not on MCP yet.

## Consequences

- A ripple across every track reads as one cut point; desync reads as one
  modified range over the whole stretch it affects, stating the offset. A
  music bed that starts before a rippled hole stays put by ripple's rule, so
  the tail after the cut reads "Out of sync · Music 2.0 s later than
  picture", drawn quietly unless the bed is linked to the picture or is
  dialogue. A razor split inside a desynced stretch makes a new layer, so that
  stretch is not out of sync only, though its offset is still stated.
- After a clean ripple the clips that slid keep a faint edge that says they
  play the same, not the solid edge of a clip that changed; Revert all still
  moves them.
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
unchanged); a strip in the Review lane (a second meaning in the tacks' row, and it took
the chips' room); a fourth "desync" class (out of sync only is a qualifier on `modified`,
defined only once the alignment has fixed both sides of a range, by following
each layer's identity to where the other side plays its content; the two
sides alone do not give it); a range focus that points at its first change
(a range of five changes named one); aligning each track on its own (hides a picture
rippled without its sound).
