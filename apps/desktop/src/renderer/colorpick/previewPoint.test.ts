import { describe, expect, it } from 'vitest';
import { previewPoint } from './previewPoint';
import type { PreviewFrame } from './previewSamplerRegistry';

const frame = (): PreviewFrame => ({ pixels: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4,
  region: { x: 100, y: 50, width: 8, height: 8 } });

describe('effect input coordinates', () => {
  it('uses the actual texture origin and resolution, including pixel centers', () => {
    expect(previewPoint(frame(), 100, 50)).toEqual({ x: 0, y: 0 });
    expect(previewPoint(frame(), 103, 55)).toEqual({ x: 1, y: 2 });
    expect(previewPoint(frame(), 107, 57)).toEqual({ x: 3, y: 3 });
  });
  it('rejects outside and non-finite coordinates instead of clamping to an edge', () => {
    for (const [x, y] of [[99, 50], [108, 50], [100, 49], [100, 58], [NaN, 50]])
      expect(previewPoint(frame(), x!, y!)).toBeNull();
  });
  it('rejects transparent padding but preserves partially transparent shader inputs', () => {
    const f = frame(); f.pixels[3] = 0;
    expect(previewPoint(f, 100, 50)).toBeNull();
    f.pixels[3] = 128;
    expect(previewPoint(f, 100, 50)).toEqual({ x: 0, y: 0 });
  });
  it('keeps ordinary composition sampling unchanged', () => {
    const { region: _, ...f } = frame(); f.pixels[3] = 0;
    expect(previewPoint(f, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});
