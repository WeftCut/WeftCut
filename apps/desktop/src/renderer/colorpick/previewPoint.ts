import type { PreviewFrame } from './previewSamplerRegistry';

/** A composition pixel's center → frozen input texel. No stretching or
 * edge clamping: transparent padding/outside the target has no input color. */
export function previewPoint(frame: PreviewFrame, x: number, y: number): { x: number; y: number } | null {
  if (frame.region) {
    const r = frame.region;
    x = Math.floor((x + .5 - r.x) * frame.width / r.width);
    y = Math.floor((y + .5 - r.y) * frame.height / r.height);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  if (frame.region && frame.pixels[(y * frame.width + x) * 4 + 3] === 0) return null;
  return { x, y };
}
