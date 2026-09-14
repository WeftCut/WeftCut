// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const trackListeners = () => vi.spyOn(window, 'addEventListener');
let listeners: ReturnType<typeof trackListeners>;
beforeEach(() => {
  vi.resetModules();
  listeners = trackListeners();
});
afterEach(() => {
  for (const [type, listener, options] of listeners.mock.calls) window.removeEventListener(type, listener, options);
  listeners.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mountOverlay() {
  document.body.innerHTML = '<canvas id="desktop"></canvas><div id="magnifier" hidden><canvas id="zoom"></canvas><span id="hex"></span></div><div id="hint"></div>';
  const api = { snapshot: async () => ({ png: new Uint8Array(), width: 2, height: 1,
    scaleFactor: devicePixelRatio, hint: 'Pick a color' }), ready: vi.fn(), failed: vi.fn(), hover: vi.fn(), finish: vi.fn() };
  vi.stubGlobal('screenPicker', api);
  vi.stubGlobal('createImageBitmap', async () => ({ width: 2, height: 1, close: vi.fn() }));
  const ctx = { drawImage: vi.fn(), getImageData: () => ({ width: 2, height: 1,
    data: new Uint8ClampedArray([18, 52, 160, 255, 255, 0, 0, 255]) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return this.id === 'desktop' ? ctx as unknown as ReturnType<HTMLCanvasElement['getContext']> : null;
  });
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  await import('./desktopOverlay');
  await vi.waitFor(() => expect(api.ready).toHaveBeenCalledOnce());
  return { api, mag: document.querySelector<HTMLDivElement>('#magnifier')!,
    move: (x = 0) => window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 0 })),
    paint: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); } };
}

it('hides the old screen magnifier immediately on viewport exit, even with a paint pending', async () => {
  const { api, mag, move, paint } = await mountOverlay();
  move(); paint();
  expect(mag.hidden).toBe(false);
  move(1); // A final in-bounds move can still be queued when crossing screens.
  document.documentElement.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
  document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
  expect(mag.hidden).toBe(true);
  paint();
  expect(mag.hidden).toBe(true);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(api.finish).not.toHaveBeenCalled();
  move(); paint();
  expect(mag.hidden).toBe(false);
  expect(api.hover).toHaveBeenCalledTimes(2); // Restore this screen's preview on re-entry.
  expect(api.failed).not.toHaveBeenCalled();
});

it('keeps the magnifier when the pointer moves between elements in the same screen', async () => {
  const { mag, move, paint } = await mountOverlay();
  move(); paint();
  document.querySelector('#desktop')!.dispatchEvent(new MouseEvent('pointerout', {
    bubbles: true, relatedTarget: document.documentElement,
  }));
  expect(mag.hidden).toBe(false);
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
