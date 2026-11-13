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
        ...DEFAULT_PREVIEW_GRID, column_divisions: 12, row_divisions: 5,
      });
      expect(grid).toEqual({
        x: { step: width / 12, last: 11 },
        y: { step: height / 5, last: 4 },
      });
      expect(grid.x!.step / width).toBeCloseTo(1 / 12);
      expect(grid.y!.step / height).toBeCloseTo(1 / 5);
    },
  );

  it('preserves fractional 64-division geometry on portrait and landscape frames', () => {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [853, 480]] as const) {
      const grid = previewGrid(width, height, {
        ...DEFAULT_PREVIEW_GRID, column_divisions: 64, row_divisions: 64,
      });
      expect(grid.x).toEqual({ step: width / 64, last: 63 });
      expect(grid.y).toEqual({ step: height / 64, last: 63 });
    }
  });

  it("omits disabled axes and axes with only one field in independent mode", () => {
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, columns: false, row_divisions: 1,
    })).toEqual({ x: null, y: null });
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, column_divisions: 1, row_divisions: 5,
    })).toEqual({ x: null, y: { step: 100, last: 4 } });
  });

  it("uses the visible title-safe bounds and snaps to the outer lines when guides are on", () => {
    const grid = previewGrid(1000, 500, { ...DEFAULT_PREVIEW_GRID, column_divisions: 2, row_divisions: 4 }, true);
    expect(grid.bounds).toEqual({ x: 50, y: 25, w: 900, h: 450 });
    expect(grid.x).toEqual({ origin: 50, step: 450, last: 1, includeBounds: true });
    expect(grid.y).toEqual({ origin: 25, step: 112.5, last: 3, includeBounds: true });
    expect(nearestGridLine(44, grid.x!)).toBe(50);
    expect(nearestGridLine(954, grid.x!)).toBe(950);
  });

  it("does not remove title-safe outer targets when a count is one", () => {
    const grid = previewGrid(1000, 500, { ...DEFAULT_PREVIEW_GRID, column_divisions: 1, row_divisions: 1 }, true);
    expect(grid.x).toMatchObject({ step: 900, last: 0, includeBounds: true });
    expect(nearestGridLine(45, grid.x!)).toBe(50);
    expect(nearestGridLine(955, grid.x!)).toBe(950);
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
