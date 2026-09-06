import type { MotionPath, PathNode, Point } from './position';

const zero = (): Point => ({ x: 0, y: 0 });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (p: Point, s: number): Point => ({ x: p.x * s, y: p.y * s });
const length = (p: Point) => Math.hypot(p.x, p.y);
const unit = (p: Point): Point => length(p) > 1e-12 ? scale(p, 1 / length(p)) : zero();
const mix = (a: Point, b: Point, t: number) => add(scale(a, 1 - t), scale(b, t));

function smoothNode(n: PathNode): PathNode {
  if (length(n.outHandle) > 1e-12)
    return { ...n, inHandle: scale(unit(n.outHandle), -length(n.inHandle)) };
  return n;
}

/** Author-time only. Stored explicit handles remain the playback truth. */
export function solvePathGeometry(path: MotionPath): MotionPath {
  return { nodes: path.nodes.map((n, i, nodes) => {
    if (n.tangentMode === 'Smooth') return smoothNode(n);
    if (n.tangentMode !== 'Auto') return n;
    const before = i > 0 ? sub(n.point, nodes[i - 1]!.point) : zero();
    const after = i + 1 < nodes.length ? sub(nodes[i + 1]!.point, n.point) : zero();
    // Unit-chord bisector: no distant neighbour can dominate the direction.
    // At a reversal the bisector is zero, making a stationary turnaround.
    const direction = unit(add(unit(before), unit(after)));
    return { ...n, inHandle: scale(direction, -length(before) / 3), outHandle: scale(direction, length(after) / 3) };
  }) };
}

function checkNode(path: MotionPath, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= path.nodes.length) throw new Error('Path node does not exist');
}

export function setPathNodeMode(path: MotionPath, index: number, mode: PathNode['tangentMode']): MotionPath {
  checkNode(path, index);
  if (!['Corner', 'Smooth', 'Auto'].includes(mode)) throw new Error('Invalid spatial node mode');
  const nodes = path.nodes.map(n => ({ ...n }));
  const node = nodes[index]!;
  node.tangentMode = mode;
  if (mode !== 'Corner') {
    if (index > 0) nodes[index - 1]!.segment = 'Cubic';
    if (index < nodes.length - 1) node.segment = 'Cubic';
    if (mode === 'Smooth' && length(node.inHandle) + length(node.outHandle) < 1e-12) {
      const auto = solvePathGeometry({ nodes: nodes.map((n, i) => i === index ? { ...n, tangentMode: 'Auto' } : n) }).nodes[index]!;
      node.inHandle = auto.inHandle; node.outHandle = auto.outHandle;
    }
  }
  return solvePathGeometry({ nodes });
}

/** Point is absolute; handles are relative. Dragging an Auto handle takes
 * explicit control and becomes Smooth, retaining the opposite handle length. */
export function editPathNode(path: MotionPath, index: number, part: 'point' | 'inHandle' | 'outHandle', value: Point): MotionPath {
  checkNode(path, index);
  if (![value.x, value.y].every(Number.isFinite)) throw new Error('Path coordinates must be finite');
  const nodes = path.nodes.map(n => ({ ...n }));
  const node = nodes[index]!;
  node[part] = value;
  if (part !== 'point' && node.tangentMode !== 'Corner') {
    node.tangentMode = 'Smooth';
    const opposite = part === 'inHandle' ? 'outHandle' : 'inHandle';
    node[opposite] = scale(unit(value), -length(node[opposite]));
  }
  return solvePathGeometry({ nodes });
}

export function pathPointAt(path: MotionPath, segment: number, t: number): Point {
  const a = path.nodes[segment]!, b = path.nodes[segment + 1]!;
  if (a.segment === 'Line') return mix(a.point, b.point, t);
  const q0 = mix(a.point, add(a.point, a.outHandle), t);
  const q1 = mix(add(a.point, a.outHandle), add(b.point, b.inHandle), t);
  const q2 = mix(add(b.point, b.inHandle), b.point, t);
  return mix(mix(q0, q1, t), mix(q1, q2, t), t);
}

/** Algebraically exact subdivision. Freeze adjacent Auto nodes so the next
 * authoring solve cannot replace the newly subdivided controls. */
export function insertPathNode(path: MotionPath, segment: number, t: number, id: string): MotionPath {
  checkNode(path, segment);
  if (segment >= path.nodes.length - 1 || !Number.isFinite(t) || t <= 0 || t >= 1) throw new Error('Insert inside an existing segment');
  if (path.nodes.length >= 128) throw new Error('A path supports at most 128 nodes');
  if (!id || path.nodes.some(n => n.id === id)) throw new Error('The inserted node needs a unique id');
  const nodes = path.nodes.map(n => ({ ...n }));
  const a = nodes[segment]!, b = nodes[segment + 1]!;
  const inserted: PathNode = { id, point: mix(a.point, b.point, t), inHandle: zero(), outHandle: zero(), segment: a.segment, tangentMode: 'Corner' };
  if (a.segment === 'Cubic') {
    const q0 = mix(a.point, add(a.point, a.outHandle), t);
    const q1 = mix(add(a.point, a.outHandle), add(b.point, b.inHandle), t);
    const q2 = mix(add(b.point, b.inHandle), b.point, t);
    const r0 = mix(q0, q1, t), r1 = mix(q1, q2, t);
    inserted.point = mix(r0, r1, t);
    inserted.inHandle = sub(r0, inserted.point); inserted.outHandle = sub(r1, inserted.point);
    inserted.tangentMode = 'Smooth';
    a.outHandle = sub(q0, a.point); b.inHandle = sub(q2, b.point);
  }
  if (a.tangentMode === 'Auto') a.tangentMode = 'Smooth';
  if (b.tangentMode === 'Auto') b.tangentMode = 'Smooth';
  nodes.splice(segment + 1, 0, inserted);
  return { nodes };
}

/** Hit-test helper, not the arc-length evaluator. Search each span before
 * refining the nearest sample's neighbourhood (also handles loops/cusps). */
export function nearestPathLocation(path: MotionPath, point: Point): { segment: number; t: number; distance: number } | null {
  let best: { segment: number; t: number; distance: number } | null = null;
  for (let segment = 0; segment < path.nodes.length - 1; segment++) {
    const distance = (t: number) => length(sub(pathPointAt(path, segment, t), point));
    let sample = 0;
    for (let i = 1; i <= 64; i++) if (distance(i / 64) < distance(sample / 64)) sample = i;
    let lo = Math.max(0, (sample - 1) / 64), hi = Math.min(1, (sample + 1) / 64);
    for (let i = 0; i < 28; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (distance(a) < distance(b)) hi = b; else lo = a;
    }
    const t = (lo + hi) / 2, d = distance(t);
    if (!best || d < best.distance) best = { segment, t, distance: d };
  }
  return best;
}
