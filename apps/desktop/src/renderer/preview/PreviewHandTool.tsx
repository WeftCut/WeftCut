import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { setTool, useActiveTool } from "../state/toolStore";
import { usePreviewRenderTargetId } from "../state/compositionAnchorStore";
import {
  beginPreviewPan,
  movePreviewPan,
  type PreviewPanDrag,
} from "./previewViewGestures";

/// The Hand tool's click surface: a left-button drag pans the preview, with
/// the whole panel as its target rather than the picture alone.
///
/// It is the SECOND way to pan, not the way in — the middle button pans under
/// any tool (`previewViewGestures.ts`, ADR 0072). This exists for a pointer
/// that has no middle button, and for the user who reaches for a named tool.
/// Both paths share one drag: same clamp, same abort, same arithmetic.
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
  const drag = useRef<PreviewPanDrag | null>(null);
  const end = (element: HTMLElement, pointerId: number) => {
    drag.current = null;
    setDragging(false);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };
  return <div
    className="preview-hand-overlay"
    data-testid="preview-hand-tool"
    data-dragging={dragging}
    aria-label={t("actions.select_hand_tool")}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      // The overlay is `inset: 0` over the same box as the Pixi host, so its
      // own rect is the centre every pan is measured from.
      const canvas = event.currentTarget.parentElement?.querySelector("canvas");
      const started = beginPreviewPan(event.currentTarget, canvas, event);
      if (!started) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = started;
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (!movePreviewPan(start, event.clientX, event.clientY)) {
        end(event.currentTarget, event.pointerId);
      }
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      end(event.currentTarget, event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; setDragging(false); }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
  />;
}
