import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "../state/timelineScrollStore";
import { headerColumnPx } from "./geometry";
import { useUiScale } from "../settings/layoutTheme";

/** The one layer every Time mark (CONTEXT.md) draws in: the playhead, the snap
 * guide and the blade mark. It spans the timeline shell from the ruler to the
 * bottom, clips at the time area's edges, ignores pointer events and follows
 * only horizontal scroll, so scrolling moves one transform and renders no mark.
 * Children place themselves with `timeMarkLeftPx` on composition time. */
export function TimeMarkOverlay({
  compositionId, visible, children,
}: {
  compositionId: string | null;
  visible: boolean;
  children: ReactNode;
}) {
  useUiScale(); // header column offset
  const axisRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const sync = () => {
      if (axisRef.current) {
        axisRef.current.style.transform = `translateX(${-timelineScrollLeftPx(compositionId)}px)`;
      }
    };
    sync();
    return useTimelineScrollStore.subscribe(sync);
  }, [compositionId, visible]);
  return (
    <div
      data-testid="timeline-time-mark-overlay"
      className="pointer-events-none absolute inset-y-0 right-0 z-20 overflow-hidden"
      style={{ left: headerColumnPx() }}
    >
      <div ref={axisRef} className="absolute inset-0"
        style={{ transform: `translateX(${-timelineScrollLeftPx(compositionId)}px)` }}>
        {children}
      </div>
    </div>
  );
}
