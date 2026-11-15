import type { PreviewGridSettings } from "../../shared/preview-grid";
import { safeAreaRect, TITLE_SAFE_FRACTION } from "./safeAreaGeometry";

/** One axis of the grid, in composition pixels. Interior lines sit at
 *  `origin + i * step` for `i` in 1..`last`. */
export interface GridAxis {
  origin: number;
  step: number;
  last: number;
  /** The region's two outer edges (`i` = 0 and `last + 1`) are snap targets
   *  too. True while the grid divides the title-safe rectangle: the safe-area
   *  guides draw those edges, so they are visible lines. */
  includeBounds: boolean;
}

export interface PreviewGrid {
  x: GridAxis | null;
  y: GridAxis | null;
  /** The rectangle the grid divides: title-safe while the guides are on, else
   *  the whole frame. */
  bounds: { x: number; y: number; w: number; h: number };
}

/// The grid's lines in composition pixels, so drawing and snapping share one
/// geometry and the grid follows the frame, not the viewport. An axis is null
/// when it is off or has no line to offer.
export function previewGrid(width: number, height: number, settings: PreviewGridSettings, safeArea = false): PreviewGrid {
  const bounds = safeArea ? safeAreaRect(TITLE_SAFE_FRACTION, width, height) : { x: 0, y: 0, w: width, h: height };
  const axis = (size: number, origin: number, divisions: number, enabled: boolean): GridAxis | null => {
    const step = size / divisions;
    const last = divisions - 1;
    if (!enabled || !(step > 0) || (last < 1 && !safeArea)) return null;
    return { origin, step, last, includeBounds: safeArea };
  };
  return {
    x: axis(bounds.w, bounds.x, settings.column_divisions, settings.columns),
    y: axis(bounds.h, bounds.y, settings.row_divisions, settings.rows),
    bounds,
  };
}

/// The grid line nearest `at`. A half-step tie goes to the lower line.
export function nearestGridLine(at: number, axis: GridAxis): number {
  const first = axis.includeBounds ? 0 : 1;
  const final = axis.last + (axis.includeBounds ? 1 : 0);
  const index = Math.min(final, Math.max(first, Math.ceil((at - axis.origin) / axis.step - 0.5)));
  return axis.origin + index * axis.step;
}
