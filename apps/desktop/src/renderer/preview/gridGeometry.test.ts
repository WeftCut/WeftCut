import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_GRID } from "../../shared/preview-grid";
import { nearestGridLine, previewGrid } from "./gridGeometry";

describe("previewGrid", () => {
  it.each([[1920, 1080], [1080, 1920], [640, 360], [801, 603]])(
    "divides %i × %i into 12 columns and 5 rows without rounding fractional positions",
    (width, height) => {
      const grid = previewGrid(width, height, {
        ...DEFAULT_PREVIEW_GRID, column_divisions: 12, row_divisions: 5,
      });
      expect(grid).toEqual({
        x: { step: width / 12, last: 11 },
        y: { step: height / 5, last: 4 },
      });
      // Each line uses a composition-relative fraction, regardless of format.
      expect(grid.x!.step / width).toBeCloseTo(1 / 12);
      expect(grid.y!.step / height).toBeCloseTo(1 / 5);
    },
  );

  it("omits disabled axes and axes with only one field", () => {
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, columns: false, row_divisions: 1,
    })).toEqual({ x: null, y: null });
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, column_divisions: 1, row_divisions: 5,
    })).toEqual({ x: null, y: { step: 100, last: 4 } });
  });

  it("resolves midpoints toward the lower line and clamps to the interior", () => {
    const axis = { step: 100, last: 7 };
    expect(nearestGridLine(349.9, axis)).toBe(300);
    expect(nearestGridLine(350, axis)).toBe(300);
    expect(nearestGridLine(350.1, axis)).toBe(400);
    expect(nearestGridLine(-10, axis)).toBe(100);
    expect(nearestGridLine(801, axis)).toBe(700);
  });
});
