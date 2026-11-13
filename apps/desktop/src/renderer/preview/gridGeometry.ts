import type { PreviewGridSettings } from "../../shared/preview-grid";
import { safeAreaRect, TITLE_SAFE_FRACTION } from "./safeAreaGeometry";

export interface GridAxis {
  step: number;
  last: number;
  /** Offset of the grid region, when constrained by safe-area guides. */
  origin?: number;
  /** The two safe-area outer lines become snap targets. */
  includeBounds?: boolean;
}

export interface PreviewGrid {
  x: GridAxis | null;
  y: GridAxis | null;
  /** When guides are enabled, grid interior lines occupy the title-safe rectangle. */
  bounds?: { x: number; y: number; w: number; h: number };
}

// Subdivisions belong to the frame, not the viewport. Snapping and drawing
// share the same geometry, including the title-safe outer lines when enabled.
export function previewGrid(width: number, height: number, settings: PreviewGridSettings, safeArea = false): PreviewGrid {
  const bounds = safeArea ? safeAreaRect(TITLE_SAFE_FRACTION, width, height) : { x: 0, y: 0, w: width, h: height };
  const axis = (size: number, origin: number, divisions: number, enabled: boolean): GridAxis | null => {
    const step = size / divisions;
    const last = divisions - 1;
    if (!enabled || !(step > 0) || (last < 1 && !safeArea)) return null;
    return safeArea ? { step, last, origin, includeBounds: true } : { step, last };
  };
  return {
    x: axis(bounds.w, bounds.x, settings.column_divisions, settings.columns),
    y: axis(bounds.h, bounds.y, settings.row_divisions, settings.rows),
    ...(safeArea ? { bounds } : {}),
  };
}

export function nearestGridLine(at: number, axis: GridAxis): number {
  const origin = axis.origin ?? 0;
  // A half-step tie goes to the lower coordinate. With visible safe areas,
  // their outer edges are also valid grid snap targets.
  const index = Math.min(axis.last + (axis.includeBounds ? 1 : 0),
    Math.max(axis.includeBounds ? 0 : 1, Math.ceil((at - origin) / axis.step - 0.5)));
  return origin + index * axis.step;
}
