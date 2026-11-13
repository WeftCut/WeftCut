import { useMediaDragStore } from "./mediaDrag";
import { useTimelineSnapBoundary } from "./timelineSnapFeedbackStore";

/** A magnetic target, not a playhead or transition chip. The transient soft
 * pistachio dashed rule follows composition time and scrolls with clip lanes. */
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
      className="pointer-events-none absolute inset-y-0 z-30"
      style={{ left: (boundaryUs / 1_000_000) * pxPerSec }}
    >
      <div className="absolute inset-y-0 border-l-2 border-dashed border-[#B5D987]/90" />
    </div>
  );
}
