import { useEffect, useMemo, useRef } from "react";
import type { PreviewGridSettings } from "../../shared/preview-grid";

import { useSafeAreaGuidesVisible, usePreviewGrid } from "../settings/appSettingsStore";
import { usePreviewRenderTargetId } from "../state/compositionAnchorStore";
import { useComposition } from "../state/projectStore";
import { containFit } from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";
import { previewGrid, type GridAxis } from "./gridGeometry";
import { observeClientRect } from "./layoutRectCache";

export function PreviewGridOverlayHost() {
  const settings = usePreviewGrid();
  const safeArea = useSafeAreaGuidesVisible();
  const composition = useComposition(usePreviewRenderTargetId());
  if (!settings.enabled || settings.hidden || !composition || (!settings.columns && !settings.rows)) return null;
  return <PreviewGridOverlay width={composition.width} height={composition.height} settings={settings} safeArea={safeArea} />;
}

/// Interior lines only: with safe-area guides on, the region's outer edges are
/// snap targets that the guides already draw.
function gridPath(axis: GridAxis | null, line: (at: number) => string): string {
  if (!axis) return "";
  return Array.from({ length: axis.last }, (_, i) => line(axis.origin + (i + 1) * axis.step)).join(" ");
}

/// Line spacing, in screen pixels, below which an axis starts to fade: denser
/// than this the lines merge into a wash that hides the picture.
const FADE_BELOW_SPACING_PX = 6;

function PreviewGridOverlay({ width, height, settings, safeArea }: {
  width: number;
  height: number;
  settings: PreviewGridSettings;
  safeArea: boolean;
}) {
  const overlayRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<SVGSVGElement>(null);
  const columnsRef = useRef<SVGGElement>(null);
  const rowsRef = useRef<SVGGElement>(null);
  const grid = useMemo(
    () => previewGrid(width, height, settings, safeArea), [width, height, settings, safeArea],
  );
  const columns = useMemo(() => gridPath(grid.x, (x) => `M ${x} ${grid.bounds.y} v ${grid.bounds.h}`), [grid.x, grid.bounds]);
  const rows = useMemo(() => gridPath(grid.y, (y) => `M ${grid.bounds.x} ${y} h ${grid.bounds.w}`), [grid.y, grid.bounds]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const frame = frameRef.current;
    if (!overlay || !frame) return;
    const ownRect = observeClientRect(overlay);
    let previousCanvas: DOMRect | null | undefined;
    let previousOwn: DOMRect | undefined;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = getGizmoProbe()?.canvasRect() ?? null;
      const own = ownRect.rect();
      if (canvas === previousCanvas && own === previousOwn) return;
      previousCanvas = canvas;
      previousOwn = own;
      const fit = canvas ? containFit(canvas, width, height) : null;
      if (!fit) {
        frame.setAttribute("visibility", "hidden");
        return;
      }
      frame.setAttribute("x", String(fit.offX - own.left));
      frame.setAttribute("y", String(fit.offY - own.top));
      frame.setAttribute("width", String(width * fit.scale));
      frame.setAttribute("height", String(height * fit.scale));
      frame.setAttribute("visibility", "visible");
      const fade = (step: number) => Math.min(1, step * fit.scale / FADE_BELOW_SPACING_PX);
      if (grid.x) columnsRef.current?.setAttribute("opacity", String(settings.opacity / 100 * fade(grid.x.step)));
      if (grid.y) rowsRef.current?.setAttribute("opacity", String(settings.opacity / 100 * fade(grid.y.step)));
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ownRect.dispose();
    };
  }, [width, height, grid, settings.opacity]);

  return (
    <svg ref={overlayRef} className="preview-grid-overlay" data-testid="preview-grid" aria-hidden="true" focusable="false">
      <svg ref={frameRef} viewBox={["0", "0", width, height].join(" ")} visibility="hidden">
        {grid.x && (
          <g ref={columnsRef}>
            <path className="preview-grid-under" d={columns} vectorEffect="non-scaling-stroke" />
            <path className="preview-grid-line" d={columns} vectorEffect="non-scaling-stroke" />
          </g>
        )}
        {grid.y && (
          <g ref={rowsRef}>
            <path className="preview-grid-under" d={rows} vectorEffect="non-scaling-stroke" />
            <path className="preview-grid-line" d={rows} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
    </svg>
  );
}
