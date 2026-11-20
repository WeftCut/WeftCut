import { LAYOUT_THEMES, LAYOUT_MINIMUM_WINDOW, readLayoutTheme } from '../shared/layout-theme';

export const MAIN_WINDOW_MINIMUM_SIZE = {
  minWidth: LAYOUT_MINIMUM_WINDOW.width,
  minHeight: LAYOUT_MINIMUM_WINDOW.height,
} as const;

/// Key under which the main window's geometry is persisted in
/// <userData>/window_geometry.json. A COMPATIBILITY SURFACE — renaming it
/// silently discards every existing user's saved position.
export const MAIN_WINDOW_LABEL = "main";

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
