// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const listeners = vi.spyOn(window, 'addEventListener');
afterEach(() => {
  for (const [type, listener, options] of listeners.mock.calls) window.removeEventListener(type, listener, options);
  listeners.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('becomes ready after decoding even when a hidden window receives no animation frames', async () => {
  document.body.innerHTML = '<canvas id="desktop"></canvas><div id="magnifier" hidden><canvas id="zoom"></canvas><span id="hex"></span></div><div id="hint"></div>';
  const ready = vi.fn(); const failed = vi.fn();
  vi.stubGlobal('screenPicker', { snapshot: async () => ({ png: new Uint8Array(), width: 1, height: 1,
    scaleFactor: devicePixelRatio, hint: 'Pick a color' }), ready, failed });
  // Electron can withhold frames while show:false, even when background
  // throttling is off and document.visibilityState reports visible.
  const raf = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', raf);
  let decode!: (bitmap: unknown) => void;
  const createBitmap = vi.fn(() => new Promise(resolve => { decode = resolve; }));
  vi.stubGlobal('createImageBitmap', createBitmap);
  const ctx = { drawImage: vi.fn(), getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray([18, 52, 160, 255]) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>);

  await import('./desktopOverlay');
  await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledOnce());
  expect(ready).not.toHaveBeenCalled(); // decoding really is a prerequisite
  const close = vi.fn();
  decode({ width: 1, height: 1, close });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 200, interval: 10 });
  expect(ctx.drawImage).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(document.querySelector('#hint')?.textContent).toBe('Pick a color');
  expect(failed).not.toHaveBeenCalled();
});
