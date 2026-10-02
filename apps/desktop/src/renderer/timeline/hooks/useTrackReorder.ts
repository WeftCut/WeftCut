import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { moveTrack, type TrackSummary } from "../../ipc";
import { tryMutate } from "../../errors/tryMutate";
import { usePointerReorder } from "../../hooks/usePointerReorder";
import { canReorderTrack, revealTrackRow, trackPositionAtGap, trackPositionForMove, type TrackMove } from "../trackReorder";

export function useTrackReorder({ tracks, enabled, viewportRef, revealedTrackId, onMutated }: {
  tracks: readonly TrackSummary[];
  enabled: boolean;
  viewportRef: RefObject<HTMLElement | null>;
  revealedTrackId?: string | null | undefined;
  onMutated: () => Promise<void>;
}) {
  const ids = tracks.map((track) => track.id);
  const rows = useRef(new Map<string, HTMLElement>());
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const busy = useRef(false);
  const live = useRef({ tracks, enabled, ids });
  live.current = { tracks, enabled, ids };

  useEffect(() => {
    if (enabled && revealedTrackId) setPendingReveal(revealedTrackId);
  }, [enabled, revealedTrackId]);
  useLayoutEffect(() => {
    if (!enabled || !pendingReveal) return;
    const row = rows.current.get(pendingReveal);
    if (!row || !viewportRef.current) return;
    revealTrackRow(viewportRef.current, row);
    setPendingReveal(null);
  }, [enabled, pendingReveal, tracks, viewportRef]);

  const commit = async (id: string, position: number | null) => {
    const current = live.current;
    const track = current.tracks.find((entry) => entry.id === id);
    if (busy.current || !current.enabled || !track || !canReorderTrack(track) || position === null) return;
    busy.current = true;
    try {
      if (await tryMutate(() => moveTrack(id, position), "Move track")) {
        await onMutated();
        setPendingReveal(id);
      }
    } finally {
      busy.current = false;
    }
  };
  const reorder = usePointerReorder({
    rowIds: ids,
    enabled,
    cancelKey: ids.join("|"),
    onDrop: ({ id, gap }) => {
      // A summary update during the gesture must never reinterpret its gaps.
      if (ids.join("|") !== live.current.ids.join("|")) return;
      void commit(id, trackPositionAtGap(ids, id, gap));
    },
  });
  return {
    ...reorder,
    setRow: (id: string, index: number, el: HTMLElement | null) => {
      if (el) rows.current.set(id, el);
      else rows.current.delete(id);
      reorder.setRowEl(index, el);
    },
    move: (id: string, move: TrackMove) => commit(id, trackPositionForMove(live.current.ids, id, move)),
    reveal: setPendingReveal,
  };
}
