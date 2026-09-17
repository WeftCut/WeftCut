---
status: accepted
---

# Ripple is an explicit command over placement, and it closes only what the deletion vacated

A ripple delete removes a set of layers and shifts everything after them
left, on every track of the composition they live in, by exactly the span
those layers vacated on their own tracks. It is a command the user or an
agent names — `Shift+Delete`, *Ripple delete*, `delete_layers { ripple: true }` — and
never a side effect of another edit. Bare `Delete` keeps lifting a layer and
leaving its span empty.

## Context

This timeline is free-placement: tracks are kind-agnostic, a layer sits
where it was put, and links are the mechanism for "these move together".
ADR 0048 states that a vacated span stays a gap and rejected closing the span
an overlap placement vacates because "an implicit multi-track ripple desyncs
against spanning layers and moves layers the user never touched".

That objection is to an *implicit* ripple. The primitive editors expect from
Premiere, FCP and Resolve is an explicit one, and moving layers the user did
not touch is its purpose: it is how a cut keeps the rest of the film in sync.
Without it, removing dead air is impossible — split → split → delete leaves a
hole exactly as long as the slice, audibly identical to doing nothing — and
the `/cut-pauses` recipe could only mark.

## Decision

- **Scope.** Every track of the current composition, hidden display-mode
  tracks included. Never another composition: inside a Group the Group's
  duration shrinks and every parent `CompositionRef` keeps its placement
  (the overhang ADR 0052 §6 tolerates); in a parent, a Group layer is a body
  and the ripple does not reach inside it.
- **The hole.** For each deleted layer, the span on its own track that its
  removal actually frees, clipped to the layer's own extent:
  `[max(start, prevSameClass.end), min(end, nextSameClass.start))`. Gaps that
  already existed beside it are not closed. This is what makes a transition
  participant rippleable (the overlap the transition authorized is not part
  of the hole) and what keeps the span an overlap add vacated a gap.
- **Multi-selection.** Remove the set, measure each hole against what
  remains, merge overlapping or touching holes across tracks, apply the
  total to every downstream layer in one snap. One commit, one undo.
- **Who moves.** A layer starting at or after a hole's end shifts by the
  summed length of the holes ahead of it; a layer starting before the hole
  stays, whether or not it spans the cut. Each mover lands on its own lattice
  (the link-move rule). Free markers, the playhead and the in/out range stay
  at their absolute times; anchored markers follow their layers through the
  existing reconcile. Keyframes are layer-relative and need nothing.
- **Transitions that travel.** A transition whose two participants both move
  keeps its frame count, but at a fractional rate the microsecond distance of
  a frame depends on where it sits, so the stored `duration_us` is re-derived
  from the landed overlap and the borrowed tail is re-measured as the same
  count of frames. A transition with one participant deleted is dropped by the
  commit's reconcile, as it is under a plain delete.
- **Refusals, all named, nothing silent.** A remaining layer that starts
  inside a hole (`RippleInsideHole`); a post-move overlap a transition does
  not authorize — a transition authorizes only when both participants moved
  by the same amount (`RippleCollision`); a link with a member reaching across
  a cut while another member would move (`RippleLinkStraddles`); a locked
  layer, or a locked track holding a layer, that would have to move
  (`RippleLockedLayer`, `TrackLocked`). A locked track with nothing
  downstream does not block. The system never makes room.
- **A link straddles only when a member reaches across the cut.** A split
  leaves every piece of a linked clip in one link, so deleting a middle piece
  always leaves link members before the hole and after it. That is the
  ripple's headline case, not a torn link: a member that ends at or before the
  cut is wholly upstream, and bringing the downstream pieces up to it is the
  point. The refusal fires for the member that starts before the cut and ends
  after it — the J-cut whose audio would drift off its picture.
- **Predicted, then enforced.** One pure planner produces the plan or the
  refusal; the mutation applies it, and the renderer runs the same function
  against its mirror so the row, the button and the menu item are greyed
  with the reason before the key is pressed. The refusal sentence the tooltip
  shows and the one the status bar shows after a real refusal are one curated
  line. The actor's validate and reconcile remain the last door.
- **Surface.** `Shift+Delete` / `Shift+Backspace`; the clip context menu, the
  Edit menu, the palette and the Quick Actions strip; with a keyframe or
  transition-chip selection the key degrades to the plain delete. For agents
  `delete_layers { layer_ids, ripple: true }` (the flag is the whole
  difference from the lift), a `ripple` flag on the internal multi-split, and
  `remove_pauses`, which the `/cut-pauses` prompt and
  the Pauses section's *Remove pauses* both call.

## Considered options

- **Bare `Delete` ripples (FCP).** Rejected: Premiere and Resolve keep the
  bare key as the lift, and a new feature does not repurpose a key every
  existing user presses.
- **Same-track ripple.** Rejected: picture and sound are two linked layers on
  two tracks; the first use desyncs them.
- **Per-track Sync Lock (Premiere).** Rejected for now: a feature of its own
  that users leave on, at which point it equals this rule.
- **Shift a layer that starts inside the hole (Premiere sync-lock
  behaviour).** Rejected: a B-roll cut for the deleted clip would slide onto
  the previous one. Refusing composes — add it to the selection and its hole
  merges.
- **Delete connected layers with the primary (FCP).** Rejected: the editor
  does not delete what the user did not select.
- **Hole = the layer's full span.** Rejected: a transition participant could
  never be rippled without colliding with its partner.
- **Hole = the whole free span between neighbours.** Rejected: closes gaps
  the user left on purpose, including the one an overlap placement vacates.
- **Land movers hole by hole, re-snapping after each.** Rejected: two touching
  holes merged into one must land everything exactly where the two separate
  holes would have, and only a single snap of the summed delta does that at a
  fractional rate.
- **Refuse any link with members on both sides of a hole.** Rejected: it
  refuses every interior deletion from a split clip, because a split keeps
  all the pieces in one link.
- **Locked tracks silently stay (Premiere).** Rejected: a silent desync.
- **Free markers ripple.** Deferred: a free marker marks the composition's
  own time by definition; Premiere and Resolve both ship this as an opt-in
  toggle, which is how it would arrive here.
- **Parent ripples when a Group shrinks (FCP compound clips).** Deferred to
  its own decision; Premiere and Resolve keep the parent instance's length.

## Consequences

- ADR 0048's "nothing ripples" narrows to "nothing ripples implicitly"; the
  overlap-placement rule and Policy B reconcile stand.
- Composition duration follows ADR 0005 unchanged: unpinned shrinks, pinned
  keeps its length.
- The `/cut-pauses` prompt may promise to tighten a clip again, and does
  it in one recorded edit.
- The refusal vocabulary grows by four variants, each carrying the entity
  it names; the status bar is the only after-the-fact surface.
- Ripple trim, insert edits and Sync Lock remain unbuilt and are named as
  such, so none arrives by drift. Gap selection has since arrived as its own
  decision, [ADR 0069](0069-a-gap-is-a-selectable-span-whose-delete-closes-it.md),
  built on this planner's closing.
