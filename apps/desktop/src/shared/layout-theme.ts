/** Internal layout recipes. Only the preset id is a persisted preference.
 * Sizes are CSS pixels / Electron DIPs; OS display scaling is already applied.
 * Persisted `-wide` ids remain stable; the UI calls these variants Relaxed.
 * Relaxed variants add horizontal room and 10% larger typography. */
export const LAYOUT_THEMES = {
  '1080p-standard': { fontScale: 1, widthScale: 1, window: { width: 1440, height: 900 } },
  '1080p-wide': { fontScale: 1.1, widthScale: 1.25, window: { width: 1760, height: 900 } },
  '2k-standard': { fontScale: 1.2, widthScale: 1.2, window: { width: 1920, height: 1200 } },
  '2k-wide': { fontScale: 1.32, widthScale: 1.5, window: { width: 2360, height: 1200 } },
  '4k-standard': { fontScale: 1.5, widthScale: 1.5, window: { width: 2560, height: 1600 } },
  '4k-wide': { fontScale: 1.65, widthScale: 1.875, window: { width: 3360, height: 1600 } },
} as const;

export type LayoutTheme = keyof typeof LAYOUT_THEMES;
export const DEFAULT_LAYOUT_THEME: LayoutTheme = '1080p-standard';
export const LAYOUT_THEME_IDS = Object.keys(LAYOUT_THEMES) as LayoutTheme[];

export function isLayoutTheme(value: unknown): value is LayoutTheme {
  return typeof value === 'string' && Object.hasOwn(LAYOUT_THEMES, value);
}

export function readLayoutTheme(value: unknown): LayoutTheme {
  return isLayoutTheme(value) ? value : DEFAULT_LAYOUT_THEME;
}
