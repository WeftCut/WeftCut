import { expect, it, vi } from 'vitest';
import { fitServerWindow } from './serverWindowFit';

function setup() {
  return { isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
    isMinimized: () => false, getBounds: () => ({ x: 0, y: 0, width: 960, height: 640 }), setBounds: vi.fn() };
}
const area = () => ({ x: 0, y: 0, width: 1920, height: 1048 });
it('fits a normal remote window to the work area, not the full output', () => {
  const win = setup(); fitServerWindow(win, area); expect(win.setBounds).toHaveBeenCalledWith(area());
});
it.each(['isDestroyed', 'isMaximized', 'isFullScreen', 'isMinimized'] as const)('never overrides compositor geometry when %s', method => {
  const win = setup(); win[method] = () => true;
  const read = vi.fn(area); fitServerWindow(win, read);
  expect(win.setBounds).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it('does not reconfigure an unchanged window', () => {
  const win = setup(); win.getBounds = area; fitServerWindow(win, area);
  expect(win.setBounds).not.toHaveBeenCalled();
});
