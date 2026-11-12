import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_GRID } from "../../shared/preview-grid";
import { nearestGridLine, previewGrid } from "./gridGeometry";

describe("previewGrid", () => {
  it.each([[1920, 1080], [1080, 1920], [640, 360], [801, 603]])(
    "defaults to three equal subdivisions of %i × %i",
    (width, height) => {
      expect(previewGrid(width, height, DEFAULT_PREVIEW_GRID)).toEqual({
        x: { step: width / 3, last: 2 },
        y: { step: height / 3, last: 2 },
      });
    },
  );

  it.each([[1920, 1080], [1080, 1920], [640, 360], [801, 603]])(
    "divides %i × %i into 12 columns and 5 rows without rounding fractional positions",
    (width, height) => {
      const grid = previewGrid(width, height, {
        ...DEFAULT_PREVIEW_GRID, mode: "independent", column_divisions: 12, row_divisions: 5,
      });
      expect(grid).toEqual({
        x: { step: width / 12, last: 11 },
        y: { step: height / 5, last: 4 },
      });
      expect(grid.x!.step / width).toBeCloseTo(1 / 12);
      expect(grid.y!.step / height).toBeCloseTo(1 / 5);
    },
  );

  it("omits disabled axes and axes with only one field in independent mode", () => {
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, mode: "independent", columns: false, row_divisions: 1,
    })).toEqual({ x: null, y: null });
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, mode: "independent", column_divisions: 1, row_divisions: 5,
    })).toEqual({ x: null, y: { step: 100, last: 4 } });
  });

  it("ignores independent axis switches and counts in equal mode", () => {
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, mode: "equal", divisions: 4,
      column_divisions: 12, row_divisions: 5, columns: false, rows: false,
    })).toEqual({ x: { step: 200, last: 3 }, y: { step: 125, last: 3 } });
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
