import { describe, expect, it } from "vitest";

import { MAIN_WINDOW_MINIMUM_SIZE, mainWindowGeometryDefaults } from "./mainWindowConfig";

describe("main window constraints", () => {
  it.each([
    ['1080p-standard', 960, 640],
    ['1080p-wide', 1200, 704],
    ['2k-standard', 1152, 768],
    ['2k-wide', 1440, 845],
    ['4k-standard', 1440, 960],
    ['4k-wide', 1800, 1056],
  ])('scales native minimum bounds for %s', (theme, minWidth, minHeight) => {
    expect(mainWindowGeometryDefaults(theme, { width: 3840, height: 2160 }))
      .toMatchObject({ minWidth, minHeight });
  });
  it('caps minimums to the available logical work area, even below baseline', () => {
    expect(mainWindowGeometryDefaults('4k-wide', { width: 1280, height: 720 }))
      .toEqual({ width: 1280, height: 720, minWidth: 1280, minHeight: 720 });
    expect(mainWindowGeometryDefaults('1080p-standard', { width: 800, height: 600 }))
      .toEqual({ width: 800, height: 600, minWidth: 800, minHeight: 600 });
  });
  it('fits a large preset to the logical work area on a scaled display', () => {
    expect(mainWindowGeometryDefaults('4k-wide', { width: 1920, height: 1040 }))
      .toMatchObject({ width: 1920, height: 1040 });
    expect(mainWindowGeometryDefaults('1080p-standard', { width: 1920, height: 1040 }))
      .toMatchObject({ width: 1440, height: 900 });
    expect(mainWindowGeometryDefaults('invalid', { width: 3840, height: 2160 }))
      .toMatchObject({ width: 1440, height: 900 });
  });
  it("keeps arbitrary Dock Trees within an operable main window", () => {
    expect(MAIN_WINDOW_MINIMUM_SIZE).toEqual({
      minWidth: 960,
      minHeight: 640,
    });
  });
});
