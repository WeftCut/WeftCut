import type { PreviewGridSettings } from "../../shared/preview-grid";

export interface GridAxis {
  step: number;
  last: number;
}

export interface PreviewGrid {
  x: GridAxis | null;
  y: GridAxis | null;
}

// Frame edges already have their own snap target. Both modes place interior
// lines from the composition origin, so panning cannot change the lattice.
export function previewGrid(width: number, height: number, settings: PreviewGridSettings): PreviewGrid {
  const axis = (size: number, gap: number, enabled: boolean): GridAxis | null => {
    const equal = settings.mode === "equal";
    const step = equal ? size / settings.divisions : gap;
    const last = equal ? settings.divisions - 1 : Math.ceil(size / step) - 1;
    return enabled && step > 0 && last > 0 ? { step, last } : null;
  };

  return {
    x: axis(width, settings.column_gap_px, settings.columns),
    y: axis(height, settings.row_gap_px, settings.rows),
  };
}

export function nearestGridLine(at: number, axis: GridAxis): number {
  // A half-step tie goes to the lower coordinate.
  const index = Math.min(axis.last, Math.max(1, Math.ceil(at / axis.step - 0.5)));
  return index * axis.step;
}
