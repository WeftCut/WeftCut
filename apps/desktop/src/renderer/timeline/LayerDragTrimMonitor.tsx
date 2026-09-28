// The monitor's half of a trim drag. Owns no gesture and no rule: it reads the
// published drag (`layerDragStore.ts`), decides which frame the boundary keeps,
// and drives the transport. Everything about how that boundary is computed —
// snapping, the causality gates, the commit — stays in `hooks/useLayerDrag.ts`.

import { useEffect, useRef } from "react";
import { boundaryDisplayFrameUs } from "../frames";
import { transportPause, transportPreviewSeek, transportSeek } from "../state/playbackStore";
import { setPlayheadTimeUs, playheadTimeUs } from "../state/playheadStore";
import { previewLocalUs } from "../state/playheadProjection";
import { useLayerDragStore } from "./layerDragStore";
import { constrainedAnchorUs } from "./hooks/useLayerDrag";

/// Drives the monitor while a trim drag in `compositionId`'s own Panel is live.
/// Renders nothing: it exists to be a LEAF subscriber of the drag store, so the
/// per-frame preview seek cannot re-render the timeline that hosts it — which is
/// the whole reason the gesture left React state (`layerDragStore.ts`).
///
/// The monitor shows the frame the dragged boundary KEEPS: the out side shows
/// the last kept frame (the traditional NLE tail-trim display — never the frame
/// past the cut), the in side the first. The playhead is not the preview cursor:
/// its position stays parked throughout the gesture. Only the monitor follows
/// the boundary, then returns to the parked moment when the gesture ends.
///
/// LANDMINE: the composition gate is not decoration. Every mounted Panel renders
/// one of these against one module-level store, and each holds its OWN `fpsNum`
/// / `fpsDen`. Ungated, a trim in one timeline makes every other timeline seek
/// the same drag quantized on a lattice it does not belong to, and the last one
/// to run wins the monitor (ADR 0053).
export function LayerDragTrimMonitor({
  compositionId,
  fpsNum,
  fpsDen,
}: {
  /// This Panel's composition — the axis `fpsNum` / `fpsDen` belong to.
  compositionId: string | null;
  fpsNum: number;
  fpsDen: number;
}): null {
  // A primitive selector, so a pointer wiggle inside one frame is not even a
  // render here, let alone a seek.
  const trimPreviewUs = useLayerDragStore((s) =>
    s.drag === null ||
    s.drag.kind === "move" ||
    s.drag.compositionId !== compositionId
      ? null
      : boundaryDisplayFrameUs(
          constrainedAnchorUs(s.drag, s.drag.deltaUs, fpsNum, fpsDen),
          s.drag.kind === "trim-end" ? "out" : "in",
          fpsNum,
          fpsDen,
        ),
  );
  const trimPreviewActive = trimPreviewUs !== null;
  const trimRestoreUsRef = useRef<number | null>(null);

  useEffect(() => {
    if (trimPreviewUs === null) return;
    if (trimRestoreUsRef.current === null) {
      // ROOT time, because that is what goes back into the store below; the
      // preview seek beneath it is the trim boundary on the composition's own
      // clock, which is already the clock the engine runs on.
      trimRestoreUsRef.current = playheadTimeUs();
      // Trimming while playing would fight the running transport for the
      // monitor — park it first (Premiere stops playback on a trim drag too).
      transportPause();
    }
    // Dedup is the effect dep itself: the value is frame-quantized upstream,
    // so a pointer wiggle inside one frame never re-seeks.
    transportPreviewSeek(trimPreviewUs);
  }, [trimPreviewUs]);

  useEffect(() => {
    if (!trimPreviewActive) return;
    return () => {
      const restoreUs = trimRestoreUsRef.current;
      trimRestoreUsRef.current = null;
      if (restoreUs === null) return;
      // Restore the monitor and resume normal transport time notifications.
      setPlayheadTimeUs(restoreUs);
      transportSeek(previewLocalUs(restoreUs));
    };
  }, [trimPreviewActive]);

  return null;
}
