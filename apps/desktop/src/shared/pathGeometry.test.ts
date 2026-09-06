import { describe, expect, it } from 'vitest';
import type { MotionPath, PathNode } from './position';
import { editPathNode, insertPathNode, nearestPathLocation, pathPointAt, setPathNodeMode, solvePathGeometry } from './pathGeometry';

const node = (id: string, x: number, y: number): PathNode => ({ id, point: { x, y }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Cubic', tangentMode: 'Corner' });
const path = (): MotionPath => ({ nodes: [node('a', 0, 0), node('b', 100, 80), node('c', 200, 0)] });

describe('spatial authoring', () => {
  it('Auto creates aligned handles and follows moved neighbours without touching the input', () => {
    const original = path(), copy = structuredClone(original);
    const auto = setPathNodeMode(original, 1, 'Auto');
    expect(auto.nodes[1]!.inHandle.x).toBeLessThan(0);
    expect(auto.nodes[1]!.outHandle.x).toBeGreaterThan(0);
    expect(auto.nodes[1]!.outHandle.y).toBe(0);
    const moved = editPathNode(auto, 2, 'point', { x: 200, y: 100 });
    expect(moved.nodes[1]!.outHandle.y).toBeGreaterThan(0);
    expect(original).toEqual(copy);
    expect(solvePathGeometry(moved)).toEqual(moved);
  });
  it('dragging an Auto handle becomes Smooth and keeps the opposite length', () => {
    const auto = setPathNodeMode(path(), 1, 'Auto');
    const n = auto.nodes[1]!;
    const edited = editPathNode(auto, 1, 'inHandle', { x: -30, y: -40 }).nodes[1]!;
    expect(edited.tangentMode).toBe('Smooth');
    expect(edited.inHandle.x).toBeCloseTo(-30, 10);
    expect(edited.inHandle.y).toBeCloseTo(-40, 10);
    expect(Math.hypot(edited.outHandle.x, edited.outHandle.y)).toBeCloseTo(Math.hypot(n.outHandle.x, n.outHandle.y), 10);
    expect(edited.inHandle.x * edited.outHandle.y - edited.inHandle.y * edited.outHandle.x).toBeCloseTo(0, 10);
    const corner = setPathNodeMode(auto, 1, 'Corner');
    expect(editPathNode(corner, 1, 'inHandle', { x: 1, y: 9 }).nodes[1]!.outHandle).toEqual(n.outHandle);
  });
  it('handles a single point, coincident points and a reversal without NaN or loops', () => {
    for (const points of [[node('a', 0, 0)], [node('a', 0, 0), node('b', 0, 0)], [node('a', 0, 0), node('b', 100, 0), node('c', 0, 0)]]) {
      const solved = solvePathGeometry({ nodes: points.map(n => ({ ...n, tangentMode: 'Auto' })) });
      expect(solved.nodes.flatMap(n => [n.inHandle.x, n.inHandle.y, n.outHandle.x, n.outHandle.y]).every(Number.isFinite)).toBe(true);
      if (points.length === 3) expect(solved.nodes[1]!.outHandle).toEqual({ x: 0, y: 0 });
    }
  });
});

describe('shape-preserving insertion', () => {
  it.each([0.1, 0.37, 0.5, 0.9])('subdivides a curved Auto span at %f and survives the authoring solve', split => {
    const original = setPathNodeMode(setPathNodeMode(path(), 0, 'Auto'), 1, 'Auto');
    const inserted = solvePathGeometry(insertPathNode(original, 0, split, 'new'));
    expect(inserted.nodes.map(n => n.id)).toEqual(['a', 'new', 'b', 'c']);
    expect(inserted.nodes.slice(0, 3).map(n => n.tangentMode)).toEqual(['Smooth', 'Smooth', 'Smooth']);
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const old = pathPointAt(original, 0, t);
      const now = t <= split ? pathPointAt(inserted, 0, t / split) : pathPointAt(inserted, 1, (t - split) / (1 - split));
      expect(now.x).toBeCloseTo(old.x, 10); expect(now.y).toBeCloseTo(old.y, 10);
      const rest = pathPointAt(inserted, 2, t), oldRest = pathPointAt(original, 1, t);
      expect(rest.x).toBeCloseTo(oldRest.x, 10); expect(rest.y).toBeCloseTo(oldRest.y, 10);
    }
  });
  it('inserts into a line and locates a clicked curve point', () => {
    const line = path(); line.nodes[0]!.segment = 'Line';
    const inserted = insertPathNode(line, 0, 0.25, 'new');
    expect(inserted.nodes[1]!.point).toEqual({ x: 25, y: 20 });
    expect(inserted.nodes[1]!.segment).toBe('Line');
    const curved = setPathNodeMode(path(), 1, 'Auto');
    const hit = nearestPathLocation(curved, pathPointAt(curved, 0, 0.37))!;
    expect(hit.segment).toBe(0); expect(hit.t).toBeCloseTo(0.37, 5);
    expect(() => insertPathNode(line, 0, 0, 'new')).toThrow();
    expect(() => insertPathNode(line, 0, 0.5, 'a')).toThrow();
  });
});
