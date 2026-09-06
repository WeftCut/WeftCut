import { expect, it } from 'vitest';
import { fitMotionPath } from './pathFitting';
import { pathPointAt } from './pathGeometry';
it('fits a closed circle in traversal order with bounded measured residuals', () => {
  const points = Array.from({ length: 721 }, (_, i) => ({ x: 100 * Math.cos(i * Math.PI / 360), y: 100 * Math.sin(i * Math.PI / 360) }));
  let id = 0;
  const fit = fitMotionPath(points, 0.1, () => String(id++));
  expect(fit.limited).toBe(false);
  expect(fit.path.nodes.length).toBeLessThan(32);
  points.forEach((p, i) => {
    const t = fit.parameters[i]!, segment = Math.min(Math.floor(t), fit.path.nodes.length - 2);
    const q = pathPointAt(fit.path, segment, t - segment);
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThanOrEqual(0.1);
    if (i > 0) expect(t).toBeGreaterThanOrEqual(fit.parameters[i - 1]!);
  });
});
it('reports the node budget without silently discarding excess turns', () => {
  const points = Array.from({ length: 600 }, (_, i) => ({ x: i, y: i % 2 * 100 }));
  let id = 0;
  const fit = fitMotionPath(points, 0.01, () => String(id++));
  expect(fit.path.nodes).toHaveLength(128);
  expect(fit.limited).toBe(true);
});
it('keeps coincident samples finite and does not mutate source points', () => {
  const points = Array.from({ length: 100 }, () => ({ x: 4, y: 6 }));
  const original = structuredClone(points);
  const fit = fitMotionPath(points, 0.1, () => crypto.randomUUID());
  expect(fit.limited).toBe(false);
  expect(Array.from(fit.parameters).every(Number.isFinite)).toBe(true);
  expect(points).toEqual(original);
});
