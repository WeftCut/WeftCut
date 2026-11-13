import { useLayoutEffect, useRef } from "react";
import type { AnchorFrame } from "../render/timeProjection";
import {
  localPlayheadIn,
  subscribeLocalPlayhead,
} from "../state/playheadProjection";
import {
  TIME_MARK_WIDTH_PX,
  playheadFrameShadowPx,
  timeMarkLeftPx,
} from "./geometry";

/** A Time mark in `TimeMarkOverlay`, so the head, line, gradient and frame
 * shadow are painted once for the whole shell. Playback mutates this leaf's DOM
 * directly without rendering the track tree.
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
  const lineRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    return subscribeLocalPlayhead(compositionId, anchorFrame, (tUs) => {
      if (lineRef.current) lineRef.current.style.display = tUs === null ? "none" : "block";
      if (tUs === null) return;
      const leftPx = timeMarkLeftPx(tUs, pxPerSec);
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
      ref={lineRef}
      data-testid="timeline-playhead"
      className="absolute inset-y-0 rounded-[1px] bg-gradient-to-b from-red-300 via-red-500 to-red-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55),0_0_6px_rgba(239,68,68,0.35)]"
      style={{
        left: timeMarkLeftPx(firstPaintUs ?? 0, pxPerSec),
        width: TIME_MARK_WIDTH_PX,
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
  );
}
