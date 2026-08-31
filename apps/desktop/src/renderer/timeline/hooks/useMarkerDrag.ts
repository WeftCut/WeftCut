import { useCallback, useEffect, useRef, useState } from "react";
import { moveMarker, type LinkSummary, type TrackSummary } from "../../ipc";
import { snapFrameRound } from "../../frames";
import { tryMutate } from "../../errors/tryMutate";
import { playheadClockUs } from "../../state/playheadProjection";
import { compositionOrRoot, useProjectStore } from "../../state/projectStore";
import { useAppSettingsStore } from "../../settings/appSettingsStore";
import { indexLinks } from "../geometry";
import {
  clampMarkerTimeUs,
  markerDragBoundsUs,
  type MarkerDragBoundsUs,
} from "../markerAtFrame";
import { snapTimeToTimelineBoundary } from "../snapping";

const US_PER_SEC = 1_000_000;

/// Everything the gesture needs, read ONCE at the press. Nothing in here can
/// change while a pointer is down — no other mutation runs during a drag — so
/// re-reading it per move would buy nothing and cost a store read per event.
/// The playhead is the exception and stays out: it keeps moving under a drag
/// during playback, so it is read per move, exactly as the layer drag reads it.
export interface MarkerDragContext {
  markerId: string;
  /// Where the mark sat when the press landed. Every previewed time is this plus
  /// the pointer's TOTAL travel, never an accumulation of per-move deltas, which
  /// is what keeps the glyph under the cursor after a clamp has held it still.
  originalTUs: number;
  /// A region's end at the press, or `null` for a point. A region drags WHOLE.
  originalEndTUs: number | null;
  /// Anchored markers commit differently: the reconcile carries their region's
  /// end, so the commit must not send one (`moveMarker`).
  anchored: boolean;
  startClientX: number;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  bounds: MarkerDragBoundsUs;
  snap: {
    visibleTracks: readonly TrackSummary[];
    links: readonly LinkSummary[];
    linkByLayerId: ReadonlyMap<string, string>;
    enabled: boolean;
    strengthPx: number;
  };
}

/// What the lane paints instead of the marker's stored time while a drag is in
/// flight.
export interface MarkerDragPreview {
  markerId: string;
  tUs: number;
}

/// Where a marker drag lands, for a pointer that has travelled `deltaUs` of
/// timeline time from the press.
///
/// Three rules in order, and the order is the point. The composition FRAME GRID
/// first, so no preview ever sits on a time the commit cannot make. Then the
/// existing snap targets — clip edges and the playhead, which is what Premiere
/// and Resolve snap a marker to — offered only where the marker may actually
/// land, or a target one frame past a clip's end would pull the glyph off its
/// own clip for the clamp to drag back. Then the clamp, which is what a raw drag
/// past an edge runs into.
export function markerDragTimeUs(
  ctx: MarkerDragContext,
  deltaUs: number,
  currentTimeUs: number,
): number {
  const desiredUs = snapFrameRound(
    Math.max(0, ctx.originalTUs + deltaUs),
    ctx.fpsNum,
    ctx.fpsDen,
  );
  const snappedUs = snapTimeToTimelineBoundary({
    ...ctx.snap,
    timeUs: desiredUs,
    currentTimeUs,
    fpsNum: ctx.fpsNum,
    fpsDen: ctx.fpsDen,
    pxPerSec: ctx.pxPerSec,
    isValidSnap: (boundaryUs) =>
      clampMarkerTimeUs(boundaryUs, ctx.bounds) === boundaryUs,
  });
  return clampMarkerTimeUs(snappedUs, ctx.bounds);
}

/// The marker whose id is `markerId`, frozen with the snap targets and the
/// bounds its drag lives under — or `null` when it cannot be dragged at all.
function freezeMarkerDrag(
  compositionId: string | null,
  markerId: string,
  startClientX: number,
  pxPerSec: number,
): MarkerDragContext | null {
  const composition = compositionOrRoot(
    useProjectStore.getState().summary,
    compositionId,
  );
  if (composition === null) return null;
  const marker = composition.markers.find((m) => m.id === markerId);
  if (marker === undefined) return null;
  const bounds = markerDragBoundsUs(composition, marker);
  if (bounds === null) return null;
  const settings = useAppSettingsStore.getState().settings;
  return {
    markerId,
    originalTUs: marker.t_us,
    originalEndTUs: marker.end_t_us,
    anchored: marker.anchor_layer !== null,
    startClientX,
    pxPerSec,
    fpsNum: composition.fps_num,
    fpsDen: composition.fps_den,
    bounds,
    snap: {
      // Every lane of the composition, not the Panel's DISPLAY-FILTERED set the
      // layer drag snaps against: the lane is handed no filter and an A/B-Roll
      // hidden clip's edge is still a real cut in the film.
      visibleTracks: composition.tracks,
      links: composition.links,
      linkByLayerId: indexLinks(composition.links),
      // The same preference the clip drag and the blade obey — markers get no
      // snap flag of their own.
      enabled: settings.tail_snap_enabled,
      strengthPx: settings.tail_snap_strength_px,
    },
  };
}

/// Drag a marker along its lane.
///
/// The gesture only exists HERE, and could not exist on the ruler: a left-press
/// on a ruler glyph would contest the scrub the ruler is the sole surface for,
/// while a press in this lane has exactly one meaning. Right-press keeps its
/// own: this hook ignores every button but the primary, so the marker menu is
/// untouched.
///
/// The drag state is REACT STATE, not a module store — the opposite of
/// `layerDragStore`, and for a reason that does not reach this row. That store
/// exists because nothing at event rate may live in React state above a leaf:
/// one `useState` on the timeline root re-renders every lane, sub-lane and chip
/// per pointermove. The marker lane is ONE short row holding at most a windowful
/// of glyphs, and it is the only surface that paints markers, so a re-render per
/// move costs that row and nothing else.
export function useMarkerDrag(opts: {
  /// The composition the lane belongs to — the axis every time here is on.
  compositionId: string | null;
  pxPerSec: number;
}): {
  preview: MarkerDragPreview | null;
  beginMarkerDrag: (markerId: string) => (e: React.PointerEvent) => void;
} {
  const { compositionId, pxPerSec } = opts;
  // The frozen half of the gesture. A ref because no reader renders from it and
  // the pointer handlers must see the CURRENT one, not the one their closure was
  // built around.
  const contextRef = useRef<MarkerDragContext | null>(null);
  // Mounts the window listeners, and nothing else — flipped exactly twice per
  // gesture, so it is not an event-rate write.
  const [active, setActive] = useState(false);
  const [preview, setPreview] = useState<MarkerDragPreview | null>(null);

  const beginMarkerDrag = useCallback(
    (markerId: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // The lane stops every press anyway; this one also has to beat the text
      // selection and native image drag the browser would start from a glyph.
      e.stopPropagation();
      e.preventDefault();
      const ctx = freezeMarkerDrag(compositionId, markerId, e.clientX, pxPerSec);
      if (ctx === null) return;
      contextRef.current = ctx;
      setActive(true);
      setPreview({ markerId, tUs: ctx.originalTUs });
    },
    [compositionId, pxPerSec],
  );

  // A Panel torn down mid-gesture leaves no drag behind.
  useEffect(() => {
    return () => {
      contextRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const landingUs = (clientX: number): number | null => {
      const ctx = contextRef.current;
      if (ctx === null) return null;
      const deltaUs =
        ((clientX - ctx.startClientX) / ctx.pxPerSec) * US_PER_SEC;
      // Event-time read: the playhead is a snap TARGET, and playback moves it
      // while the pointer is down.
      return markerDragTimeUs(ctx, deltaUs, playheadClockUs(compositionId));
    };
    const onMove = (e: PointerEvent) => {
      const tUs = landingUs(e.clientX);
      if (tUs === null) return;
      setPreview((p) => (p === null || p.tUs === tUs ? p : { ...p, tUs }));
    };
    const onUp = (e: PointerEvent) => {
      const ctx = contextRef.current;
      const tUs = landingUs(e.clientX);
      contextRef.current = null;
      setActive(false);
      if (ctx === null || tUs === null) {
        setPreview(null);
        return;
      }
      // A drag that lands where it started is not an edit. No channel call, so
      // no history entry standing between the user and their last real one.
      if (tUs === ctx.originalTUs) {
        setPreview(null);
        return;
      }
      setPreview({ markerId: ctx.markerId, tUs });
      // ONE patch for the whole gesture, at release — the moves previewed
      // locally and lowered nothing. The preview is held until the commit lands
      // rather than dropped here, or the glyph would paint one frame back at its
      // old time before the refreshed project arrives.
      void tryMutate(
        () =>
          moveMarker(
            ctx.markerId,
            tUs,
            ctx.anchored || ctx.originalEndTUs === null
              ? null
              : ctx.originalEndTUs + (tUs - ctx.originalTUs),
          ),
        "move_marker",
      ).then(() =>
        // A press that landed while the commit was in flight owns the preview
        // now; clearing unconditionally would blank that glyph mid-gesture.
        setPreview((p) => (contextRef.current === null ? null : p)),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [active, compositionId]);

  return { preview, beginMarkerDrag };
}
