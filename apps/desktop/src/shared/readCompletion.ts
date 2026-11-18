/** What one proof cost, in milliseconds: the one-pixel draw, which waits for
 * the copy, and the read of that pixel. */
export type ReadCompletionCost = { drawMs: number; readMs: number }

/** Returns a function that proves the GPU has run the copy `createImageBitmap`
 * recorded for a bitmap, so the shared texture it was read from may be
 * overwritten. Chromium's keyed mutex on that texture only excludes, it does
 * not order, and `createImageBitmap` resolves before the copy runs
 * (docs/notes/motif-texture-read-path-2026-11-06.md).
 *
 * The proof draws one source pixel on an accelerated canvas and reads it back:
 * the draw waits on the bitmap's sync token, so the read returns only after
 * the copy. Null means no 2D context exists and nothing was proven.
 *
 * LANDMINE: `willReadFrequently` must be explicitly false. Set to true, or
 * left unset (Chromium moves a canvas to the CPU after two readbacks), the
 * draw reads the whole frame back instead. */
export function createReadCompletionProof(): (bitmap: ImageBitmap) => ReadCompletionCost | null {
  let ctx: OffscreenCanvasRenderingContext2D | null | undefined
  return bitmap => {
    if (ctx === undefined) {
      ctx = typeof OffscreenCanvas === 'undefined'
        ? null
        : new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: false })
    }
    if (!ctx) return null
    const drawStart = performance.now()
    ctx.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1)
    const readStart = performance.now()
    ctx.getImageData(0, 0, 1, 1)
    return { drawMs: readStart - drawStart, readMs: performance.now() - readStart }
  }
}
