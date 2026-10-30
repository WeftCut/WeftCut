import { describe, it, expect, vi } from 'vitest';
import { minimizeEditorWindow, restoreEditorWindow, editorWindowMinimized, onEditorWindowStateChanged } from './serverWindowLifecycle';

const window = () => ({ isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
  minimize: vi.fn(), restore: vi.fn(), hide: vi.fn(), show: vi.fn(), focus: vi.fn() });
describe('remote Wayland window lifecycle', () => {
  it('minimizes the remote viewer without unmapping the native surface', () => {
    const w = window(), changed = vi.fn(); onEditorWindowStateChanged(w, changed);
    minimizeEditorWindow(w, true);
    expect(editorWindowMinimized(w, true)).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(w.hide).not.toHaveBeenCalled(); expect(w.minimize).not.toHaveBeenCalled();
    restoreEditorWindow(w, true);
    expect(editorWindowMinimized(w, true)).toBe(false);
  });
  it('restores a hidden remote window', () => {
    const w = { ...window(), isVisible: () => false };
    expect(editorWindowMinimized(w, true)).toBe(true);
    restoreEditorWindow(w, true);
    expect(w.show).toHaveBeenCalledOnce(); expect(w.focus).toHaveBeenCalledOnce();
  });
  it('preserves ordinary desktop minimization', () => {
    const w = window(); minimizeEditorWindow(w, false);
    expect(w.minimize).toHaveBeenCalledOnce(); expect(w.hide).not.toHaveBeenCalled();
  });
  it('remaps a window minimized by an earlier version', () => {
    const w = { ...window(), isMinimized: () => true };
    restoreEditorWindow(w, true);
    expect(w.restore).toHaveBeenCalledOnce(); expect(w.hide).toHaveBeenCalledOnce(); expect(w.show).toHaveBeenCalledOnce();
  });
});
