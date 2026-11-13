import { RULER_HEIGHT_PX, TIME_MARK_WIDTH_PX, timeMarkLeftPx } from "./geometry";
import { useMediaDragStore } from "./mediaDrag";
import { useTimelineSnapBoundary } from "./timelineSnapFeedbackStore";

/// The colour of a magnetic target. The blade mark takes it while its cut is
/// snapped, in place of a separate guide.
export const SNAP_TARGET_COLOR = "#B5D987";

/** A magnetic target, not a playhead or transition chip: a transient soft
 * pistachio dashed Time mark in `TimeMarkOverlay`, from the ruler's bottom edge
 * down, so it reaches the marker lane as well as the clip lanes. */
export function TimelineSnapGuide({
  compositionId, pxPerSec,
}: {
  compositionId: string | null;
  pxPerSec: number;
}) {
  const gestureBoundaryUs = useTimelineSnapBoundary(compositionId);
  const mediaBoundaryUs = useMediaDragStore(({ dropTarget }) =>
    dropTarget?.compositionId === compositionId ? dropTarget.snapBoundaryUs : null,
  );
  const boundaryUs = mediaBoundaryUs ?? gestureBoundaryUs;
  if (boundaryUs === null) return null;
  return (
    <div
      data-testid="timeline-snap-guide"
      data-snap-boundary-us={boundaryUs}
      aria-hidden="true"
      className="absolute bottom-0 border-dashed opacity-90"
      style={{
        top: RULER_HEIGHT_PX,
        left: timeMarkLeftPx(boundaryUs, pxPerSec),
        width: TIME_MARK_WIDTH_PX,
        borderLeftWidth: TIME_MARK_WIDTH_PX,
        borderColor: SNAP_TARGET_COLOR,
      }}
    />
  );
}
