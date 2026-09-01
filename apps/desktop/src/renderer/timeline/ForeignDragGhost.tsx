// The destination half of a cross-Panel clip drag: one per timeline Panel, it
// hit-tests the pointer against itself, resolves the landing in THIS
// composition's units, publishes the claim, draws the preview, and — on
// release — commits it.
//
// A leaf subscriber of `layerDragStore.ts`, for the reason
// `LayerDragTrimMonitor` is one: a pointermove has to re-render whatever follows
// the pointer, and if that were a lane — or the Panel root — every lane, chip and
// sub-lane would render with it. The claim is not spread across the lanes for
// the same reason. A clip drag is pointer-driven and the HOST owns the `window`
// listeners, so a destination lane receives no events of its own and would have
// to subscribe to the store's `pointer` to notice anything, waking every lane
// per event. (A media drag is HTML5 drag-and-drop, whose events land on the
// destination's own elements — which is why `TrackLane` can claim one itself and
// this cannot borrow that shape.)
//
// Ownership follows the coordinate system. Zoom, scroll, frame grid, snapping
// targets and lane geometry are all per Panel (`useTimelineView`), so only the
// Panel under the pointer can turn that pointer into a landing; a host that
// borrowed them would be re-implementing them at a distance, and the two copies
// would drift.
//
// What this does NOT own: the gesture. The host arms it, tracks it, freezes its
// own ghost while the pointer is away and refuses a COPY across compositions
// (`crossCompositionRefusal.ts`). Release is this Panel's, because the landing
// is: only the composition under the pointer can name a lane and a time on its
// own axis, so it is the one that sends `move_layers_to_composition`.

import { useEffect, useRef } from "react";
import {
  moveLayersToComposition,
  type LinkSummary,
  type TrackSummary,
} from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
import { focusComposition } from "../state/compositionAnchorStore";
import { setLayerSelection } from "../state/selectionStore";
import { snapFrameRound } from "../frames";
import { playheadClockUs } from "../state/playheadProjection";
import { DragGhostChip, dragGhostBand } from "./DragGhostChip";
import {
  overlapClassForKind,
  trackIdAtClientY,
  type MeasuredTrackRow,
  type VisualTrack,
} from "./geometry";
import {
  shiftMembersOf,
  useLayerDragStore,
  type DragState,
  type DragSubject,
} from "./layerDragStore";
import { floorShiftAtZero, shiftOnGrids } from "../grid";
import {
  evaluateTimelinePlacements,
  SPAWN_TRACK_ID,
  type PlacementValidity,
  type TimelinePlacement,
} from "./placement";
import { snapDragDeltaToTimelineBoundary } from "./snapping";
import { foreignCompositionAtPoint } from "./timelineSurfaces";

export interface ForeignDragGhostProps {
  /// This Panel's composition. The axis every number below is expressed on, and
  /// the identity the pointer hit-test is compared against.
  compositionId: string | null;
  /// This composition's committed lanes — what the landing is validated against.
  tracks: TrackSummary[];
  /// The RENDERED lanes, in visual order. Only these are droppable, so the A/B
  /// Roll filter decides the hit-test's row list with no rule of its own here.
  orderedTracks: VisualTrack[];
  /// Live track-id → lane-element registry, and the drop strip's row, both owned
  /// by the Timeline. Measured per pointer event, exactly as the in-composition
  /// drag measures them (`useLayerDrag`'s `destinationUnderPointer`).
  laneEls: React.RefObject<Map<string, HTMLElement>>;
  dropStripEl: React.RefObject<HTMLElement | null>;
  /// `timeline-canvas` — this component's own positioning context, and the
  /// origin the pointer's x is turned into a time against.
  canvasRef: React.RefObject<HTMLElement | null>;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  /// Snap targets: this composition's rendered layer boundaries and its links.
  snapTracks: readonly TrackSummary[];
  links: readonly LinkSummary[];
  linkByLayerId: ReadonlyMap<string, string>;
  tailSnapEnabled: boolean;
  tailSnapStrengthPx: number;
}

/// Whether a published gesture is one this Panel could receive at all. Every
/// term is pointer-free, which is what keeps the subscriptions below cheap: the
/// Panel that owns the gesture reads a `null` that never changes for the whole
/// drag and never re-renders, and so does every Panel while `Alt` is held.
///
/// `duplicate` draws nothing on purpose: a copy into another composition mints
/// ids and is a mutation of its own rather than a parameter of this one, so a
/// preview would promise a landing nothing can make.
function couldLandHere(
  drag: DragState | null,
  compositionId: string | null,
): boolean {
  return (
    compositionId !== null &&
    drag !== null &&
    drag.kind === "move" &&
    !drag.duplicate &&
    drag.compositionId !== compositionId
  );
}

interface GhostBlock {
  subject: DragSubject;
  tStartUs: number;
  tEndUs: number;
}

/// Everything `move_layers_to_composition` needs, resolved while the gesture is
/// still live so that release has nothing left to work out. Only a landing the
/// command would ACCEPT becomes one of these — see `committableDrop`.
interface ResolvedDrop {
  layerIds: string[];
  /// The composition the gesture started in — kept so the release can re-ask
  /// `foreignCompositionAtPoint` from the RELEASE's own coordinates.
  fromCompositionId: string | null;
  toCompositionId: string;
  anchorLayerId: string;
  anchorTStartUs: number;
  /// `"spawn"` is the COMMAND's word for the drop strip; `SPAWN_TRACK_ID` is the
  /// hit-test's. Sending the sentinel gets `TrackNotFound`.
  toTrackId: string | "spawn";
}

interface ForeignLanding {
  trackId: string | null;
  anchorTStartUs: number;
  validity: PlacementValidity;
  /// The row's chip band, in `timeline-canvas` coordinates. Null when the
  /// pointer is inside this Panel but over no row, which is also when `blocks`
  /// is empty — there is no lane to draw in.
  band: { top: number; height: number } | null;
  blocks: GhostBlock[];
  /// What releasing here would send, or null when it would send nothing.
  drop: ResolvedDrop | null;
}

/// The commit a release on this landing would make, or null when the landing
/// refuses it.
///
/// ONE comparison, the same one `useLayerDrag`'s move commit makes: `"spawn"`
/// over the strip (a lane that does not exist yet is never `"valid"`),
/// `"valid"` over a real lane. Collision and lock out-rank both words, so this
/// is also the refusal and the locked case needs no branch of its own.
///
/// The anchor is the ghost's own, handed in rather than re-picked: the landing
/// time positions THAT subject, so a commit that named a different one would
/// place the set somewhere the preview never drew.
function committableDrop(
  drag: DragState,
  anchor: DragSubject,
  toCompositionId: string,
  trackId: string,
  anchorTStartUs: number,
  validity: PlacementValidity,
): ResolvedDrop | null {
  const spawning = trackId === SPAWN_TRACK_ID;
  if (validity !== (spawning ? "spawn" : "valid")) return null;
  return {
    layerIds: drag.subjects.map((subject) => subject.layerId),
    fromCompositionId: drag.compositionId,
    toCompositionId,
    anchorLayerId: anchor.layerId,
    anchorTStartUs,
    toTrackId: spawning ? "spawn" : trackId,
  };
}

/// Send the drop, then let the selection and the keyboard follow it.
///
/// The selection and the focus BOTH move, where the *Move to composition ›*
/// menu clears the selection and stays where it was
/// (`commands/groupCommands.ts`). The difference is the pointer: a gesture that
/// named a place may move the view there, and the clips are visible at the
/// place it named; a menu item, which never left the Panel it was opened in,
/// may not.
///
/// No refresh call — the `project:changed` subscription refreshes every view.
async function commitForeignDrop(drop: ResolvedDrop): Promise<void> {
  try {
    await moveLayersToComposition(
      drop.layerIds,
      drop.toCompositionId,
      drop.anchorLayerId,
      drop.anchorTStartUs,
      drop.toTrackId,
    );
  } catch (err) {
    // A green ghost is a reading, not a promise: the project can change under
    // the gesture, and the refusal then belongs on the status bar rather than
    // in devtools. The in-composition drag's existing property, not a new one.
    logMutationFailure(err, "move_layers_to_composition");
    return;
  }
  // Focus BEFORE the selection, and not the other way round: `focusComposition`
  // CLEARS the selection whenever it actually moves the editing target
  // (`state/compositionAnchorStore.ts`), so the reverse order would hand the
  // inspector an empty selection.
  focusComposition(drop.toCompositionId);
  setLayerSelection(drop.anchorLayerId, drop.layerIds);
}

/// Turn the live gesture and the pointer into this composition's landing, or
/// null when this Panel is not the one under the pointer.
///
/// One forced reflow per pointer event, as the in-composition hit-test costs;
/// the remaining rect reads then hit clean layout.
function resolveForeignDrop(
  opts: ForeignDragGhostProps,
  drag: DragState,
  pointer: { clientX: number; clientY: number },
): ForeignLanding | null {
  const { compositionId, pxPerSec, fpsNum, fpsDen } = opts;
  if (compositionId === null || pxPerSec <= 0) return null;
  // The same question the host asks to refuse, asked from the other side: the
  // host wants "somebody else's", this wants "mine".
  if (
    foreignCompositionAtPoint(
      drag.compositionId,
      pointer.clientX,
      pointer.clientY,
    ) !== compositionId
  ) {
    return null;
  }
  const canvas = opts.canvasRef.current;
  if (canvas === null) return null;
  const canvasRect = canvas.getBoundingClientRect();

  const anchor =
    drag.subjects.find((subject) => subject.layerId === drag.layerId) ??
    drag.subjects[0];
  if (anchor === undefined) return null;

  // The clip stays where the user took hold of it: the pointer names the GRAB
  // POINT and the head sits that far behind it, which is what the drag already
  // does at home — `deltaUs` is measured from `startX`, so the grab point is
  // preserved structurally there. The offset crosses as a DURATION, so the
  // source Panel's zoom never reaches this arithmetic; that is the same property
  // that lets the set's phase and each clip's length cross, and dropping the
  // offset instead is what used to make the clip jump the moment the pointer
  // entered this Panel.
  //
  // The anchor IS the seed — `buildDragSubjects` always includes it — so the
  // guard covers only the defensive fallback above, whose head belongs to a
  // different clip than the one the offset was measured on.
  const grabOffsetUs =
    anchor.layerId === drag.layerId ? drag.grabOffsetUs : 0;
  const pointerUs =
    ((pointer.clientX - canvasRect.left) / pxPerSec) * 1_000_000;
  // Subtracted BEFORE the grid, never after: a head snapped to this
  // composition's lattice and then shifted by an off-lattice offset is off the
  // lattice, `applyMoveLayersToComposition` re-snaps it on the other side of the
  // commit, and the clip lands a frame from where the ghost drew it.
  const griddedUs = snapFrameRound(pointerUs - grabOffsetUs, fpsNum, fpsDen);
  // The subject's own `originalTStart` is a SOURCE-composition time, and it is
  // used as an algebraic pivot only: the helper's delta is measured from it and
  // added straight back, so it cancels and every surviving number is this
  // composition's. What the subject genuinely contributes is the set's phase and
  // each clip's duration, which are the same in any composition.
  const snappedDeltaUs = snapDragDeltaToTimelineBoundary({
    state: {
      kind: "move",
      layerId: anchor.layerId,
      originalTStart: anchor.originalTStart,
      originalTEnd: anchor.originalTEnd,
      // Nothing here to exclude either way: the ignore set removes the dragged
      // clip and its link members from the target list, and none of them is in
      // this composition to be offered as a target in the first place.
      escapeLink: true,
    },
    frameDeltaUs: griddedUs - anchor.originalTStart,
    visibleTracks: opts.snapTracks,
    links: opts.links,
    linkByLayerId: opts.linkByLayerId,
    // This Panel's own playhead: the same root moment projected onto this
    // composition's clock (ADR 0053 decision 2), which is where its line is drawn.
    currentTimeUs: playheadClockUs(compositionId),
    fpsNum,
    fpsDen,
    pxPerSec,
    enabled: opts.tailSnapEnabled,
    strengthPx: opts.tailSnapStrengthPx,
  });
  // Composition time has no negative half, and the set stops as ONE body when
  // it reaches zero: the delta is floored at whatever would put the EARLIEST
  // member on zero, rather than each member being clamped where it lands.
  //
  // Clamping per member would flatten the set's phase against the boundary, and
  // worse, it would draw a landing the commit refuses — `applyMoveLayers-
  // ToComposition` refuses a member before zero outright and never clamps, on
  // the grounds that sliding a set off the picture it was placed against is not
  // a repair. Flooring here keeps that refusal unreachable by this gesture, the
  // way naming the earliest member as anchor keeps it unreachable from the menu.
  const movers = shiftMembersOf(drag.subjects);
  const phaseDeltaUs = floorShiftAtZero(movers, snappedDeltaUs);
  // Every block THIS Panel draws, on this composition's rate — the same
  // arithmetic `applyMoveLayersToComposition` runs on the other side of the
  // commit (`renderer/grid.ts`), which is what makes the ghost a promise rather
  // than an approximation of one.
  const landings = shiftOnGrids(movers, phaseDeltaUs, { num: fpsNum, den: fpsDen });
  // The command derives its own offset as `anchorTStartUs - anchor.t_start_us`,
  // so the number sent is the RAW shifted head, not the snapped one: sending the
  // snapped head would hand the command a different offset from the one every
  // block above was drawn with, and the set's phase would land off its preview.
  const anchorTStartUs = anchor.originalTStart + phaseDeltaUs;

  const rows: MeasuredTrackRow[] = [];
  const rowRects = new Map<string, { top: number; height: number }>();
  for (const { track } of opts.orderedTracks) {
    const el = opts.laneEls.current.get(track.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    rows.push({ trackId: track.id, top: rect.top, bottom: rect.bottom });
    rowRects.set(track.id, { top: rect.top, height: rect.height });
  }
  // The strip joins the SAME row list the lanes are in, so the seam between it
  // and the topmost lane is decided by the one band rule — the arrangement
  // `destinationUnderPointer` already relies on.
  const stripEl = opts.dropStripEl.current;
  if (stripEl) {
    const rect = stripEl.getBoundingClientRect();
    rows.push({ trackId: SPAWN_TRACK_ID, top: rect.top, bottom: rect.bottom });
    rowRects.set(SPAWN_TRACK_ID, { top: rect.top, height: rect.height });
  }
  const trackId = trackIdAtClientY(rows, pointer.clientY);

  if (trackId === null) {
    // Inside the Panel, over no row — its ruler, or the band under the last
    // lane. There is no geometry to draw in and no lane to validate against,
    // but the time is resolved and real, so the claim still carries it and the
    // drop strip stays armed while the pointer wanders across the Panel.
    //
    // A REFUSAL rather than `"valid"`, and so a release here sends nothing:
    // the ghost drew nothing at this point, and "a refused preview sends
    // nothing" is the same rule as "no preview, no commit". The command's
    // lane-less policy BOUNCES onto a free lane, which is honest for the menu
    // that has no ghost and a lie for a gesture that showed the user nothing.
    // `PlacementValidity` has no word for "no row at all", so this takes the
    // one that means a release places nothing; no chrome reads it, there being
    // no band to draw.
    return {
      trackId: null,
      anchorTStartUs,
      validity: "collision",
      band: null,
      blocks: [],
      drop: null,
    };
  }

  // Every subject lands on the ONE hit lane: `applyMoveLayersToComposition` with
  // a named destination puts every source block there, whatever lane it came
  // from (`main/state/mutations/moveToComposition.ts`). A ghost that scattered
  // them across rows would promise a landing the command cannot make.
  const blocks: GhostBlock[] = drag.subjects.map((subject) => {
    // No clamp: the floor above already guarantees every member is at or past
    // zero, so the set's mutual geometry survives the boundary intact.
    const landed = landings.get(subject.layerId)!;
    return { subject, tStartUs: landed.tStartUs, tEndUs: landed.tEndUs };
  });
  const placements: TimelinePlacement[] = blocks.map((block) => ({
    layerId: block.subject.layerId,
    trackId,
    tStartUs: block.tStartUs,
    tEndUs: block.tEndUs,
    overlapClass: overlapClassForKind(block.subject.kind),
    // Both locks refuse, exactly as the in-composition projection has them do:
    // the destination lane's, which `evaluateTimelinePlacements` reads off this
    // composition's own tracks, and the subject's own, which travelled on the
    // subject because this Panel holds no summary to find it in.
    locked: block.subject.locked,
  }));
  const evaluation = evaluateTimelinePlacements({
    tracks: opts.tracks,
    placements,
    // EMPTY, unlike the in-composition move: the subjects do not live here, so
    // none of this composition's intervals is being vacated by the drop. Listing
    // them would only be a way to silence a real collision.
    replacedLayerIds: new Set(),
  });

  // The ROW decides the band, not this file and not which Panel the gesture came
  // from — `dragGhostBand` is the rule, and the raise's own ghost reads it too,
  // so a clip carried in from next door and one raised at home draw the same box
  // on the same row.
  const rowRect = rowRects.get(trackId);
  let band: ForeignLanding["band"] = null;
  if (rowRect !== undefined) {
    const slice = dragGhostBand(rowRect.height, trackId);
    band = {
      top: rowRect.top - canvasRect.top + slice.top,
      height: slice.height,
    };
  }
  return {
    trackId,
    anchorTStartUs,
    validity: evaluation.validity,
    band,
    blocks,
    drop: committableDrop(
      drag,
      anchor,
      compositionId,
      trackId,
      anchorTStartUs,
      evaluation.validity,
    ),
  };
}

/**
 * Draws the incoming clips where they would land, claims the drop, and commits
 * it on release.
 *
 * Mounted inside `timeline-canvas` beside `MarqueeOverlay`, so it scrolls with
 * the content it is positioned against and inherits that container's z tier.
 *
 * LANDMINE: position with `left`/`top`/`width`/`height`, never `transform:
 * scale` — the error a scale introduces GROWS with the box on a fractional
 * device pixel ratio. `MarqueeOverlay` carries the full account.
 */
export function ForeignDragGhost(props: ForeignDragGhostProps): React.ReactNode {
  const { compositionId, pxPerSec } = props;
  // Two atomic selectors rather than one composite: a selector that built an
  // object would return a fresh reference on every store tick and loop
  // (feedback_zustand_composite_selector).
  const drag = useLayerDragStore((s) =>
    couldLandHere(s.drag, compositionId) ? s.drag : null,
  );
  const pointer = useLayerDragStore((s) =>
    couldLandHere(s.drag, compositionId) ? s.pointer : null,
  );
  const landing =
    drag !== null && pointer !== null
      ? resolveForeignDrop(props, drag, pointer)
      : null;

  // Broken into primitives so the effect re-runs on a CHANGED landing rather
  // than on every render — `landing` is rebuilt per pointer event by
  // construction.
  const claimTrackId = landing?.trackId ?? null;
  const claimAnchorUs = landing?.anchorTStartUs ?? null;
  const claimValidity = landing?.validity ?? null;
  useEffect(() => {
    if (compositionId === null) return;
    const { claimDropTarget, releaseDropTarget } = useLayerDragStore.getState();
    if (claimAnchorUs === null || claimValidity === null) {
      releaseDropTarget(compositionId);
      return;
    }
    claimDropTarget({
      compositionId,
      trackId: claimTrackId,
      anchorTStartUs: claimAnchorUs,
      validity: claimValidity,
    });
  }, [claimAnchorUs, claimTrackId, claimValidity, compositionId]);
  // Unmount is the one release the effect above cannot make: a Panel torn down
  // mid-gesture leaves module state behind, and the guard inside
  // `releaseDropTarget` is what stops it clearing a neighbour's claim.
  useEffect(() => {
    if (compositionId === null) return;
    return () => useLayerDragStore.getState().releaseDropTarget(compositionId);
  }, [compositionId]);

  const drop = landing?.drop ?? null;
  // LANDMINE: the release below reads THIS ref and never the store.
  //
  // Both Panels listen for `pointerup` on `window`, and the HOST's listener was
  // registered when the gesture armed, so it runs first — and the first thing
  // it does is `end()`, which clears `drag`, `pointer` AND `claim`. A handler
  // that read the store instead would find nothing, commit nothing, and say
  // nothing: every ghost would still look right and no test would look wrong.
  // Keep the resolved drop here, where the release cannot lose it.
  const dropRef = useRef<ResolvedDrop | null>(null);
  useEffect(() => {
    dropRef.current = drop;
  });

  // Always mounted, never gated on holding a landing. Gating it would be the
  // tidier shape, but it would make the commit depend on React NOT running this
  // effect's cleanup between the host's `end()` and this listener firing — both
  // happen inside one event dispatch, and a scheduling detail is a poor thing
  // for a commit to rest on. `dropRef` already carries the whole refusal: a
  // collision, a locked lane and a pointer over no row all leave it null, so
  // "a refused preview sends nothing" stays structural either way.
  useEffect(() => {
    const release = (e: PointerEvent): void => {
      const pending = dropRef.current;
      if (pending === null) return;
      // Re-asked from the RELEASE's own coordinates, not the last pointermove's.
      // The host decides with the same function on the same event, so exactly
      // one Panel acts: a pointer that left for somewhere else between the last
      // move and the lift would otherwise be committed BY BOTH — this Panel
      // against a position the pointer no longer holds, and the host as an
      // ordinary in-composition move.
      const under = foreignCompositionAtPoint(
        pending.fromCompositionId,
        e.clientX,
        e.clientY,
      );
      if (under !== pending.toCompositionId) return;
      void commitForeignDrop(pending);
    };
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  }, []);

  // One condition spelled twice: `resolveForeignDrop` returns a null band and a
  // null row together — over no row there is nothing to draw and nothing to draw
  // it in — and naming both is what lets the ghost below take a row id rather
  // than an assertion.
  if (landing === null || landing.band === null || landing.trackId === null) {
    return null;
  }
  const band = landing.band;
  const trackId = landing.trackId;

  return (
    <>
      {landing.blocks.map((block) => (
        <DragGhostChip
          key={block.subject.layerId}
          testId="timeline-foreign-ghost"
          layerId={block.subject.layerId}
          trackId={trackId}
          name={block.subject.name}
          kind={block.subject.kind}
          tStartUs={block.tStartUs}
          tEndUs={block.tEndUs}
          validity={landing.validity}
          pxPerSec={pxPerSec}
          fpsNum={props.fpsNum}
          fpsDen={props.fpsDen}
          top={band.top}
          height={band.height}
        />
      ))}
    </>
  );
}
