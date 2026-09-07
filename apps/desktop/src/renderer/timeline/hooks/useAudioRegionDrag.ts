// The two gestures that write a noise-profile sample region: the one-shot drag
// on an armed clip that paints both bounds, and an edge handle that moves one.
// Both land as ONE `update_layer_param_tracks`, so a region is one undo step —
// the same commit the inspector row makes (`properties/AudioRegionRow.tsx`).
// See ADR 0063 and docs/audio.md § Clip effects.
//
// Boundary: the gesture and its commit, nothing else. The arm lives in
// `../audioRegionArmStore`, the arithmetic in `../audioRegionGeometry`, the
// drawing in `../AudioRegionBand.tsx`; the audio catalog is never imported here
// — both param keys and the minimum span arrive with the arm payload or the
// handle's context.

import { useCallback, useEffect, useRef, useState } from "react";

import { tryMutate } from "../../errors/tryMutate";
import { updateLayerParamTracks, type AnimTrack } from "../../ipc";
import { useProjectStore } from "../../state/projectStore";
import { armedRegionSelect, disarmRegionSelect } from "../audioRegionArmStore";
import {
  compUsFromPx,
  resolveHandleDrag,
  resolveRegionDrag,
  sourceUsFromCompUs,
  type RegionBound,
  type RegionPxContext,
  type RegionSpan,
} from "../audioRegionGeometry";

const US_PER_SEC = 1_000_000;

/// What the clip knows about itself, read ONCE at the press: nothing here can
/// change while a pointer is down, and a re-read per move would cost a store
/// read per event for an identical answer.
export interface RegionDragContext {
  layerId: string;
  tStartUs: number;
  tEndUs: number;
  /// The clip's head in SOURCE time — the offset that turns a dragged
  /// composition time into the bound that gets stored (spec Decision 3).
  srcInUs: number;
  pxPerSec: number;
  /// The block's left edge in the same coordinates the press reports, which for
  /// a pointer event is the client rect's.
  blockLeftPx: number;
}

/// A handle drag knows its region as well as its clip: which effect owns the
/// bounds, the keys they are stored under, and where both of them sit now (in
/// COMPOSITION µs) — the moving one is the drag's origin, the other one is the
/// wall `minUs` is measured against.
export interface RegionHandleContext extends RegionDragContext {
  effectId: string;
  inKey: string;
  outKey: string;
  minUs: number;
  inUs: number;
  outUs: number;
}

/// What the band paints instead of the stored bounds while a gesture is in
/// flight — the press and the pointer for a region drag, both bounds for a
/// handle. In composition µs; the band resolves the pair the same way the
/// release does, so the preview is never a region the commit would not make.
export interface RegionDragPreview {
  t0Us: number;
  t1Us: number;
}

/// The press, narrowed to what the gesture reads: satisfied by React's
/// synthetic pointer event and by a DOM one, so the block's `pointerdown` and
/// the band's handles hand over whichever they hold.
export interface RegionPressEvent {
  button: number;
  clientX: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/// The clip half of a gesture, plus the effect it writes to.
interface RegionGestureBase {
  layerId: string;
  tStartUs: number;
  tEndUs: number;
  srcInUs: number;
  px: RegionPxContext;
  effectId: string;
  inKey: string;
  outKey: string;
  minUs: number;
}

type RegionGesture =
  | {
      kind: "region";
      base: RegionGestureBase;
      /// The anchor a too-short drag expands around, in composition µs.
      pressUs: number;
    }
  | {
      kind: "handle";
      base: RegionGestureBase;
      bound: RegionBound;
      originUs: number;
      otherUs: number;
      startClientX: number;
    };

/// The param path a region bound is stored under. The same one the inspector
/// row writes — the field and the drag must land on the same key or one of them
/// edits a bound nothing reads.
function paramKey(effectId: string, key: string): string {
  return `effects[${effectId}].params[${key}]`;
}

function staticUs(value: number): AnimTrack<number> {
  return { mode: "Static", value };
}

/// Composition µs of the end the pointer is carrying.
function landingUs(gesture: RegionGesture, clientX: number): number {
  if (gesture.kind === "region") return compUsFromPx(clientX, gesture.base.px);
  // The origin plus the pointer's TOTAL travel, never the raw position: a
  // handle grabbed off-centre would otherwise jump to the cursor, and after a
  // clamp has held the edge still the pointer coming back has to bring it
  // straight back.
  const pxPerSec = gesture.base.px.pxPerSec;
  const deltaUs =
    pxPerSec > 0 ? ((clientX - gesture.startClientX) / pxPerSec) * US_PER_SEC : 0;
  return gesture.originUs + deltaUs;
}

/// Where a handle's bound lands, and the region that results.
function handleSpan(
  gesture: Extract<RegionGesture, { kind: "handle" }>,
  clientX: number,
): { movedUs: number; span: RegionSpan } {
  const { base, bound, otherUs } = gesture;
  const movedUs = resolveHandleDrag({
    bound,
    newUs: landingUs(gesture, clientX),
    otherUs,
    tStartUs: base.tStartUs,
    tEndUs: base.tEndUs,
    minUs: base.minUs,
  });
  return {
    movedUs,
    span:
      bound === "in"
        ? { inUs: movedUs, outUs: otherUs }
        : { inUs: otherUs, outUs: movedUs },
  };
}

function previewFor(gesture: RegionGesture, clientX: number): RegionDragPreview {
  if (gesture.kind === "region") {
    return { t0Us: gesture.pressUs, t1Us: landingUs(gesture, clientX) };
  }
  const { span } = handleSpan(gesture, clientX);
  return { t0Us: span.inUs, t1Us: span.outUs };
}

/// Draw a sample region on a clip, or move one of its edges.
///
/// Instantiated per clip block, so the preview is React state rather than a
/// module store: only one clip can be under a region gesture and only that
/// block draws its band, so a re-render per pointermove costs that block and
/// nothing else — the reason `useMarkerDrag` keeps its preview local too, and
/// the opposite of `layerDragStore`, which exists because a clip MOVE repaints
/// every lane.
export function useAudioRegionDrag(): {
  preview: RegionDragPreview | null;
  /// The armed one-shot, for the block's `pointerdown`. Answers whether it took
  /// the press, so the block can fall through to select/move when it did not.
  startRegionDrag: (e: RegionPressEvent, ctx: RegionDragContext) => boolean;
  /// One edge handle of an already-drawn region.
  startHandleDrag: (
    e: RegionPressEvent,
    ctx: RegionHandleContext,
    bound: RegionBound,
  ) => boolean;
} {
  // The frozen half of the gesture. A ref because nothing renders from it and
  // the pointer handlers must see the CURRENT gesture, not the one their
  // closure was built around.
  const gestureRef = useRef<RegionGesture | null>(null);
  // Mounts the window listeners, and nothing else — flipped exactly twice per
  // gesture, so it is not an event-rate write.
  const [active, setActive] = useState(false);
  const [preview, setPreview] = useState<RegionDragPreview | null>(null);
  // Unsubscribe for the promise held between a commit and the summary that
  // carries it back; see the release path below.
  const holdRef = useRef<(() => void) | null>(null);

  const startRegionDrag = useCallback(
    (e: RegionPressEvent, ctx: RegionDragContext): boolean => {
      if (e.button !== 0) return false;
      // Read here rather than taken as an argument: the arm is this store's
      // fact, and a block that passed a stale copy would paint a region onto an
      // effect the card has since replaced.
      const armed = armedRegionSelect();
      if (armed === null || armed.layerId !== ctx.layerId) return false;
      e.stopPropagation();
      // Beats the text selection and native image drag the browser would
      // otherwise start from the clip's chrome.
      e.preventDefault();
      const px: RegionPxContext = {
        pxPerSec: ctx.pxPerSec,
        blockLeftPx: ctx.blockLeftPx,
        tStartUs: ctx.tStartUs,
      };
      const pressUs = compUsFromPx(e.clientX, px);
      gestureRef.current = {
        kind: "region",
        base: {
          layerId: ctx.layerId,
          tStartUs: ctx.tStartUs,
          tEndUs: ctx.tEndUs,
          srcInUs: ctx.srcInUs,
          px,
          effectId: armed.effectId,
          inKey: armed.inKey,
          outKey: armed.outKey,
          minUs: armed.minUs,
        },
        pressUs,
      };
      setActive(true);
      // A press with no travel is already a region — the shortest the filter can
      // learn from, centred on the anchor — so the band says so from the first
      // frame rather than appearing once the pointer has moved far enough.
      setPreview({ t0Us: pressUs, t1Us: pressUs });
      return true;
    },
    [],
  );

  const startHandleDrag = useCallback(
    (e: RegionPressEvent, ctx: RegionHandleContext, bound: RegionBound): boolean => {
      if (e.button !== 0) return false;
      // The handle sits INSIDE the clip block, whose own `pointerdown` would
      // otherwise select the clip and arm a move under the edge drag.
      e.stopPropagation();
      e.preventDefault();
      const px: RegionPxContext = {
        pxPerSec: ctx.pxPerSec,
        blockLeftPx: ctx.blockLeftPx,
        tStartUs: ctx.tStartUs,
      };
      gestureRef.current = {
        kind: "handle",
        base: {
          layerId: ctx.layerId,
          tStartUs: ctx.tStartUs,
          tEndUs: ctx.tEndUs,
          srcInUs: ctx.srcInUs,
          px,
          effectId: ctx.effectId,
          inKey: ctx.inKey,
          outKey: ctx.outKey,
          minUs: ctx.minUs,
        },
        bound,
        originUs: bound === "in" ? ctx.inUs : ctx.outUs,
        otherUs: bound === "in" ? ctx.outUs : ctx.inUs,
        startClientX: e.clientX,
      };
      setActive(true);
      setPreview({ t0Us: ctx.inUs, t1Us: ctx.outUs });
      return true;
    },
    [],
  );

  // A block torn down mid-gesture leaves neither a drag nor a subscription
  // behind.
  useEffect(() => {
    return () => {
      gestureRef.current = null;
      holdRef.current?.();
      holdRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => {
      const gesture = gestureRef.current;
      if (gesture === null) return;
      const next = previewFor(gesture, e.clientX);
      setPreview((p) =>
        p !== null && p.t0Us === next.t0Us && p.t1Us === next.t1Us ? p : next,
      );
    };
    const onUp = (e: PointerEvent) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      setActive(false);
      if (gesture === null) {
        setPreview(null);
        return;
      }
      const { base } = gesture;
      // The one-shot is spent by the GESTURE, not by the write: a refused
      // commit must not leave the timeline armed with a crosshair on one clip
      // and `not-allowed` everywhere else.
      if (gesture.kind === "region") disarmRegionSelect();
      const commit = releaseCommit(gesture, e.clientX);
      if (commit === null) {
        setPreview(null);
        return;
      }
      // Held rather than dropped: the band has to keep painting the region for
      // the round trip, or it would blank between the release and the refreshed
      // project.
      setPreview({ t0Us: commit.span.inUs, t1Us: commit.span.outUs });
      void tryMutate(
        () => updateLayerParamTracks(base.layerId, commit.entries),
        "Edit sample region",
      ).then((ok) => {
        holdRef.current?.();
        holdRef.current = null;
        // A press that landed while the commit was in flight owns the preview
        // now; clearing unconditionally would blank that band mid-gesture.
        const release = () => setPreview((p) => (gestureRef.current === null ? null : p));
        if (!ok) {
          release();
          return;
        }
        // The command returning means the ACTOR has the region; the summary
        // that brings it back arrives on the following `project:changed` round
        // trip, and that is the frame the band can stop promising.
        holdRef.current = useProjectStore.subscribe(() => {
          holdRef.current?.();
          holdRef.current = null;
          release();
        });
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [active]);

  return { preview, startRegionDrag, startHandleDrag };
}

/// What a release writes, or `null` when it writes nothing: a clip shorter than
/// the filter's minimum span, or a handle that came back to where it started —
/// neither is an edit, and a command call for either would stand between the
/// user and their last real undo step.
function releaseCommit(
  gesture: RegionGesture,
  clientX: number,
): { span: RegionSpan; entries: [string, AnimTrack<number>][] } | null {
  const { base } = gesture;
  const map = { tStartUs: base.tStartUs, srcInUs: base.srcInUs };
  if (gesture.kind === "region") {
    const span = resolveRegionDrag({
      pressUs: gesture.pressUs,
      releaseUs: landingUs(gesture, clientX),
      tStartUs: base.tStartUs,
      tEndUs: base.tEndUs,
      minUs: base.minUs,
    });
    if (span === null) return null;
    // BOTH bounds in one batch, as the inspector row commits them: a region is
    // one edit, so one Ctrl+Z takes the whole thing back rather than leaving a
    // half-written pair behind.
    return {
      span,
      entries: [
        [paramKey(base.effectId, base.inKey), staticUs(sourceUsFromCompUs(span.inUs, map))],
        [paramKey(base.effectId, base.outKey), staticUs(sourceUsFromCompUs(span.outUs, map))],
      ],
    };
  }
  const { movedUs, span } = handleSpan(gesture, clientX);
  if (movedUs === gesture.originUs) return null;
  const key = gesture.bound === "in" ? base.inKey : base.outKey;
  return {
    span,
    entries: [[paramKey(base.effectId, key), staticUs(sourceUsFromCompUs(movedUs, map))]],
  };
}
