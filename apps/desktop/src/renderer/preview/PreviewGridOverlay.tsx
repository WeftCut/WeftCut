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
  if (!settings.visible || !composition || (!settings.columns && !settings.rows)) return null;
  return <PreviewGridOverlay width={composition.width} height={composition.height} settings={settings} safeArea={safeArea} />;
}

function gridPath(axis: GridAxis | null, line: (at: number) => string): string {
  if (!axis) return "";
  return Array.from({ length: axis.last }, (_, i) => line((axis.origin ?? 0) + (i + 1) * axis.step)).join(" ");
}

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
  const columns = useMemo(() => gridPath(grid.x, (x) => "M " + x + " " + (grid.bounds?.y ?? 0) + " v " + (grid.bounds?.h ?? height)), [grid.x, grid.bounds, height]);
  const rows = useMemo(() => gridPath(grid.y, (y) => "M " + (grid.bounds?.x ?? 0) + " " + y + " h " + (grid.bounds?.w ?? width)), [grid.y, grid.bounds, width]);

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
      // Fade each axis as its lines approach screen-pixel density.
      if (grid.x) columnsRef.current?.setAttribute("opacity", String(settings.opacity / 100 * Math.min(1, grid.x.step * fit.scale / 6)));
      if (grid.y) rowsRef.current?.setAttribute("opacity", String(settings.opacity / 100 * Math.min(1, grid.y.step * fit.scale / 6)));
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
