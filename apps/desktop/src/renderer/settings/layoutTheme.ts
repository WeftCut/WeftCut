import { LAYOUT_THEMES, readLayoutTheme } from '../../shared/layout-theme';
import { useSyncExternalStore } from 'react';

let uiScale = 1;
const listeners = new Set<() => void>();
export const getUiScale = () => uiScale;
export function subscribeUiScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useUiScale = () => useSyncExternalStore(subscribeUiScale, getUiScale);
/** JS-owned layout constraints use the same units as CSS --ui-px. */
export const uiPixels = (baseline: number) => Math.round(baseline * uiScale);

/** Apply on hydration so boot, setting changes and other windows share a path.
 * Root variables also reach dialogs and menus rendered through portals. */
export function applyLayoutTheme(value: unknown): void {
  const id = readLayoutTheme(value);
  const theme = LAYOUT_THEMES[id];
  const changed = uiScale !== theme.fontScale;
  uiScale = theme.fontScale;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.layoutTheme = id;
    root.style.setProperty('--layout-font-scale', String(theme.fontScale));
    root.style.setProperty('--layout-width-scale', String(theme.widthScale));
    root.style.setProperty('--layout-strip-thickness', `${uiPixels(44)}px`);
  }
  if (changed) for (const listener of listeners) listener();
}
