// The ONE keyframe drag. Every diamond in the timeline — the collapsed in-clip
// row and the expanded curve graph's dots — arms this, so a gesture started on
// either surface moves the whole selection under one set of rules and lands as
// one undo entry.
//
// LANDMINE: it must not go back to a per-surface retime. Each surface owning
// its own drag meant the gesture could only ever move the key under the
// pointer, and a selection spanning layers had no gesture at all; worse, two
// surfaces drawing the same track disagreed about what was in flight, because
// neither published a preview the other could read.
//
// What the drag decides is time only. The shape a key carries rides along
// untouched — normalized tangents make a time-scale shape-preserving for free —
// and the arithmetic itself is `batchRetime.ts`; this measures, and
// `KeyframeBatch.commitEntries` writes.
import { useCallback } from "react";
import { layerIsReadOnly } from "../state/layerEditability";
import { setKeyframeFocus } from "./focusStore";
import { usePointerGesture } from "../hooks/usePointerGesture";

import {
  clearTrackPreview,
  setTrackPreviews,
} from "./easingPreviewStore";
import {
  retimeGroupsOf,
  scaleSelection,
  selectionExtent,
  translateSelection,
} from "./batchRetime";
import {
  getSelectedKeyframes,
  keyframeKey,
  selectKeyframe,
  useKeyframeSelectionStore,
} from "./selectionStore";
import { useKeyframeOps, type ParamTrackEntry } from "../timeline/keyframeBatch";

export interface KeyframeDragStart {
  layerId: string;
  paramKey: string;
  kfId: string;
  /// Where the pointer went down, and the pixels-per-second the surface draws
  /// at — the two numbers that turn travel into time.
  clientX: number;
  clientY: number;
  pointerId: number;
  pxPerSec: number;
  /// `Alt` AT POINTERDOWN arms the time-scale. Read once and never again: a
  /// modifier picked up or dropped mid-drag would change what the gesture means
  /// halfway through it, and the anchor is already fixed by then.
  altKey: boolean;
  /// Navigation is only legal after a release that never became a drag.
  /// Selection and focus happen on press; neither moves the transport.
  onClick?: () => void;
}

/// Arms a drag from a diamond's pointerdown. Pressing a key OUTSIDE the
/// selection replaces the selection with it first, so the gesture always moves
/// what the user can see is selected; pressing one INSIDE keeps the selection,
/// which is what makes a swept group draggable at all.
export function useKeyframeDrag(): (start: KeyframeDragStart) => void {
  const ops = useKeyframeOps();
  const beginGesture = usePointerGesture();
  return useCallback(
    (start: KeyframeDragStart) => {
      if (start.pxPerSec <= 0) return;
      const key = { layerId: start.layerId, paramKey: start.paramKey, kfId: start.kfId };
      if (!useKeyframeSelectionStore.getState().selected.has(keyframeKey(key))) {
        selectKeyframe(key);
      }
      setKeyframeFocus(start.layerId, start.paramKey);

      const groups = retimeGroupsOf({
        selected: getSelectedKeyframes(),
        tracks: ops.tracks,
      });
      if (groups.some(group => layerIsReadOnly(ops.tracks, group.layerId))) return;
      const hitGroup = groups.find(
        (g) => g.layerId === start.layerId && g.paramKey === start.paramKey,
      );
      const hit = hitGroup?.track.value.find((k) => k.id === start.kfId);
      const hitUs = hitGroup && hit ? hitGroup.tStartUs + hit.t_us : null;
      // Alt on an END key is the time-scale, and the opposite end is its
      // anchor: grabbing anything between the ends names no anchor and stays a
      // translate, as does a selection with no span to scale.
      const extent = selectionExtent(groups);
      let anchorUs: number | null = null;
      if (hitUs !== null && start.altKey && extent !== null && extent.distinct >= 2) {
        if (hitUs === extent.firstUs) anchorUs = extent.lastUs;
        else if (hitUs === extent.lastUs) anchorUs = extent.firstUs;
      }

      let entries: readonly ParamTrackEntry[] = [];
      let drew = false;
      // Latched: dragging away and back (or into a clamp) is still a drag.
      let dragged = false;
      const draw = (next: readonly ParamTrackEntry[]) => {
        entries = next;
        drew = true;
        // A drag that has come back to zero previews the COMMITTED tracks
        // rather than clearing: clearing would let the committed picture back
        // in one frame at a time as each surface re-subscribed.
        setTrackPreviews(
          next.length > 0
            ? next
            : groups.map((g) => [g.layerId, g.paramKey, g.track] as const),
        );
      };

      const onMove = (ev: PointerEvent) => {
        dragged ||= Math.hypot(ev.clientX - start.clientX, ev.clientY - start.clientY) >= 3;
        if (!dragged || hitUs === null) return;
        const dxUs = ((ev.clientX - start.clientX) / start.pxPerSec) * 1_000_000;
        if (anchorUs === null) {
          draw(translateSelection(groups, dxUs, ops.fps).entries);
          return;
        }
        // The grabbed end follows the pointer; the factor is what that does to
        // the span. `hitUs !== anchorUs` holds because the two are the extent's
        // distinct ends.
        const k = (hitUs + dxUs - anchorUs) / (hitUs - anchorUs);
        draw(scaleSelection(groups, anchorUs, k, ops.fps).entries);
      };

      const teardown = () => {
        // Scoped to the groups this gesture set, and skipped entirely when it
        // set none: a press that never moved must not clear a preview it did
        // not put there — an armed menu row's, say.
        if (drew) for (const g of groups) clearTrackPreview(g.layerId, g.paramKey);
      };
      /// Escape — and an abort, which is not a release either — leaves the
      /// committed times exactly as the press found them.
      /// A release commits whatever the last move computed. Nothing moved (the
      /// pointer never travelled a whole frame, or the walls held) means no
      /// entries, and no entries means no undo row for a gesture that did
      /// nothing.
      const release = (ev: PointerEvent) => {
        // Release can carry the last movement even without a pointermove.
        onMove(ev);
        teardown();
        if (!dragged) start.onClick?.();
        else if (entries.length > 0) ops.commitEntries(entries);
      };
      beginGesture(start.pointerId, { move: onMove, release, cancel: teardown });
    },
    [ops, beginGesture],
  );
}
