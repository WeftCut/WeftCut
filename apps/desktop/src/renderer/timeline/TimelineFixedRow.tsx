import { useLayoutEffect, useRef, type ReactNode } from "react";
import { HEADER_COL_PX } from "./geometry";
import {
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "../state/timelineScrollStore";

/** Fixed chrome shares the track viewport's time axis, never its vertical
 * scroll or editing surface. Updating only this transform avoids rendering
 * the track tree on scroll. Each row clips its own decorations and hit area. */
export function TimelineFixedRow({
  compositionId, widthPx, header, children,
}: {
  compositionId: string | null;
  widthPx: number;
  header: ReactNode;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sync = () => {
      if (contentRef.current) {
        contentRef.current.style.transform = `translateX(${-timelineScrollLeftPx(compositionId)}px)`;
      }
    };
    sync();
    return useTimelineScrollStore.subscribe(sync);
  }, [compositionId]);
  return (
    <div className="relative isolate grid min-w-0 overflow-hidden" style={{ gridTemplateColumns: `${HEADER_COL_PX}px minmax(0, 1fr)` }}>
      <div className="border-r border-border bg-card">{header}</div>
      <div className="min-w-0 overflow-hidden">
        <div ref={contentRef} className="relative" style={{ width: widthPx }}>{children}</div>
      </div>
    </div>
  );
}
