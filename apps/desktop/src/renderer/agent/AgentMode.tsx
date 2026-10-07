import { useTranslation } from "react-i18next";
import {
  forwardRef,
  useState,
  useEffect,
  type CSSProperties,
  type ForwardedRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  type ProjectSummary,
} from "../ipc";
import { useOpenComposition } from "../state/projectStore";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "../preview/PreviewSurface";
import { MiniTimeline } from "./MiniTimeline";
import { AgentPanel } from "./AgentPanel";
import { Button } from "@/components/ui/button";
import { WindowControls } from "../components/WindowControls";
import { useUiScale } from '../settings/layoutTheme';

/// Lightweight viewing layout, selected locally or on a new MCP work session.
/// Switching back to the editor does not end work or release the undo lock.
///
/// Layout: preview top-left, mini timeline bottom-left, agent panel right
/// (resizable via the sash in the column gap) — grid metrics live in
/// styles/agent.css. The right pane is the shared AgentPanel component, the
/// same surface the editor dock's "Agent" panel renders. See docs/mcp.md.
/// Both the menu bar and editor-mode status bar are hidden — in
/// agent mode the record panel IS the surface for activity.
interface AgentModeProps {
  summary: ProjectSummary | null;
  onSeek: (tUs: number) => void;
  /// Switch the renderer layout back to the editor.
  onExit: () => void;
}

/// Record-panel width bounds (px).
const RECORD_WIDTH_DEFAULT = 360;
const RECORD_WIDTH_MIN = 280;
const RECORD_WIDTH_MAX = 720;

function clampRecordWidth(width: number, viewportWidth: number, scale: number): number {
  // Keep at least 480 px for the preview column so the video never
  // collapses to a sliver on narrow windows.
  const min = Math.min(RECORD_WIDTH_MIN * scale, viewportWidth * 0.45);
  const max = Math.max(
    min,
    Math.min(RECORD_WIDTH_MAX * scale, viewportWidth - 480 * scale),
  );
  return Math.round(Math.min(max, Math.max(min, width)));
}

export const AgentMode = forwardRef(function AgentMode(
  {
    summary,

    onSeek,
    onExit,
  }: AgentModeProps,
  previewRef: ForwardedRef<PreviewSurfaceHandle>,
) {
  const { t } = useTranslation();
  // The mini timeline shows the OPEN composition; `summary` keeps the
  // project-wide fields (layer_count, history).
  const comp = useOpenComposition();
  const scale = useUiScale();
  const [recordWidthBase, setRecordWidth] = useState(RECORD_WIDTH_DEFAULT);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const recordWidth = clampRecordWidth(recordWidthBase * scale, viewportWidth, scale);

  /* Width sash between the left column and the record panel — the only
     resizable seam in agent mode. Pointer capture keeps the drag alive
     off-sash; the width is measured from the drag start so the first move
     doesn't jump to the cursor. */
  const onSashPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sash = event.currentTarget;
    sash.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = recordWidth;
    const onMove = (move: globalThis.PointerEvent) => {
      setRecordWidth(
        clampRecordWidth(
          startWidth + (startX - move.clientX),
          window.innerWidth,
          scale,
        ) / scale,
      );
    };
    const onEnd = () => {
      sash.removeEventListener("pointermove", onMove);
      sash.removeEventListener("pointerup", onEnd);
      sash.removeEventListener("pointercancel", onEnd);
    };
    sash.addEventListener("pointermove", onMove);
    sash.addEventListener("pointerup", onEnd);
    sash.addEventListener("pointercancel", onEnd);
  };

  const onSashKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = (event.shiftKey ? 64 : 16) * scale;
    if (event.key === "ArrowLeft") {
      setRecordWidth(clampRecordWidth(recordWidth + step, window.innerWidth, scale) / scale);
    } else if (event.key === "ArrowRight") {
      setRecordWidth(clampRecordWidth(recordWidth - step, window.innerWidth, scale) / scale);
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div
      className="agent-mode-shell"
      style={{ "--agent-record-width": `${recordWidth}px` } as CSSProperties}
    >
      {/* Frameless window: agent mode replaces the whole app layout, so
          it carries its own slim drag strip + caption buttons. The exit
          button lives here too — top-right, ahead of the caption
          buttons. */}
      <div className="agent-titlebar" data-drag-region>
        <Button
          className="agent-exit-button"
          onClick={onExit}
          title={t("agent_mode.exit_hint")}
        >
          {t("agent_mode.exit")}
        </Button>
        <WindowControls />
      </div>
      <section className="agent-preview">
        <div id="video-surface" className="video-surface">
          <PreviewSurface
            ref={previewRef}
            hasContent={(summary?.layer_count ?? 0) > 0}
          />
        </div>
      </section>

      <section className="agent-mini-timeline">
        <MiniTimeline
          durationUs={comp?.duration_us ?? 0}
          markers={comp?.markers ?? []}
          onSeek={onSeek}
          fpsNum={comp?.fps_num ?? 30}
          fpsDen={comp?.fps_den ?? 1}
        />
      </section>

      <section className="agent-record">
        <AgentPanel editor={false} />
      </section>

      {/* The single resizable seam: record-panel width only. */}
      <div
        className="agent-width-sash"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("agent_mode.resize_record_panel")}
        aria-valuenow={recordWidth}
        aria-valuemin={clampRecordWidth(0, viewportWidth, scale)}
        aria-valuemax={clampRecordWidth(Infinity, viewportWidth, scale)}
        tabIndex={0}
        onPointerDown={onSashPointerDown}
        onKeyDown={onSashKeyDown}
      />
    </div>
  );
});
