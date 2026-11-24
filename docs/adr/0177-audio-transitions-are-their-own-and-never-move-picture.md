---
status: accepted
---

# Audio transitions are their own records, read links only at edit time, and never move picture

Date: 2026-11-23

## Context

A transition is visual only (ADR 0035). Overlap placement (ADR 0048) moves the
incoming layer's link siblings with it, so a linked A/V pair leaves its two
Audio layers overlapping too, both at full gain: two 1 s-overlapped tones each
measured 99–100 % of their solo level, in preview and in an AAC export
(issue #141). The mix is doing what the model says; nothing in the model says
the sound should cross.

A link propagates edits and renders nothing (ADR 0052). Having the mixer ask a
visual transition for its linked audio would make links render, would need a
meaning for an audio Wipe or Slide, and would leave unlinked audio with no way
to crossfade.

## Decision

- **An audio transition is a `Transition` between two Audio layers on one
  track.** Kind `Crossfade` only; Wipe, Slide and a visual/audio pair are
  refused. Its duration equals the overlap, a whole number of frames since
  audio edges sit on the frame grid (ADR 0038), and spans at least one frame,
  like a visual one. It authorizes that overlap the way a visual transition
  authorizes its own, and the one per-transition predicate (validate and
  reconcile) gains these rules per class.
- **The curve is equal-power.** With `p` the same linear progress a visual
  transition uses, the outgoing layer is multiplied by `cos(πp/2)` and the
  incoming by `sin(πp/2)`, on top of gain, fades and role gain. It lives in the
  shared eval leaf beside `fade_multiplier`, behind a golden fixture, so the
  preview graph, the export mixer and retimed stems read the same values. No
  curve field yet.
- **Links are read at edit time, never at render time.** Adding a visual
  transition also adds an audio transition, in the same commit, when each
  participant has an audio partner (resolved as pause detection resolves it:
  the linked Audio sharing the clip's media, else the link's only Audio) and
  the two partners abut at the cut on one track. The incoming partner then
  stays on its lane. Otherwise the partners bounce as today. `add_transition`
  takes `audio: 'linked' | 'none'`, default `'linked'`.
- **An audio transition never moves picture.** An audio-only add or update
  whose placement would move a visual layer is refused
  (`AudioTransitionMovesPicture`). Removing an audio transition moves the
  incoming layer back (ADR 0048) only when no visual layer moves with it;
  otherwise the borrowed tail is returned and the incoming audio moves to a
  free lane, its start unchanged.
- **Edits through a visual transition carry its audio partners.** A duration
  change or removal moves the audio transition's outgoing end by the same
  number of frames as the visual one's, and its incoming layer moves as a link
  sibling. A returned borrow gives back at most what the audio transition still
  borrows: after the audio was shortened on its own, the rest would cut sound
  before the audio cut. A deliberate tail trim (negative `extended_us`) moves
  both cuts by the same frames. Its duration is then re-derived from the landed overlap, or it is
  removed in the same commit when no overlap is left. Any other edit that
  breaks an audio overlap drops it through reconcile, as for visual.

## Consequences

- No pairing field: which audio transition belongs to which visual one is
  derived from links when an edit needs it, so relinking cannot leave a stale
  pair.
- A linked pair shares its edges, so an audio partner's duration equals its
  visual transition's exactly, at every rate.
- Equal-power keeps uncorrelated material level. A clip crossfaded into a
  continuation of the same recording rises about 3 dB at the midpoint; the
  master limiter catches overs. A second curve waits for its own issue.
- Older builds refuse an audio transition in validation, so the schema version
  bumps (identity migration) and they refuse the file by version instead.
- Audio transitions need their own chip on the audio lane.

Rejected: a visual transition crossfading its linked audio at render time
(links would render); a pairing field on `Transition` (a second relationship
beside the link, stale after relinking); linear fades written onto the audio
layers at add time (not equal-power, indistinguishable from the user's own
fades on removal); audio transitions across tracks (the overlap invariant and
the chip are per track).
