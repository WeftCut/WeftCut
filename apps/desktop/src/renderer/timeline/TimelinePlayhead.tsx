import { useLayoutEffect, useRef } from "react";
import type { AnchorFrame } from "../render/timeProjection";
import {
  localPlayheadIn,
  subscribeLocalPlayhead,
} from "../state/playheadProjection";
import {
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "../state/timelineScrollStore";
import { HEADER_COL_PX, playheadFrameShadowPx } from "./geometry";

/** One overlay spans the timeline shell, so the head, line, gradient and frame
 * shadow are painted once. It clips at the time area's edges, ignores pointer
 * events and follows only horizontal scroll. Playback and scrolling mutate
 * leaf DOM nodes directly without rendering the track tree.
 *
 * The moment is projected into this composition using its already-resolved
 * anchor. An off-screen Group draws nothing (ADR 0053). */
export function TimelinePlayhead({
  compositionId, anchorFrame, pxPerSec, fpsNum, fpsDen, visible,
}: {
  compositionId: string | null;
  anchorFrame: AnchorFrame | null;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  visible: boolean;
}) {
  const axisRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
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
  useLayoutEffect(() => {
    if (!visible) return;
    return subscribeLocalPlayhead(compositionId, anchorFrame, (tUs) => {
      if (lineRef.current) lineRef.current.style.display = tUs === null ? "none" : "block";
      if (tUs === null) return;
      const leftPx = (tUs / 1_000_000) * pxPerSec;
      if (lineRef.current) lineRef.current.style.left = `${leftPx}px`;
      if (shadowRef.current) {
        const shadow = playheadFrameShadowPx(tUs, fpsNum, fpsDen, pxPerSec);
        shadowRef.current.style.display = shadow ? "block" : "none";
        if (shadow) {
          shadowRef.current.style.left = `${shadow.leftPx - leftPx}px`;
          shadowRef.current.style.width = `${shadow.widthPx}px`;
        }
      }
    });
  }, [anchorFrame, compositionId, pxPerSec, fpsNum, fpsDen, visible]);
  const firstPaintUs = localPlayheadIn(compositionId, anchorFrame);
  return (
    <div
      data-testid="timeline-playhead-overlay"
      className="pointer-events-none absolute inset-y-0 right-0 z-20 overflow-hidden"
      style={{ left: HEADER_COL_PX }}
    >
      <div ref={axisRef} className="absolute inset-0"
        style={{ transform: `translateX(${-timelineScrollLeftPx(compositionId)}px)` }}>
        <div
          ref={lineRef}
          data-testid="timeline-playhead"
          className="absolute inset-y-0 w-0.5 rounded-[1px] bg-gradient-to-b from-red-300 via-red-500 to-red-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55),0_0_6px_rgba(239,68,68,0.35)]"
          style={{
            left: ((firstPaintUs ?? 0) / 1_000_000) * pxPerSec,
            display: firstPaintUs === null ? "none" : undefined,
          }}
        >
          <div ref={shadowRef} data-testid="timeline-playhead-frame-shadow"
            className="absolute inset-y-0 bg-red-500/10" style={{ display: "none" }} />
          <div data-testid="timeline-playhead-head" className="absolute top-0 h-4 w-0">
            <div data-testid="timeline-playhead-line-cap"
              className="absolute -left-1.5 top-0 h-0.5 w-3.5 bg-card" />
            <div data-testid="timeline-playhead-head-shape"
              className="absolute -left-1.5 top-0.5 h-3.5 w-3.5 bg-gradient-to-b from-[#fb7185] via-red-500 to-red-700 [clip-path:polygon(0_0,100%_0,100%_45%,50%_100%,0_45%)] [filter:drop-shadow(0_1px_1.5px_rgba(0,0,0,0.6))]" />
          </div>
        </div>
      </div>
    </div>
  );
}
