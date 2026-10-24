import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PNG_CANVAS_RUNTIME_SOURCE } from './pngCanvasRuntime';

describe('PNG capture canvas backing', () => {
  it('requests CPU 2D storage before creation while preserving authored options and context identity', () => {
    const context = {};
    const get = vi.fn(function (this: unknown, ..._args: unknown[]) { return context; });
    class Canvas { getContext = get; }
    // Real canvases expose getContext on the prototype.
    Object.defineProperty(Canvas.prototype, 'getContext', { value: get, writable: true });
    runInNewContext(PNG_CANVAS_RUNTIME_SOURCE, { HTMLCanvasElement: Canvas, OffscreenCanvas: Canvas });
    const canvas = Object.create(Canvas.prototype) as Canvas;
    const options = { alpha: true, colorSpace: 'display-p3', willReadFrequently: false };
    expect(canvas.getContext('2d', options)).toBe(context);
    expect(get).toHaveBeenLastCalledWith('2d', { ...options, willReadFrequently: true });
    expect(get.mock.contexts.at(-1)).toBe(canvas);
    expect(options.willReadFrequently).toBe(false);
    canvas.getContext('2d');
    expect(get).toHaveBeenLastCalledWith('2d', { willReadFrequently: true });
  });

  it('does not change WebGL or bitmaprenderer context options', () => {
    const get = vi.fn();
    class Canvas {}
    Object.defineProperty(Canvas.prototype, 'getContext', { value: get, writable: true });
    runInNewContext(PNG_CANVAS_RUNTIME_SOURCE, { HTMLCanvasElement: Canvas });
    const canvas = new Canvas() as Canvas & { getContext: typeof get };
    for (const kind of ['webgl', 'webgl2', 'bitmaprenderer']) {
      const options = { alpha: false };
      canvas.getContext(kind, options);
      expect(get.mock.calls.at(-1)?.[1]).toBe(options);
    }
  });
});
