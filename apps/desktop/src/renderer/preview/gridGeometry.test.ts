import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_GRID } from "../../shared/preview-grid";
import { nearestGridLine, previewGrid } from "./gridGeometry";

describe("previewGrid", () => {
  it.each([[1920, 1080], [1080, 1920], [640, 360], [801, 603]])(
    "subdivides the %i × %i composition on both axes",
    (width, height) => {
      const grid = previewGrid(width, height, { ...DEFAULT_PREVIEW_GRID, divisions: 3 });
      expect(grid).toEqual({
        x: { step: width / 3, last: 2 },
        y: { step: height / 3, last: 2 },
      });
    },
  );

  it("preserves independent pixel gaps from the origin and skips frame edges", () => {
    const grid = previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, mode: "pixels", column_gap_px: 100, row_gap_px: 120,
    });
    expect(grid.x).toEqual({ step: 100, last: 7 });
    expect(grid.y).toEqual({ step: 120, last: 4 });
  });

  it("omits a disabled axis and an axis with no interior lines", () => {
    expect(previewGrid(800, 500, {
      ...DEFAULT_PREVIEW_GRID, columns: false, mode: "pixels", row_gap_px: 500,
    })).toEqual({ x: null, y: null });
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
