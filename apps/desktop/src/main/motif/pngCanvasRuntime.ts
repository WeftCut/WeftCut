/** Electron's bitmap OSR backend can omit accelerated 2D canvas layers after
 * navigation while both the DOM canvas and screenshot report success. Keep 2D
 * backing stores on CPU in this fallback host; the shared-texture host retains
 * accelerated canvases. Install before authored scripts create their contexts.
 * WebGL and bitmaprenderer contexts keep their original options and backend.
 * (The macOS empty-first-frame case was the host window's size, not the
 * canvas backend: capture.ts §setContentSize.) */
export const PNG_CANVAS_RUNTIME_SOURCE = String.raw`
(() => {
  for (const Canvas of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
    if (!Canvas) continue;
    const getContext = Canvas.prototype.getContext;
    Canvas.prototype.getContext = function (kind, options, ...rest) {
      return getContext.call(this, kind,
        kind === '2d' ? { ...options, willReadFrequently: true } : options, ...rest);
    };
  }
})();
`;
