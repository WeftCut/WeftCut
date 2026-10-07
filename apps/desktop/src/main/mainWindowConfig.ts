import { LAYOUT_THEMES, DEFAULT_LAYOUT_THEME, readLayoutTheme } from '../shared/layout-theme';

export const MAIN_WINDOW_MINIMUM_SIZE = {
  minWidth: 960,
  minHeight: 640,
} as const;

/// Size for a first launch, or whenever the saved geometry is unusable (stale
/// monitor, shrunken resolution, corrupt file — see windowGeometry.ts). No x/y:
/// Chromium centers a window whose position is absent.
export const MAIN_WINDOW_DEFAULT_SIZE = LAYOUT_THEMES[DEFAULT_LAYOUT_THEME].window;

/// Key under which the main window's geometry is persisted in
/// <userData>/window_geometry.json. A COMPATIBILITY SURFACE — renaming it
/// silently discards every existing user's saved position.
export const MAIN_WINDOW_LABEL = "main";

/// Combined defaults for the geometry sanitizer, which clamps a restored rect
/// against both the fallback size and the window's own minimums.
export const MAIN_WINDOW_GEOMETRY_DEFAULTS = {
  ...MAIN_WINDOW_DEFAULT_SIZE,
  ...MAIN_WINDOW_MINIMUM_SIZE,
} as const;

/** Remembered geometry wins within the active theme's minimums. Work-area
 * dimensions are DIPs, so a large preset on a scaled monitor stays reachable. */
export function mainWindowGeometryDefaults(theme: unknown, workArea: { width: number; height: number }) {
  const recipe = LAYOUT_THEMES[readLayoutTheme(theme)];
  const size = recipe.window;
  const minWidth = Math.min(workArea.width, Math.round(MAIN_WINDOW_MINIMUM_SIZE.minWidth * recipe.widthScale));
  const minHeight = Math.min(workArea.height, Math.round(MAIN_WINDOW_MINIMUM_SIZE.minHeight * recipe.fontScale));
  return {
    minWidth,
    minHeight,
    width: Math.max(minWidth, Math.min(size.width, workArea.width)),
    height: Math.max(minHeight, Math.min(size.height, workArea.height)),
  };
}
