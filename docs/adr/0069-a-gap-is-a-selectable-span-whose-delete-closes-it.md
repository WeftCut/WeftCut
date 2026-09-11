---
status: accepted
---

# A gap is a selectable span, and deleting it closes it

The empty space on a track between two clips is a **gap**: a thing the user
can click, see highlighted, and delete. Deleting a gap does not lift anything
— there is nothing to lift — it **closes** the gap: every layer of the
composition that starts at or after the gap's end moves left by its length, on
every track, through the ripple's own planner and under the ripple's own
refusals. Bare `Delete`, `Shift+Delete` and the gap's context-menu row are one
edit. A gap has no id; it is named by its lane and its span, and it stops being
selected the moment the span stops being exactly that gap.

## Context

ADR 0062 made ripple delete an explicit command over a *selection of layers*,
and listed gap selection among the things deliberately not built. That left one
routine edit with no gesture: a hole already in the cut — left by a plain
`Delete`, by an overlap placement, by a drag — could only be closed by selecting
the clip after it and dragging it back by eye, or by deleting and re-adding a
neighbour. Premiere, Resolve and FCP all let the editor click the empty space
and press `Delete`, and in all three the bare key closes the gap; that is the
default gesture, not an option.

Two facts of the existing design decide the shape. The ripple planner
(`renderer/ripple/plan.ts`) already separates *finding* the holes a deletion
vacates from *closing* them — steps 4 to 10 read only a list of spans — so a
gap needs no new arithmetic, only a way in. And the renderer's selection is a
discriminated union with one live branch, so a new kind of selectable thing is
a new branch, and every dispatch that reads the union grows one `case`.

## Decision

- **What a gap is.** The free span on one track between two layer boundaries:
  its right edge exactly where a layer starts, its left exactly where one ends
  or at composition time 0. Read class-agnostically off every layer on the lane
  — a combined A/V row with a picture running over an empty audio half is not
  blank, and the ripple's per-class hole rule does not apply here. The space
  after a track's last layer is not a gap: it has no right edge to close up to.
  One pure module states this (`renderer/ripple/gap.ts`), and the click, the
  selection store and the planner all read it — a second definition anywhere
  would let the highlight show one span and the edit close another.
- **Selecting.** A plain click on lane background that resolves to a gap
  selects it; any other background click clears, as before. No modifier: this
  is the reference apps' default gesture. The highlight is the selected-clip
  outline drawn over the span, on the lane's full height. A locked lane's blank
  space clears rather than selecting — its gap could never close, since the
  clip at its right edge would have to move — for the reason the marquee skips
  locked lanes: never build a selection that arms an edit the actor always
  refuses. Selecting a gap drops the keyframe selection, as a clip sweep does,
  so the Delete that follows reaches the gap.
- **The selection kind.** `{ kind: "gap"; trackId; s; e }` joins the union.
  Because a gap has no id, it is *retained* by re-derivation: on every project
  summary the store asks whether `[s, e)` is still exactly a gap on that lane,
  and clears it otherwise. A clip moved into the span, an edge moved, the lane
  gone, or the gap itself just closed all end the selection.
- **Deleting closes.** `Delete`, `Backspace`, their `Shift` chords and the gap
  menu's *Ripple delete* row all run one handler: the gap is sent to the actor
  as `ripple_delete_gap { track, s, e }`. The planner's gap entry validates the
  span against the actor's own state and then runs the deletion's closing with
  the gap as the one hole and nothing doomed. Keyframes keep their precedence
  over the key, as they have over the clip delete.
- **Both edges travel, never a time inside the gap.** The actor closes exactly
  what the renderer highlighted. A span that is no longer a gap when it arrives
  — the mirror can lag the actor by a round trip — is refused as
  `GapNotFound { track, s, e }` rather than re-measured to whatever is free
  there now. The refusal is curated for the status bar and greys the row with
  the same sentence, like the ripple's four.
- **Refusals are the ripple's.** A layer on another lane starting inside the
  gap (`RippleInsideHole`), a landing on a layer that is not moving
  (`RippleCollision`), a link with a member reaching across the gap and another
  downstream (`RippleLinkStraddles`), a locked layer or lane that would have to
  move (`RippleLockedLayer` / `TrackLocked`). The remedy for a layer inside the
  gap differs from the deletion's — a gap has no set to add it to — so the
  agent-facing sentence says to remove that layer first. Predicted before the
  key through the one eligibility predicate, which now takes the whole
  `Selection` rather than the layer set.
- **Surface.** The lane click; the gap's right-click menu with exactly one row;
  the Edit menu, palette and Quick Actions *Ripple delete* entries, which gate
  and label through the shared predicate unchanged; the history row *Closed
  gap*; for agents `ripple_delete_gap { track_id, start_us, end_us }`.

## Considered options

- **Keep bare `Delete` as the lift and require `Shift+Delete` over a gap.**
  Rejected: a gap cannot be lifted, so the bare key would do nothing, and
  Premiere and Resolve both close on the bare key. ADR 0062's rule that bare
  `Delete` never ripples was about clips; it does not extend to a selection
  that has nothing to lift.
- **Address the gap by a time inside it (`track, at_us`).** Rejected: under a
  lagging mirror the actor would close a different span from the one the user
  saw highlighted. Sending both edges makes the mismatch a refusal.
- **Define a gap per overlap class, like the ripple's hole.** Rejected: the
  user clicks what looks blank on the row, and a picture running over an empty
  audio half does not look blank. The hole rule exists so a transition
  participant can be rippled; no such case arises for a click.
- **Make trailing space and empty lanes selectable.** Rejected: there is no
  right edge to close up to, and neither reference app selects them.
- **Give the gap an inspector card, or a "close gap" button.** Rejected:
  Premiere's and Resolve's inspectors show nothing for a gap, and the only
  action is the key.
- **Same-track closing (shift only the gap's own lane).** Rejected for the
  reason ADR 0062 rejected the same-track ripple: picture and sound are two
  layers on two tracks, and the first use desyncs them.
- **Silently re-measure a stale gap on the actor.** Rejected: the actor is the
  authority, but an edit the user did not see is not an edit they asked for.

## Consequences

- ADR 0062's "gap selection remains unbuilt" is discharged; ripple trim,
  insert edits and Sync Lock still stand unbuilt.
- The `Selection` union has a branch with no id, and one `retain*` pass that
  re-derives instead of looking up. Anything that switches on the union must
  now decide what a gap means for it; the inspector and the gizmo treat it as
  nothing selected.
- The refusal vocabulary grows by `GapNotFound`; the planner grows a second
  entry point over the same closing; the MCP catalogue grows one tool.
- The eligibility predicate's inputs are the selection, the composition and
  the keyframe flag — not the layer set — so a future selection kind with a
  ripple meaning has a place to land.
