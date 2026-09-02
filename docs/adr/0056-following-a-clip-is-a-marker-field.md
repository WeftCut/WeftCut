---
status: accepted
---

# Following a clip is a marker field, not a second marker kind

## Context

A marker belongs to one composition and marks a time on that composition's own
clock. That is all it has ever meant here, and it is the right meaning for the
notes an editor leaves on a cut: *music change*, *check this*, *chapter 2*.

It is the wrong meaning for a note about a SHOT. "The dog blinks here" is a fact
about two seconds of a video file, not about the film's third second, and the
first ripple edit upstream turns it into a lie. Every timeline the marker sits on
moves under it; the marker does not move. Shot detection already writes markers
of exactly this kind — one per detected cut, all of them tied to the source they
were computed from — so the editor was already producing marks that go stale on
the next drag.

Premiere and Resolve both answer this with a SECOND marker: clip markers
alongside sequence markers, living on the clip and travelling with it. That is a
second entity, and this codebase has one strong opinion about second entities:
`model.ts` records the house rule for exactly this shape — root and Group
compositions share one `Composition` type with no sub type, because twin types
leave every walk, every mutation and every validator with two paths, and twin
paths drift. A second marker kind would fork the lane, the `Ctrl+K` palette, the
`summary.ts` projection, serialize, the MCP surface and validate.

Two facts about the ground make the alternative cheap right now.

**Source-to-timeline mapping is speed=1.** `hybrids.ts` maps a detected shot
boundary to a timeline time by one addition, and records that variable speed is
deferred — the same deferral `split_layer` takes. While that holds, resolving
"where does source time *s* sit on the timeline" is
`layer.t_start_us + (s − src_in_us)`, snapped. Once variable speed lands, the
same field needs a time remap and costs an order of magnitude more to maintain.
The field is right either way; the arithmetic is what will need revisiting.

**Transitions already proved how a relationship survives ordinary edits.**
A transition is a composition-level object referencing two layers, and every
trim, move, split and delete can break it. The answer was reconcile-on-commit
(Policy B, ADR 0035): the commit pipeline re-checks every transition after the
mutation recipe and before validate, so ordinary edits stay transition-blind and
the correction lands in the SAME history snapshot as the edit that caused it.
One undo restores both.

## Decision

1. **A marker gains an anchor FIELD; there is no second marker.** `Marker.anchor`
   is `{ layer, src_us } | null`. `null` is a FREE marker and behaves exactly as
   every marker did before anchoring existed. Non-null is an ANCHORED marker: it
   names a layer of its OWN composition and a time in that layer's source
   domain. Single ownership survives untouched — a marker still lives in exactly
   one composition's `markers`, and every consumer keeps one path.

2. **`t_us` stays STORED, and that is the whole trick.** The anchor is truth and
   `t_us` becomes a derived cache — but the cache lives *in state*, so every
   reader needs no change at all: the lane, `Ctrl+K`, the `summary.ts`
   projection, serialize, MCP and export all go on reading `t_us`. Deriving at
   projection time instead would strip the meaning out of the sorted-markers
   invariant (`markers` is ordered by `t_us`, and the lane's frame lookup and the
   add path's insertion scan both rely on it) and force every reader to re-resolve
   an anchor it has no business knowing about.

3. **`reconcileMarkers` runs beside `reconcileTransitions`, in the same slot.**
   Inside the commit's `produce()`, after the mutation recipe and before
   validate. The three reasons are the transitions' three, verbatim: ordinary
   edits stay marker-blind, the correction lands in the same history snapshot as
   the edit, and the function returns primitive drop info rather than draft
   references (immer revokes those when `produce` returns). It runs on EVERY
   commit, which is what lets no mutation anywhere know that markers exist.

4. **Delete DROPS, trim HIBERNATES, and the asymmetry is the design.**
   Deleting the anchor layer removes the marker, in the same commit, with a
   status-log row — the same policy transitions take when a participant leaves.
   Delete means delete; a clip-scoped mark outlives nothing. Trimming past the
   mark instead HIBERNATES it: the anchor is kept, `t_us` is frozen, and nothing
   is re-derived while `src_us` sits outside `[src_in_us, src_out_us)`. Because
   truth lives in source space, re-extending the layer or undoing the trim
   restores the exact frame for free; burning the marker would throw that away
   and no undo could give it back. **A split reduces to the trim case with no
   special handling**: `split.ts` gives the LEFT half the original layer id, so a
   mark on right-half content simply falls out of the left half's window and
   sleeps.

5. **Hibernation is DERIVED, never stored.** There is no `hibernating` field, and
   `validate` deliberately does not range-check `src_us`. The condition is
   recomputed on every commit and by the lane's projection from one shared
   predicate, which is exactly what makes revival automatic and free rather than
   a second state machine to keep in step. A stored flag would have to be
   cleared by every path that could widen a window, and one missed path is a
   marker that never wakes up.

6. **An anchored marker follows the SET across a composition boundary. This
   REVERSES the earlier rule that markers never cross.** The helper that carries
   links and transitions with a departing set now carries anchored markers too,
   and is named for all three. The reason the old rule read as obvious is that it
   was stated about free markers, where it is still true: a free marker marks a
   composition's own time, not the layers that left it. An anchored marker names
   a layer, and **a move is not a delete** — leaving it behind would produce an
   anchor reaching across a boundary that no `t_us` can be derived over, which
   validate refuses. Its `t_us` needs no fixing at the move: the same commit's
   reconcile re-derives it in the destination before validate ever sees the
   draft.

7. **A layer that exists SOMEWHERE is never a drop.** The reconcile drops only
   when the anchor layer is in no composition at all. A layer alive in a
   *different* composition than its marker means the crossing failed to keep the
   pair together — a bug — and the reconcile leaves both alone so validate can
   refuse the whole commit with `MarkerAnchorNotInComposition`. Dropping there
   would destroy the user's marker and hide the defect that caused it.

8. **Drops are reported in the status bar, never a toast.** One `Project` row per
   dropped marker, on the same best-effort log seam transition drops use, emitted
   after the commit is recorded so a rejected commit reports nothing. This app's
   house pattern for a consequence the user did not directly ask for is
   prevention plus the status bar; toasts were explicitly refused for this class
   of event.

9. **Attach and detach are explicit operations.** No gesture silently sets or
   clears an anchor, and `anchor` is not reachable through the generic marker
   patch: a patch could name a layer in another composition, or move the anchor
   without moving the marker, and neither inconsistency has a repair. `t_us`
   stays patchable precisely because it is the cache the next reconcile corrects.

## Considered options

**A second marker entity — clip markers beside sequence markers, as Premiere and
Resolve ship them.** Rejected. It forks every marker consumer: the lane, the
`Ctrl+K` palette, the `summary.ts` projection, serialize, the MCP surface and
validate would each grow a second path, and the two paths would
drift. It is the same trade the composition model already refused — one
`Composition` shape for the root and every Group, because a sub type gives every
walk and validator a twin. The user-visible capability is identical; only the
number of types differs.

**Deriving `t_us` at projection time and not storing it.** Rejected. Storage is
what keeps every reader unchanged. Without it the sorted-markers invariant means
nothing (the stored order would not be the drawn order), every reader has to
resolve an anchor and know about source windows, and serialize would write a
marker whose time depends on which layer happens to be loaded. The cache being
stale between the mutation and the reconcile is not a hazard, because those two
happen inside one `produce()`.

**Burning the marker — deleting it, or freezing it as a free marker at its last
`t_us` — when a trim passes it.** Rejected. Both throw away the one thing that
makes the feature cheap: the tie is held in SOURCE time, so an out-of-window
marker is fully recoverable and re-extending the layer restores the exact frame
with no bookkeeping. Deleting makes an ordinary trim destructive in a way undo
cannot fully repair (the marker returns, but only because undo restores the whole
snapshot — a later re-extend would not bring it back). Converting to free is
worse: it silently changes what the marker MEANS, and nothing tells the user.

**Storing a `hibernating` flag rather than deriving it.** Rejected. Every path
that widens a source window would have to clear it — trim out, trim in, undo,
split's left half, a Group's overhang, `replace_state`, a project loaded from
disk — and one missed path is a marker that never paints again. Deriving costs a
comparison.

**Range-checking `src_us` in `validate`.** Rejected, and this is the trap it
avoids: an ordinary trim would then produce a project that cannot be committed,
and a project already on disk that cannot be opened. Hibernating is a legal
state, so the validator is silent about it on purpose.

**Leaving markers behind on a cross-composition move, as the crossing primitive
originally specified.** Rejected — see decision 6. The rule was written when
every marker was free, and it survives for those.

## Consequences

- **Every commit walks the markers.** The cost is one map of the composition's
  layers plus one comparison per anchored marker, and a project-wide layer set
  only when an anchor misses its own composition. It is paid on commits that
  cannot possibly have moved a marker, which is the same bargain
  `reconcileTransitions` already struck and the reason no mutation has to know
  markers exist.
- **The anchor arithmetic assumes speed=1.** It is one addition today. When
  variable speed lands, this is one of the sites that becomes a time remap — the
  same list `split_layer` and the shot-cut resolver are already on.
- **A region marker's end follows the same delta as its start.** One anchor means
  one mapping, so the span the user drew is carried rather than re-derived;
  holding the end still while the start follows would stretch the region and
  eventually invert it. The span is also what the model keeps when a trim
  shortens the clip into the region: the summary projection narrows the shown
  end to the clip's out point (`markerShownEnd`), and re-extending the clip
  shows the whole span again.
- **Free markers are unchanged in every respect** — model, behaviour, ordering,
  and the composition they belong to across a move. Nothing about the feature
  reaches a project that never attaches one.
- **A marker can now be in state and not on screen.** Hibernating markers are
  retained and unpainted, which means the marker Panel is the only surface that
  can show one, and "I can't see my marker" becomes a question the UI has to be
  able to answer.
- **`MarkerAnchorNotInComposition` is a bug detector, not a user-facing rule.**
  No gesture can produce it; if it ever fires, a crossing dropped its markers.
