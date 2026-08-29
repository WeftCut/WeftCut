// The destination half of a cross-Panel clip drag: one per timeline Panel, it
// hit-tests the pointer against itself, resolves the landing in THIS
// composition's units, publishes the claim, and draws the preview.
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
// What this does NOT own: the gesture, its refusal, and the commit. The host
// keeps freezing its own ghost and saying why (`crossCompositionRefusal.ts`),
// and releasing over this Panel still sends nothing.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { LinkSummary, TrackSummary } from "../ipc";
import { snapFrameRound } from "../frames";
import { playheadClockUs } from "../state/playheadProjection";
import {
  layerSliceRect,
  overlapClassForKind,
  trackIdAtClientY,
  type MeasuredTrackRow,
  type VisualTrack,
} from "./geometry";
import { timelineLayerTheme } from "./layerTheme";
import {
  useLayerDragStore,
  type DragState,
  type DragSubject,
} from "./layerDragStore";
import {
  evaluateTimelinePlacements,
  placementRefuses,
  SPAWN_TRACK_ID,
  type PlacementValidity,
  type TimelinePlacement,
} from "./placement";
import { snapDragDeltaToTimelineBoundary } from "./snapping";
import { foreignCompositionAtPoint } from "./timelineSurfaces";

/// The colour hint handed to `timelineLayerTheme`, which only consults one for a
/// `Color` layer. A foreign ghost is deliberately not a mirror of the clip — no
/// filmstrip, no waveform, no link chrome, no transition chip, because none of
/// those answer a question the drop asks — so it does not carry the fill either,
/// and `DragSubject` has no third field to carry it in. Every kind therefore
/// reads as its type colour, and `Color` reads as the neutral this names.
const GHOST_NEUTRAL_SURFACE = "#22262b";

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

interface ForeignLanding {
  trackId: string | null;
  anchorTStartUs: number;
  validity: PlacementValidity;
  /// The row's chip band, in `timeline-canvas` coordinates. Null when the
  /// pointer is inside this Panel but over no row, which is also when `blocks`
  /// is empty — there is no lane to draw in.
  band: { top: number; height: number } | null;
  blocks: GhostBlock[];
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

  // The anchor's HEAD lands under the pointer. The grab offset — where inside
  // the clip the user took hold — is deliberately not carried across: it is a px
  // quantity measured at the source Panel's zoom, so re-applying it here would
  // name an arbitrary time on a Panel that does not share that zoom.
  const pointerUs =
    ((pointer.clientX - canvasRect.left) / pxPerSec) * 1_000_000;
  const griddedUs = snapFrameRound(pointerUs, fpsNum, fpsDen);
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
  const earliestStartUs = Math.min(
    ...drag.subjects.map((subject) => subject.originalTStart),
  );
  const phaseDeltaUs = Math.max(snappedDeltaUs, -earliestStartUs);
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
    // lane. There is no geometry to draw in and nothing to validate against, but
    // the time is resolved and real, so the claim still carries it. `"valid"`
    // is honest for a lane-less destination: with no lane named, the move's
    // lane policy bounces onto a free one rather than refusing, so there is
    // nothing here for a verdict to refuse.
    return {
      trackId: null,
      anchorTStartUs,
      validity: "valid",
      band: null,
      blocks: [],
    };
  }

  // Every subject lands on the ONE hit lane: `applyMoveLayersToComposition` with
  // a named destination puts every source block there, whatever lane it came
  // from (`main/state/mutations/moveToComposition.ts`). A ghost that scattered
  // them across rows would promise a landing the command cannot make.
  const blocks: GhostBlock[] = drag.subjects.map((subject) => {
    // No clamp: the floor above already guarantees every member is at or past
    // zero, so the set's mutual geometry survives the boundary intact.
    const tStartUs = subject.originalTStart + phaseDeltaUs;
    return {
      subject,
      tStartUs,
      tEndUs: tStartUs + (subject.originalTEnd - subject.originalTStart),
    };
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

  // The chip band, not the whole row: `layerSliceRect` is where the padding a
  // clip sits inside is defined, so the ghost occupies the band a real chip
  // would rather than one this file measures out for itself.
  const rowRect = rowRects.get(trackId);
  let band: ForeignLanding["band"] = null;
  if (rowRect !== undefined) {
    const slice = layerSliceRect(rowRect.height, "full");
    band = {
      top: rowRect.top - canvasRect.top + slice.top,
      height: slice.height,
    };
  }
  return { trackId, anchorTStartUs, validity: evaluation.validity, band, blocks };
}

/**
 * Draws the incoming clips where they would land, and claims the drop.
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
  const { t } = useTranslation();
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

  if (landing === null || landing.band === null) return null;
  const band = landing.band;
  // Not `!== "valid"`: over the drop strip the verdict is `"spawn"`, a
  // destination being created rather than a refusal (ADR 0042).
  const refused = placementRefuses(landing.validity);
  const refusalLabel =
    landing.validity === "collision"
      ? t("timeline.drop_collision", { defaultValue: "Overlap" })
      : landing.validity === "locked"
        ? t("timeline.drop_locked", { defaultValue: "Locked" })
        : null;

  return (
    <>
      {landing.blocks.map((block) => {
        const theme = timelineLayerTheme(
          block.subject.kind,
          GHOST_NEUTRAL_SURFACE,
        );
        return (
          <div
            key={block.subject.layerId}
            data-testid="timeline-foreign-ghost"
            data-layer-id={block.subject.layerId}
            data-track-id={landing.trackId}
            data-validity={landing.validity}
            data-start-us={block.tStartUs}
            data-end-us={block.tEndUs}
            aria-hidden="true"
            className="pointer-events-none absolute z-[5] flex items-center gap-1 overflow-hidden rounded border border-white/25 px-2 text-[10px] font-semibold text-white shadow-[0_4px_10px_rgba(0,0,0,0.45)]"
            style={{
              left: (block.tStartUs / 1_000_000) * pxPerSec,
              top: band.top,
              // THIS Panel's zoom. Recomputing the width is the difference
              // between showing a duration and lying about one — the source
              // Panel's px/sec would draw the same clip a different length here.
              width: Math.max(
                4,
                ((block.tEndUs - block.tStartUs) / 1_000_000) * pxPerSec,
              ),
              height: band.height,
              backgroundColor: theme.surface,
              opacity: 0.85,
              // The same red / amber the in-composition ghost wears, so one
              // vocabulary covers both halves of the gesture.
              borderColor:
                landing.validity === "collision"
                  ? "rgb(252 165 165)"
                  : landing.validity === "locked"
                    ? "rgb(252 211 77)"
                    : undefined,
              outline:
                landing.validity === "collision"
                  ? "2px solid rgb(248 113 113)"
                  : landing.validity === "locked"
                    ? "2px solid rgb(251 191 36)"
                    : undefined,
              outlineOffset: refused ? -2 : undefined,
            }}
          >
            <span className="min-w-0 truncate">{block.subject.name}</span>
            {refusalLabel !== null && (
              <span className="ml-auto shrink-0 rounded bg-black/35 px-1 py-0.5">
                {refusalLabel}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
