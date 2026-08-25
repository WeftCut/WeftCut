---
status: accepted
---

# A marquee's target kind comes from the anchor surface, not from the coordinates

## Context

The timeline holds two selectable populations, interleaved vertically. A track
lane holds clips; an expanded track's keyframe sub-lanes hold diamonds. A box
dragged down the timeline crosses both, so something has to decide which
population it is taking — and the answer cannot be "whatever the rectangle
happens to cover", because a single drag routinely covers both.

Three facts about the surfaces underneath shape every part of the answer.

**Timeline layout cannot be re-derived arithmetically.** `trackIdAtClientY`
carries a LANDMINE saying exactly why: a row carries chrome that a y-offset
table built from track heights cannot see — an expanded track's keyframe
sub-lane strip sits *between* its lane and the next one — so the table drifts a
full row or more per expanded track above the pointer, and the hit-test then
reports a foreign row. The DOM has already computed this layout.

**A sub-lane row is never a dope sheet.** The curve renderer positions every
diamond at its value's y in a collapsed 24 px row as well as in an expanded
72 px one — the value curve is drawn at both heights, thinner and handle-less
when the row is not editable. So y always carries the keyframe's value, and a
hit-test that ignored it would take the wrong keys in both modes.

**One row draws every layer on its track.** Each of those curves computes its
own value range, so an expanded row overlays several value axes in one band, and
a purely horizontal box crosses layers without the user doing anything unusual.
A keyframe selection is therefore cross-layer by construction — which is more
than the per-layer batch op could express in one undo entry, and more than the
single-slot keyframe selection could hold at all.

Background clearing lands on the same gesture. The timeline root's own click
handler cleared the clip selection, and the surfaces that actually reached it
were almost exactly the surfaces a marquee wants to anchor on — the ruler and the
track header escape it by stopping their own clicks. A press that becomes a box
and a press that clears the selection are the same press up to a few pixels of
travel, so two seams were competing for one gesture.

## Decision

**The surface the pointer went down on decides what the box selects.** Not the
geometry, not the box's extent, and not a modifier key.

1. **Four surfaces opt in explicitly**, each declaring its own kind through
   `useMarqueeAnchor({ kind })`: the track lane, the drop strip and the timeline
   scroll body take clips; a keyframe sub-lane row takes keyframes. The kind is
   fixed at pointerdown and never reconsidered — the box's extent decides which
   *members* of that one population it takes, across as many lanes, tracks,
   layers and properties as it reaches.

   The scroll body, not the timeline root: the root spans the sticky header
   column, so a box anchored there could start from the header's blank space,
   and excluding that column structurally is cheaper and safer than a coordinate
   test against `HEADER_COL_PX`. The time ruler is a child of the scroll body and
   stops `pointerdown` as well as `click`, so a press on the ruler is a scrub and
   only a scrub.

2. **A whitelist, never a root-level funnel.** The alternative — one handler on
   the timeline root plus `stopPropagation` on every child that owns its own
   gesture — makes every future clickable child a silent marquee trigger the day
   someone forgets. A whitelist is inert by default: a new child does nothing
   until it asks to.

3. **Background clearing lives in the same funnel, and clears per kind.** A press
   released below 3 px of travel *is* the timeline's background click; the root's
   `onClick` is gone. Displacement rather than a delay, because nothing sits under
   the pointer that a wobble could move. Clearing is per kind for the same reason
   the kind exists: blank lane space drops clips and the transition chip, blank
   sub-lane space drops keyframes only, so the Attribute panel stays on the clip
   being inspected. Escape and pointercancel restore the snapshot taken at
   pointerdown; a release keeps whatever the last move computed.

   The band below the last track belongs to this surface too. The lanes' container
   fills the panel (`min-h-full`), so the leftover space under a short project is
   part of the scroll body's clip surface: clicking it clears, and a box can start
   there and drag up over the tracks. The playhead and the header column's divider
   run the panel's full height as a consequence, which is what every other NLE
   does.

4. **Clips: x is computed, y is measured.** `t_start_us`/`t_end_us` × `pxPerSec`
   is a chip's exact horizontal extent and the timeline does not virtualize chips,
   so measuring x would only buy N `getBoundingClientRect` calls and a mandatory
   DOM for an answer already known exactly. y is measured per pointer event, for
   the LANDMINE's reason, and cached nowhere — which is also what absorbs a
   mid-gesture project mutation on the next move, with no cache to guard.

   **Intersect, never enclose**, half-open on both axes: a clip longer than the
   viewport can never be enclosed, so enclose-semantics would make exactly the
   long clips unselectable, and one half-open predicate covers three rules at once
   — a zero-area box takes nothing, and a box abutting a chip's edge leaves it
   alone. The band inside a lane comes from the one definition of the slice
   arithmetic, so grazing the top half of a combined A/V row takes the visual
   layer and not the audio one. Only rendered rows contribute, which is how the
   A/B Roll display filter is honoured — structurally, rather than by a second
   copy of the filter. Locked tracks and locked layers are holes, and a touched
   group fans out whole, locked members included, so a box can never build a
   selection a click could not.

5. **Keyframes: two-dimensional in an expanded row, x-only in a collapsed one.**
   The rule is row-height dependent and the reason is a measurement, not a taste.
   Since y carries the value at both heights (see Context), the question is only
   whether the user can *aim* at it. A 72 px value axis against a 7 px glyph is
   about seven distinguishable levels, so an expanded row tests the diamond's
   drawn `(x, y)`. A 24 px axis against the same glyph — rotated 45°, so a
   ~4.95 px half-diagonal — puts one diamond over roughly 40% of the whole axis,
   so adjacent keys visually overlap and vertical aim is not a capability the user
   has; a collapsed row tests x against any vertical overlap with its band. A 2D
   test in a collapsed row would make keys unselectable that the user can plainly
   see and click.

   **Centre point, no radius,** in both modes: a tolerance belongs to clicking,
   not to sweeping an area, and in an expanded row the box must actually cover the
   dot, which is the point of drawing one. Each curve's axis is its own, and it
   comes from the **committed** track — never from the render preview, which
   carries an in-flight handle drag or easing hover. The row reports its own
   `expanded` flag rather than having it re-derived from a measured height, so a
   future height change cannot break the rule silently. What the row does not draw
   is not a target: a locked track's sub-lanes, a linked layer's hidden twin axis,
   a param the layer does not animate.

6. **The keyframe selection is a Map, with no `primary`, and every multi-target
   operation costs one undo entry.** No `primary`, because every candidate
   consumer was checked and none needs one: the value field reads the playhead,
   the easing menu applies to the whole selection, and "which sub-lane is
   editable" is focus, not selection. A `primary` with no consumer is dead state,
   and dead state gets "used" by the next refactor in a way nobody specified.

   Both operations that ship — Delete and easing — share one funnel: group the
   selection by `(layerId, paramKey)`, fold each group once against its committed
   track, and commit every group through `update_param_tracks_multi`, whose
   entries each name their own layer. A sweep of seven keys across three layers
   is one undo entry. The per-layer form spends one entry per layer, which
   contradicts the reason that op exists. The scale-link invariant is swept once
   per distinct layer *after* every entry has landed — inside the loop it would
   read a half-applied `scale_x`/`scale_y` pair.

   The keyframe Delete preemptor is **one** capture-phase listener, on the
   Timeline. A per-track or per-layer listener is correct only while a selection
   cannot span layers: several arm at once for a swept selection, and the
   first-registered stops the event dead having deleted its own subset — several
   ops, several undo entries, and the surviving subset decided by mount order.

7. **Right-click operates on the selection rather than navigating to what was
   clicked.** An unselected diamond still selects, focuses and seeks; one already
   in the selection is left exactly as it is, and the menu acts on the whole
   selection — the rule the clip context menu already follows. The easing menu
   therefore reports **no** current interpolation while several keys are selected:
   no checkmark, no Elastic sliders. Showing the right-clicked key's interp would
   claim the rest of the selection matches it, and nothing on screen lets the user
   see through that. A uniform multi-selection is under-reported, which is the
   safe direction and the only one available to a menu holding one key's track.

8. **Deliberately not done.** No marquee **modifier keys**: the additive path is
   already `Shift+click`, so "sweep a block, then `Shift+click` to trim it" covers
   accumulation, and a `Shift`-marquee — if one is ever added — must **union**
   rather than toggle, because two overlapping XOR boxes cancel each other and
   accumulating across boxes is the only thing such a gesture is for. No
   **vertical auto-scroll**: the timeline's vertical extent is a handful of lanes
   while the horizontal one is unbounded, so horizontal is the axis that matters,
   and vertical scrolling would fight the sticky header column's row alignment. No
   **batch keyframe retime**: it is the one operation with genuinely new geometry
   — clamping against non-selected neighbours, against each layer's own bounds,
   and onto the frame grid, all per layer because `t_us` is layer-local while a
   drag delta is shared.

## Considered options

**One handler that works the kind out from the coordinates.** The instinct this
decision exists to answer, and it is a re-derivation of something the DOM has
already computed. It needs a y-table over lanes and sub-lane strips — precisely
the table `trackIdAtClientY`'s LANDMINE forbids, drifting a full row per expanded
track above the pointer. The failure is silent and it is not cosmetic: the box
would select confidently from the wrong population.

**A root funnel plus `stopPropagation` on every child.** Rejected in (2). It
inverts the default from inert to armed, and the cost lands on code that does not
exist yet.

**The kind from a modifier key, or from where the box ends.** A modifier makes
the user declare what the surface under their finger already says. Ending
geometry makes the population change mid-drag, so the same press means different
things depending on where it is released — and a box that starts in a sub-lane
and reaches a lane has no defensible answer at all.

**One uniform keyframe y-rule at both row heights.** The simplification this
decision most expects to be attempted. 2D everywhere makes collapsed-row keys
unselectable that the user can see and click; x-only everywhere discards the
vertical aim the expanded row *does* give, in the row that is the keyframe
*editing* surface — where covering the dot is the whole point, because the dot is
where the value is. Neither uniform rule survives a look at both rows.

**Keep background clearing on the timeline root.** Two seams racing over one
press, and it cannot express "a sub-threshold drag *is* a background click"
because the root does not know a gesture was armed. Merging them is also what
makes per-kind clearing available at all: the kind that decides what a box takes
may as well decide what a click drops.

**`deselectAll` for every background click.** Simpler, and wrong in one
direction that matters: clicking blank sub-lane space would drop the clip
selection and move the Attribute panel off the clip being inspected, in the
middle of keyframing it.

**N per-layer commits instead of a cross-layer op.** One gesture, N undo
entries, and a partial undo leaves the keyframes the user swept in a state they
never authored.

## Consequences

- A group's highlight can appear outside the box, and off screen. Accepted: the
  alternative builds a half-group selection the pointer could not otherwise
  produce and the next Delete would tear apart, since only the selection carries
  the group and the op level does not fan out.
- A non-empty clip marquee clears the keyframe selection, because the keyframe
  Delete preemptor answers first and a stale keyframe selection would eat the
  Delete meant for the clips just swept.
- Two layers' diamonds in one expanded row are drawn against different value
  axes, so two dots at the same screen y mean different values and one box takes
  both. That is pre-existing rendering, and testing the *drawn* position is what
  keeps the box honest about it — the question the user is asking is "did my box
  cover the dot I can see".
- The keyframe axis comes from the committed track while the row draws from a
  preview, so the two could in principle disagree. Left as a stated landmine
  rather than closed: reaching for the preview store would couple selection to an
  unrelated in-flight gesture, and the gap cannot open in practice because a
  marquee drag and a handle drag are both pointer gestures.
- A uniform multi-key selection reads as having no easing, per (7).
- The playhead and the header column's divider run the panel's full height, a
  visible change to a short project's timeline that comes out of (3).
- A box cannot reach a lane that is scrolled out of view vertically, per (8).
- The clip and keyframe populations can both be non-empty at once — a clip
  selection survives a keyframe sweep — which is the direction the sub-selection
  model already handles, since keyframes hold Delete priority.

## Coordinate spaces

Four spaces meet in this gesture, and mixing any two is a bug that a mocked-rect
test cannot catch, because the mock supplies the number the code is meant to
derive. That is what the end-to-end spec exists for.

- **The box is canvas-relative** — `clientX - canvasRect.left`, with no
  `scrollLeft` term, because the canvas sits inside the scrolling root and its
  rect already carries the scroll. That is what pins the anchor to the content
  rather than to the screen, and what lets edge auto-scroll grow the box under a
  pointer held still. The rect is re-read per publish, never cached.
- **`getBoundingClientRect` is client-relative**, so every measured lane and
  sub-lane row has the canvas's own top subtracted before it is compared with the
  box. Copying the drag hit-test's row measurement verbatim would skip that
  subtraction: it compares against a raw `clientY` and needs none.
- **`timeToXPx` is canvas-relative already.** It folds in the layer's start and
  answers absolute ruler px, and x = 0 is the canvas's left edge at t = 0 — so
  neither the chip's computed extent nor a diamond's x needs converting.
- **`valueToY` is row-local.** Its answer needs the row's measured top added
  back; dropped, an expanded row hit-tests a band one canvas origin above the
  one the user sees.

## Where this lives

- The rules, pure — `renderer/timeline/marquee.ts`: `marqueeHitClips`,
  `marqueeHitKeyframes` and `resolveMarqueeSelection`, split so the geometry
  stays free of project semantics (group fan-out, lock exclusion and primary
  survival are selection rules, not hit tests). No React and no DOM, so every
  rule is provable from hand-fed rows the way `geometry.test.ts` proves
  `trackIdAtClientY`.
- The gesture — `renderer/timeline/hooks/useMarqueeAnchor.ts`: the arm threshold,
  the edge auto-scroll pump, Escape and cancel, and the `onBox` /
  `onBackgroundClick` / `takeSnapshot` seam that keeps it ignorant of what a
  selection is. Its four consumers are `TrackLane.tsx`, `DropStrip.tsx`,
  `KeyframeLane.tsx`'s per-property row, and `Timeline.tsx`'s scroll body, which
  provides the context and so calls `beginMarquee` directly.
- The rectangle — `renderer/timeline/marqueeStore.ts` (a module store, not React
  state above a leaf) with `MarqueeOverlay.tsx` as its only subscriber, one
  element sized by `left`/`top`/`width`/`height` with a `border` hairline. Its
  LANDMINE says why it is not the compositor-only scaled unit box it looks like
  it should be: `scale` multiplies the element's used size, and a CSS `1px` is
  not 1 px at a fractional device pixel ratio, so the fill drifts off its own
  border by a fraction of the box's width.
- The wiring — `renderer/timeline/Timeline.tsx`: the row measurement in the box's
  coordinate space, the per-kind resolvers, the per-kind background clear, the
  batch commit, and the single keyframe Delete preemptor.
- The slice band's one definition — `renderer/timeline/geometry.ts`'s
  `layerSliceRect`, read by the chip renderer, the media-drop ghost, the
  transition chip and the marquee's vertical hit-test, so what is drawn cannot
  drift from what is selectable.
- The multi-target funnel — `renderer/timeline/keyframeBatch.ts` over
  `update_param_tracks_multi` in `main/state/actor.ts`; the stand-down rule the
  Delete preemptors share is `renderer/timeline/subSelectionDelete.ts`.
- The gate — `e2e/electron/timeline-marquee.spec.ts`, the only layer that can
  catch "the rectangle we measured is not the rectangle we thought".

## Industry baseline

Premiere, Resolve and Final Cut all ship a clip marquee where a plain box
replaces the selection and a modified one adds to it. Both halves are followed
here, with one gap: the modified box is not built, so the accumulation path is
the additive **click** those same apps use — which is a toggle, and toggling is
the one thing a box must not do. That is the whole of this decision's visible
asymmetry, and reserving union semantics rather than approximating them with the
click's toggle is the reason it is stated rather than smoothed over.

After Effects sweeps keyframes in its Graph Editor with a box that tests where
the key is drawn, against a value axis rather than a dope sheet — the same reason
y carries meaning here. What no NLE has is one keyframe row rendered at two
different heights with the same value graph in both, which is why the 2D/1D split
has no precedent to copy and rests on the measurement instead.
