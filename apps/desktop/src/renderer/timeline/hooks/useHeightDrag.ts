import { useCallback, useState } from "react";
import { usePointerGesture } from "../../hooks/usePointerGesture";
import {
  DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  clamp,
} from "../geometry";

interface HeightDragState {
  trackId: string;
  startY: number;
  startHeight: number;
}

/// Track-height resize drag: pointerdown on a lane's resize handle
/// starts the drag; window-level pointermove/pointerup listeners track
/// it until release.
export function useHeightDrag(opts: {
  trackHeightsRef: React.MutableRefObject<Record<string, number>>;
  setTrackHeights: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}): {
  heightDrag: { trackId: string; startY: number; startHeight: number } | null;
  beginHeightDrag: (trackId: string) => (e: React.PointerEvent) => void;
} {
  const { trackHeightsRef, setTrackHeights } = opts;
  const [heightDrag, setHeightDrag] = useState<HeightDragState | null>(null);
  const beginGesture = usePointerGesture();

  // -------- Track-height drag --------

  const beginHeightDrag = useCallback(
    (trackId: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // A height drag must not also start the lane's selection marquee.
      e.stopPropagation();
      e.preventDefault();
      const current =
        trackHeightsRef.current[trackId] ?? DEFAULT_TRACK_HEIGHT;
      const startY = e.clientY;
      const previous = trackHeightsRef.current[trackId];
      beginGesture(e.pointerId, {
        move: (event) => {
          const next = clamp(Math.round(current + event.clientY - startY), MIN_TRACK_HEIGHT, MAX_TRACK_HEIGHT);
          setTrackHeights((prev) => prev[trackId] === next ? prev : { ...prev, [trackId]: next });
        },
        release: () => setHeightDrag(null),
        cancel: () => {
          setHeightDrag(null);
          setTrackHeights((prev) => {
            const next = { ...prev };
            if (previous === undefined) delete next[trackId];
            else next[trackId] = previous;
            return next;
          });
        },
      });
      setHeightDrag({ trackId, startY, startHeight: current });
    },
    [trackHeightsRef, setTrackHeights, beginGesture],
  );

  return { heightDrag, beginHeightDrag };
}
