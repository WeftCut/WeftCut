// The live clip drag (move / trim-start / trim-end): the gesture's types, and
// the ARMED half of its state. `hooks/useLayerDrag.ts` is its only writer, and
// it publishes nothing until the gesture arms — so a subscriber that sees a
// drag is seeing one the user can see too.
//
// A module-level store for the reason `marqueeStore.ts` states: nothing at
// event rate may live in React state above a leaf, because one `useState` on
// the timeline root re-renders every lane, sub-lane and chip per pointermove.
// It is also the only place a SECOND timeline Panel can read the gesture from —
// each Panel owns its own React state, its own zoom and its own grid (ADR 0053).
//
// What this module does NOT own: the drag's rules. Snapping, the causality
// gates, the arm delay, the projection and the commit all stay in
// `hooks/useLayerDrag.ts`; this is where their result is published.

import { create } from "zustand";
import type { LayerParamsView } from "../ipc";
import { SPAWN_TRACK_ID, type PlacementValidity } from "./placement";

export type DragKind = "move" | "trim-start" | "trim-end";

/// One clip the gesture carries — a DESCRIPTION of it, never a mirror. The two
/// display fields are here because a Panel showing ANOTHER composition can draw
/// a preview of this drop and has no summary to look them up in; nothing else
/// follows them across, so a keyframe track or an effect chain never rides a
/// pointermove.
export interface DragSubject {
  layerId: string;
  trackId: string;
  originalTStart: number;
  originalTEnd: number;
  /// Decides the overlap class (`overlapClassForKind`) and the type colour
  /// (`timelineLayerTheme`) of a preview drawn outside this layer's own Panel.
  kind: LayerParamsView["kind"];
  /// The clip's display name, resolved by `lib/layerName.ts` where the layer
  /// still is — the same string its own block shows.
  name: string;
  /// The layer's own lock, or its lane's. A scalar rather than a mirror, and it
  /// has to travel: the seed can never be locked (a locked block refuses
  /// `pointerdown`), but a LINK MEMBER dragged along with it can be, and a
  /// Panel the layer does not live in has no summary to discover that in. The
  /// in-composition projection reads the same pair to refuse
  /// (`buildMoveProjection`), so without this the same set would preview green
  /// next door and amber at home.
  locked: boolean;
}

export interface DragSeed {
  kind: DragKind;
  layerId: string;
  trackId: string;
  /// Originating track's kind. Not consulted when picking a drop target —
  /// tracks are kind-agnostic (`trackAcceptsForLayer` accepts any track).
  trackKind: string;
  startX: number;
  startY: number;
  originalTStart: number;
  originalTEnd: number;
  deltaUs: number;
  /// During cross-track drag, which track is the pointer currently over.
  overTrackId: string | null;
  /// Alt+body-drag duplicates the layer at the drop position. This is a fixed
  /// timeline gesture rather than a configurable keyboard shortcut.
  duplicate: boolean;
  /// Link escape remains available to trim gestures. Body-drag reserves Alt
  /// for duplicate, so ordinary moves continue to fan out across the link.
  escapeLink: boolean;
  /// Selection state before this pointerdown. An unselected clip body gets a
  /// short temporal arm delay so a selection click cannot become a move;
  /// selected clips and explicit trim handles respond immediately.
  wasSelectedAtPointerDown: boolean;
  /// The selection as it stood BEFORE this pointerdown's own click applied. A
  /// duplicate's subject set reads it (`buildDragSubjects`): the whole link,
  /// unless the user had already narrowed the selection to some of its members
  /// — an `Alt`+click first. The selection is the escape, because `Alt` on the
  /// body already means duplicate and the click itself always Alt-selects.
  selectedAtPointerDown: ReadonlySet<string>;
}

export interface DragState extends DragSeed {
  /// The composition of the Panel the gesture started in, stamped by
  /// `useLayerDrag` from its own axis rather than carried on the seed — the
  /// block that mints a seed has no reason to know.
  ///
  /// LANDMINE: this store is module-level, so EVERY mounted Panel reads every
  /// gesture. Subscribers keyed on a layer or track id are safe, those being
  /// project-unique; a subscriber that asks "is a drag happening" is not, and
  /// must ask "is one of MINE happening" against this field. Without it a
  /// second timeline arms its drop strip, shows a grabbing cursor and drives
  /// the monitor for a gesture in its neighbour (ADR 0053).
  compositionId: string | null;
  subjects: DragSubject[];
  validity: PlacementValidity;
  conflictingLayerIds: string[];
  /// Subjects on lanes the display filter hides. A move fans out to them with
  /// nothing on screen to show it, so the dragged member's ghost carries this
  /// count as a badge for the duration of the gesture.
  hiddenSubjectCount: number;
}

/// What a Panel the gesture did NOT start in has resolved the drop to, in its
/// OWN units — its zoom, its frame grid, its lanes, its snapping targets. Only
/// that Panel can compute it (ADR 0053), which is why the answer is published
/// here instead of being recomputed by whoever wants it: no other party to the
/// gesture shares the axis it is expressed on.
export interface ForeignDropClaim {
  /// The claiming Panel's composition — the destination, and the axis
  /// `anchorTStartUs` belongs to.
  compositionId: string;
  /// A lane id, `SPAWN_TRACK_ID` for the drop strip, or null when the pointer
  /// is inside the Panel but over no row at all (its ruler, or the band below
  /// the last lane).
  trackId: string | null;
  /// Where the gesture's ANCHOR subject's head lands. Every other subject holds
  /// its phase to it, so this one number positions the whole set.
  anchorTStartUs: number;
  validity: PlacementValidity;
}

interface LayerDragStore {
  /// The ARMED gesture, or null. A gesture still inside its temporal arm delay,
  /// or one that has not yet caused a frame or track change, is not here —
  /// `useLayerDrag` holds that in a ref, where it cannot render anything.
  drag: DragState | null;
  /// Where the pointer last was, in client coordinates. Held beside the gesture
  /// rather than inside it because it is the one value expressed in NO
  /// composition's axis: a Panel that did not start the drag can still turn it
  /// into a time on its own grid.
  pointer: { clientX: number; clientY: number } | null;
  /// The destination Panel's resolved landing, while the pointer is over one.
  /// Written by `ForeignDragGhost.tsx` — the only party that can resolve it —
  /// and read by the destination's own drop strip, which arms on it because a
  /// release there really does spawn a lane in THIS composition.
  ///
  /// LANDMINE: not what the release commits through. `end()` clears this before
  /// the destination's `pointerup` listener runs (see the ref in
  /// `ForeignDragGhost.tsx`), so anything read here at release time is gone.
  claim: ForeignDropClaim | null;
  begin: (state: DragState, clientX: number, clientY: number) => void;
  publish: (state: DragState) => void;
  moveVisual: (clientX: number, clientY: number) => void;
  claimDropTarget: (claim: ForeignDropClaim) => void;
  releaseDropTarget: (compositionId: string) => void;
  end: () => void;
}

/// Whether a pointermove produced any change worth re-rendering for. Only these
/// four fields move within a gesture — everything else in `DragState` comes
/// from the seed or from `buildDragSubjects` and is fixed once — and `subjects`
/// identity stands in for all of it, being minted once per gesture.
function sameDragValue(a: DragState, b: DragState): boolean {
  if (
    a.subjects !== b.subjects ||
    a.deltaUs !== b.deltaUs ||
    a.overTrackId !== b.overTrackId ||
    a.validity !== b.validity ||
    a.conflictingLayerIds.length !== b.conflictingLayerIds.length
  ) {
    return false;
  }
  for (let i = 0; i < a.conflictingLayerIds.length; i += 1) {
    if (a.conflictingLayerIds[i] !== b.conflictingLayerIds[i]) return false;
  }
  return true;
}

function sameClaimValue(a: ForeignDropClaim, b: ForeignDropClaim): boolean {
  return (
    a.compositionId === b.compositionId &&
    a.trackId === b.trackId &&
    a.anchorTStartUs === b.anchorTStartUs &&
    a.validity === b.validity
  );
}

export const useLayerDragStore = create<LayerDragStore>((set) => ({
  drag: null,
  pointer: null,
  claim: null,
  /// The gesture arms: this is the first frame anything is drawn for it.
  begin: (drag, clientX, clientY) => set({ drag, pointer: { clientX, clientY } }),
  /// Every subsequent pointermove. Guarded on VALUE, not identity, the way
  /// `setMarqueeBox` is: `useLayerDrag` rebuilds the state object per event, so
  /// a pointer that wiggled inside one frame would otherwise wake every
  /// subscriber with nothing to show them.
  publish: (drag) =>
    set((s) => (s.drag !== null && sameDragValue(s.drag, drag) ? s : { drag })),
  moveVisual: (clientX, clientY) =>
    set((s) =>
      s.drag === null ||
      (s.pointer?.clientX === clientX && s.pointer.clientY === clientY)
        ? s
        : { pointer: { clientX, clientY } },
    ),
  /// Value-guarded like `publish`: the claimant re-resolves the landing on
  /// every pointermove, and a pointer that wiggled inside one frame lands on
  /// the same lane at the same time.
  claimDropTarget: (claim) =>
    set((s) => (s.claim !== null && sameClaimValue(s.claim, claim) ? s : { claim })),
  /// Identity-guarded, the `useMediaDragStore` rule: only the current claimant
  /// may let go. Without it a Panel processing the pointer's departure would
  /// clear the claim the Panel it arrived at has already made.
  releaseDropTarget: (compositionId) =>
    set((s) => (s.claim?.compositionId === compositionId ? { claim: null } : s)),
  /// Release, Escape, or a gesture whose host Panel went away. Safe to call on
  /// a gesture that never armed; that is a no-op, not a write.
  end: () =>
    set((s) =>
      s.drag === null && s.pointer === null && s.claim === null
        ? s
        : { drag: null, pointer: null, claim: null },
    ),
}));

// ---- Subscribers ----
//
// Profiling note — what a pointermove wakes, and why the hooks are shaped the
// way they are. Each one is GATED on the caller's own id and then hands back
// `s.drag` itself, a reference this module never rebuilds mid-event; callers
// the event does not concern read a `null` that never changes. So one
// pointermove re-renders exactly:
//
//   - every `LayerBlock` the drag carries (`useLayerDragFor`) — the delta IS
//     their geometry, so they have to;
//   - the lanes holding those blocks, the lane under the pointer, and the lane
//     the pointer just left (`useLayerDragForTrack`) — the last of those
//     renders once more, to drop the chrome it was drawing, and then goes quiet;
//   - the drop strip, but only while the pointer is over it, and then only if
//     the clip head moves — which a raise never lets it do (`deltaUs` is pinned
//     to 0 over the strip).
//
// Every other lane, block, chip and sub-lane sees an unchanged `null` and does
// not render. `Timeline.tsx` subscribes only to booleans and to `subjects`,
// none of which a pointermove can change — which is the point: a `useState` up
// there would re-render all of the above regardless of what these return.
//
// A second Panel showing another composition renders two things for a gesture
// that is not its own, and only two: `ForeignDragGhost`, which follows the
// pointer because it is the preview, and the drop strip it claims a landing on.
// Its lanes and blocks cannot match a foreign id, and the hooks that would
// otherwise match anything are gated on `DragState.compositionId`.

/// Whether a lane is one this gesture concerns. A lane the pointer merely
/// passed over stops matching the moment it leaves, which is what limits the
/// per-event render set to "changed lanes" rather than "all lanes".
function laneParticipates(drag: DragState, trackId: string): boolean {
  if (drag.overTrackId === trackId) return true;
  return drag.subjects.some((subject) => subject.trackId === trackId);
}

/// The timeline root's own read: the grabbing cursor while a clip drag started
/// in THIS Panel is live. Flips twice per gesture, so it costs the root two
/// renders in total. Composition-gated because the cursor is a statement about
/// this Panel — a neighbour showing it for a gesture that never touched it
/// would be claiming a drop it will not accept.
export const useIsLayerDragging = (compositionId: string | null): boolean =>
  useLayerDragStore((s) => s.drag !== null && s.drag.compositionId === compositionId);

/// The live gesture as one lane sees it, or null when this lane has nothing to
/// draw for it. Trims are excluded deliberately: nothing a lane renders is
/// derived from a trim (`TrackLane` guards every use on `kind === "move"`), and
/// the trimmed clip's own block subscribes for itself.
export const useLayerDragForTrack = (trackId: string): DragState | null =>
  useLayerDragStore((s) =>
    s.drag !== null && s.drag.kind === "move" && laneParticipates(s.drag, trackId)
      ? s.drag
      : null,
  );

/// The live gesture as one clip sees it, or null when the drag does not carry
/// this layer. A block that is not a subject reads the same `null` all gesture
/// and never re-renders.
export const useLayerDragFor = (layerId: string): DragState | null =>
  useLayerDragStore((s) =>
    s.drag !== null &&
    s.drag.subjects.some((subject) => subject.layerId === layerId)
      ? s.drag
      : null,
  );

/// The subject set of a live MOVE, or null. Atomic on purpose: `subjects` is
/// minted once per gesture and every `{ ...state, … }` downstream preserves its
/// identity, so this reference survives the whole drag. `useLayerDrag`'s
/// `dragLayerById` memo hangs off that identity — rebuild `subjects` per event
/// and every lane re-renders again.
export const useLayerMoveDragSubjects = (): DragSubject[] | null =>
  useLayerDragStore((s) =>
    s.drag !== null && s.drag.kind === "move" ? s.drag.subjects : null,
  );

/// Whether a body-move gesture started in THIS composition is live. The drop
/// strip arms on it — the row shows itself only while something could be
/// released on it, and a strip that armed for the neighbour's gesture would be
/// offering a landing the release does not make.
export const useIsLayerMoveDragging = (compositionId: string | null): boolean =>
  useLayerDragStore(
    (s) => s.drag?.kind === "move" && s.drag.compositionId === compositionId,
  );

/// Whether a clip carried in from ANOTHER Panel has resolved a landing here —
/// the drop strip's second arming condition, and the one the hook above cannot
/// answer: the gesture belongs to a composition this Panel must not arm for
/// (see the LANDMINE on `DragState.compositionId`), so the claim is the only
/// evidence that a release here would land. A boolean, so the per-event churn
/// of the claim's time does not reach the strip.
export const useIsForeignDropClaimed = (
  compositionId: string | null,
): boolean =>
  useLayerDragStore(
    (s) => compositionId !== null && s.claim?.compositionId === compositionId,
  );

/// The foreign clip's head, in this composition's µs, while its claim names the
/// drop strip — the sibling of `useLayerDragStripAnchorUs` for a gesture that
/// started next door. Null over a lane, so the strip re-renders per pointer
/// event only while the pointer is actually on it.
export const useForeignDropStripAnchorUs = (
  compositionId: string | null,
): number | null =>
  useLayerDragStore((s) =>
    s.claim !== null &&
    s.claim.compositionId === compositionId &&
    s.claim.trackId === SPAWN_TRACK_ID
      ? s.claim.anchorTStartUs
      : null,
  );

/// The dragged clip's head, in this composition's µs, while the drop strip is
/// the resolved destination — null otherwise, which is also the strip's answer
/// to "is a clip drag over me". Gated so a drag that never reaches the strip
/// does not re-render it, and exact because a raise carries times verbatim:
/// `deltaUs` is pinned to 0 over the strip, so this head is where the clip lands.
///
/// The composition gate is what makes "in this composition's µs" true: the head
/// is on the DRAG's axis, and only the Panel the drag started in shares it.
export const useLayerDragStripAnchorUs = (
  compositionId: string | null,
): number | null =>
  useLayerDragStore((s) =>
    s.drag !== null &&
    s.drag.kind === "move" &&
    s.drag.compositionId === compositionId &&
    s.drag.overTrackId === SPAWN_TRACK_ID
      ? Math.max(0, s.drag.originalTStart + s.drag.deltaUs)
      : null,
  );
