import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_GRID, GRID_DIVISIONS_MAX } from "../../shared/preview-grid";
import { nearestGridLine, previewGrid } from "./gridGeometry";

describe("previewGrid", () => {
  it.each([
    [DEFAULT_PREVIEW_GRID.column_divisions, DEFAULT_PREVIEW_GRID.row_divisions],
    [12, 5],
    [GRID_DIVISIONS_MAX, GRID_DIVISIONS_MAX],
  ])("divides the frame into %i × %i equal fields without rounding", (columns, rows) => {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [801, 603]] as const) {
      const grid = previewGrid(width, height, {
        ...DEFAULT_PREVIEW_GRID, column_divisions: columns, row_divisions: rows,
      });
      expect(grid).toEqual({
        x: { origin: 0, step: width / columns, last: columns - 1, includeBounds: false },
        y: { origin: 0, step: height / rows, last: rows - 1, includeBounds: false },
        bounds: { x: 0, y: 0, w: width, h: height },
      });
    }
  });

  it("omits an axis that is off or has a single field", () => {
    const grid = previewGrid(800, 500, { ...DEFAULT_PREVIEW_GRID, columns: false, row_divisions: 1 });
    expect(grid.x).toBeNull();
    expect(grid.y).toBeNull();
  });

  it("divides the title-safe rectangle and snaps to its edges while the guides are on", () => {
    const grid = previewGrid(1000, 500, { ...DEFAULT_PREVIEW_GRID, column_divisions: 2, row_divisions: 4 }, true);
    expect(grid.bounds).toEqual({ x: 50, y: 25, w: 900, h: 450 });
    expect(grid.x).toEqual({ origin: 50, step: 450, last: 1, includeBounds: true });
    expect(grid.y).toEqual({ origin: 25, step: 112.5, last: 3, includeBounds: true });
    expect(nearestGridLine(44, grid.x!)).toBe(50);
    expect(nearestGridLine(954, grid.x!)).toBe(950);
  });

  it("keeps the title-safe edges as targets when a count is one", () => {
    const grid = previewGrid(1000, 500, { ...DEFAULT_PREVIEW_GRID, column_divisions: 1, row_divisions: 1 }, true);
    expect(grid.x).toMatchObject({ last: 0, includeBounds: true });
    expect(nearestGridLine(45, grid.x!)).toBe(50);
    expect(nearestGridLine(955, grid.x!)).toBe(950);
  });

  it("resolves midpoints toward the lower line and clamps to the interior", () => {
    const axis = { origin: 0, step: 100, last: 7, includeBounds: false };
    expect(nearestGridLine(349.9, axis)).toBe(300);
    expect(nearestGridLine(350, axis)).toBe(300);
    expect(nearestGridLine(350.1, axis)).toBe(400);
    expect(nearestGridLine(-10, axis)).toBe(100);
    expect(nearestGridLine(801, axis)).toBe(700);
  });
});
