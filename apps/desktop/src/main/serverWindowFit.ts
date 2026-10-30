type Rect = { x: number; y: number; width: number; height: number };
type Window = {
  isDestroyed(): boolean; isMaximized(): boolean; isFullScreen(): boolean; isMinimized(): boolean;
  getBounds(): Rect; setBounds(bounds: Rect): void;
};

/** Maximized/fullscreen geometry belongs to the compositor. Overriding it
 * during a display configure violates Wayland xdg_surface's size contract. */
export function fitServerWindow(win: Window, workArea: () => Rect): void {
  if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
  const target = workArea(), current = win.getBounds();
  if (current.x === target.x && current.y === target.y && current.width === target.width && current.height === target.height) return;
  win.setBounds(target);
}
