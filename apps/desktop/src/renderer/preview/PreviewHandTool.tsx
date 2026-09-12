import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clampPreviewPan, usePreviewViewStore } from "../state/previewViewStore";
import { setTool, useActiveTool } from "../state/toolStore";
import { usePreviewRenderTargetId } from "../state/compositionAnchorStore";

export function PreviewHandTool() {
  const tool = useActiveTool();
  const targetId = usePreviewRenderTargetId();
  useEffect(() => {
    if (tool !== "hand") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);
  return tool === "hand" ? <HandSurface key={targetId} /> : null;
}

function HandSurface() {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number; x: number; y: number; panX: number; panY: number;
    width: number; height: number; hostWidth: number; hostHeight: number;
    zoom: number;
  } | null>(null);
  return <div
    className="preview-hand-overlay"
    data-testid="preview-hand-tool"
    data-dragging={dragging}
    aria-label={t("actions.select_hand_tool")}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      const canvas = event.currentTarget.parentElement?.querySelector("canvas");
      if (!canvas) return;
      const host = event.currentTarget.getBoundingClientRect();
      const frame = canvas.getBoundingClientRect();
      if (!(host.width > 0 && host.height > 0 && frame.width > 0 && frame.height > 0)) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        panX: frame.left + frame.width / 2 - host.left - host.width / 2,
        panY: frame.top + frame.height / 2 - host.top - host.height / 2,
        width: frame.width, height: frame.height, hostWidth: host.width, hostHeight: host.height,
        zoom: usePreviewViewStore.getState().zoom,
      };
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (usePreviewViewStore.getState().zoom !== start.zoom) {
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setDragging(false);
        return;
      }
      usePreviewViewStore.setState({ pan: {
        x: clampPreviewPan(start.panX + event.clientX - start.x, start.width, start.hostWidth),
        y: clampPreviewPan(start.panY + event.clientY - start.y, start.height, start.hostHeight),
      } });
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; setDragging(false); }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
  />;
}
