import { expect, it } from 'vitest';
import { cropDelta, cropPoint, cropQuad } from './cropGeometry';
import { layerQuad } from './gizmoGeometry';

it('round trips mouse deltas through rotation, flip, nonuniform scale and arbitrary pivot', () => {
  for (const scaleX of [-2, 2]) for (const scaleY of [-0.5, 0.5]) for (const rotationDeg of [0, 39, 90]) {
    const q = layerQuad({ x: 125, y: -30, naturalW: 3840, naturalH: 2160, scaleX, scaleY, rotationDeg, anchorX: 0.13, anchorY: 0.78, origin: 'top-left' });
    const a = cropPoint(q, 0.1, 0.2), b = cropPoint(q, 0.3, 0.7);
    const d = cropDelta(q, b.x - a.x, b.y - a.y)!;
    expect(d.x).toBeCloseTo(0.2); expect(d.y).toBeCloseTo(0.5);
    expect(cropQuad(q, { x: 0.1, y: 0.2, w: 0.2, h: 0.5 })[2]).toEqual(cropPoint(q, 0.1 + 0.2, 0.2 + 0.5));
  }
});
