import { describe, expect, it } from 'vitest';
import { canonicalCrop, cropProblem, dragCrop, FULL_CROP, type CropHandle } from './crop';

describe('source crop', () => {
  it('preserves pixel inputs to better than 0.001 px on 8K sources', () => {
    for (const width of [1920, 3840, 7680, 8192]) {
      const result = canonicalCrop({ x: 1 / width, y: 0, w: 1 - 1 / width, h: 1 })!;
      expect(Math.abs(result.x * width - 1)).toBeLessThan(0.001);
      expect(cropProblem(result)).toBeNull();
    }
  });
  it('rejects malformed, empty and out-of-source rectangles; full frame resets', () => {
    for (const bad of [{ x: 0, y: 0, w: 0, h: 1 }, { x: -0.1, y: 0, w: 1, h: 1 },
      { x: 0.9, y: 0, w: 0.2, h: 1 }, { x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: '1', h: 1 }, []]) {
      expect(cropProblem(bad)).not.toBeNull();
    }
    expect(canonicalCrop(FULL_CROP)).toBeNull();
    expect(cropProblem(null)).toBeNull();
  });
  it('holds the opposite edge and clamps moves without resizing', () => {
    const r = { x: 0.2, y: 0.1, w: 0.6, h: 0.7 };
    expect(dragCrop(r, 'w', 0.1, 0)).toEqual({ x: 0.30000000000000004, y: 0.1, w: 0.5, h: 0.7 });
    const moved = dragCrop(r, 'move', 2, -2);
    expect(moved).toEqual({ ...r, x: 0.4, y: 0 });
  });
  it('keeps a nonempty rectangle inside the source at every handle, even past a boundary', () => {
    for (const r of [FULL_CROP, { x: 0.2, y: 0.1, w: 0.4, h: 0.7 }]) {
      for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as CropHandle[]) {
        for (const [dx, dy] of [[-2, -2], [2, 2], [0.1, -0.13]]) {
          const next = dragCrop(r, handle, dx!, dy!);
          expect(cropProblem(canonicalCrop(next)), JSON.stringify({ handle, next })).toBeNull();
        }
      }
    }
  });
});
