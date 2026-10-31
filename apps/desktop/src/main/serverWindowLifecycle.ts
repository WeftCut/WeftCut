type Window = {
  isDestroyed(): boolean; isMinimized(): boolean; isVisible(): boolean;
  minimize(): void; restore(): void; hide(): void; show(): void; focus(): void;
};

const minimized = new WeakSet<Window>();
const listeners = new WeakMap<Window, () => void>();

export function onEditorWindowStateChanged(win: Window, listener: () => void): () => void {
  listeners.set(win, listener);
  return () => { listeners.delete(win); minimized.delete(win); };
}

// xdg-shell has no client-side unminimize. Keep the surface mapped and let
// the authenticated remote viewer hide/suspend its canvas instead. Rendering
// and exports keep their state; restoration never requires compositor policy.
export function minimizeEditorWindow(win: Window, remoteWayland: boolean): void {
  if (win.isDestroyed()) return;
  if (remoteWayland) { minimized.add(win); listeners.get(win)?.(); }
  else win.minimize();
}

export function restoreEditorWindow(win: Window, remoteWayland: boolean): void {
  if (win.isDestroyed()) return;
  minimized.delete(win);
  if (win.isMinimized()) {
    win.restore();
    if (remoteWayland) win.hide();
  }
  win.show();
  win.focus();
  listeners.get(win)?.();
}

export function editorWindowMinimized(win: Window, remoteWayland: boolean): boolean {
  return win.isMinimized() || (remoteWayland && (minimized.has(win) || !win.isVisible()));
}
