import { useTimelineSnapBoundary } from "./timelineSnapFeedbackStore";

/** A magnetic target, not a playhead or a timeline grid. The transient lilac
 * dashed rule follows composition time and scrolls with the clip lanes. */
export function TimelineSnapGuide({
  compositionId, pxPerSec,
}: {
  compositionId: string | null;
  pxPerSec: number;
}) {
  const boundaryUs = useTimelineSnapBoundary(compositionId);
  if (boundaryUs === null) return null;
  return (
    <div
      data-testid="timeline-snap-guide"
      data-snap-boundary-us={boundaryUs}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-30"
      style={{ left: (boundaryUs / 1_000_000) * pxPerSec }}
    >
      <div className="absolute inset-y-0 border-l-2 border-dashed border-fuchsia-400/90" />
      <div
        className="absolute top-0 rotate-45 border border-fuchsia-400 bg-fuchsia-400/80"
        style={{
          left: "calc(-3 * var(--ui-px))",
          height: "calc(6 * var(--ui-px))",
          width: "calc(6 * var(--ui-px))",
        }}
      />
    </div>
  );
}
