import type { MotionPath, PathNode, Point } from './position';

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const length = (p: Point) => Math.hypot(p.x, p.y);
const unit = (p: Point): Point => length(p) > 1e-12 ? { x: p.x / length(p), y: p.y / length(p) } : { x: 0, y: 0 };
interface FitSpan { first: number; last: number; out: Point; incoming: Point; error: number; split: number; line: boolean }
export interface FittedPath { path: MotionPath; parameters: Float64Array; limited: boolean }

/** Ordered least-squares cubic fitting, splitting the worst span until its
 * sampled spatial error meets the budget. Parameters follow travelled chord
 * distance, not X order, so turns, retracing and loops retain their order. */
export function fitMotionPath(points: readonly Point[], tolerance: number, newId: () => string): FittedPath {
  if (!points.length || !Number.isFinite(tolerance) || tolerance <= 0) throw new Error('Invalid path fitting input');
  const cumulative = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) cumulative[i] = cumulative[i - 1]! + length(sub(points[i]!, points[i - 1]!));
  const parameter = (i: number, a: number, b: number) => {
    const total = cumulative[b]! - cumulative[a]!;
    return total > 1e-12 ? (cumulative[i]! - cumulative[a]!) / total : 0;
  };
  const fit = (first: number, last: number): FitSpan => {
    const p = points[first]!, q = points[last]!;
    let next = first + 1, previous = last - 1;
    while (next < last && length(sub(points[next]!, p)) < 1e-12) next++;
    while (previous > first && length(sub(points[previous]!, q)) < 1e-12) previous--;
    const left = unit(sub(points[Math.min(next, last)]!, p)), right = unit(sub(points[Math.max(previous, first)]!, q));
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = first; i <= last; i++) {
      const u = parameter(i, first, last), v = 1 - u;
      const b0 = v * v * v, b1 = 3 * u * v * v, b2 = 3 * u * u * v, b3 = u * u * u;
      const residual = { x: points[i]!.x - p.x * (b0 + b1) - q.x * (b2 + b3), y: points[i]!.y - p.y * (b0 + b1) - q.y * (b2 + b3) };
      c00 += b1 * b1; c01 += dot(left, right) * b1 * b2; c11 += b2 * b2;
      x0 += dot(left, residual) * b1; x1 += dot(right, residual) * b2;
    }
    const det = c00 * c11 - c01 * c01, distance = cumulative[last]! - cumulative[first]!;
    let a = det > 1e-12 ? (x0 * c11 - x1 * c01) / det : distance / 3;
    let b = det > 1e-12 ? (x1 * c00 - x0 * c01) / det : distance / 3;
    if (a < 0 || b < 0 || a > distance * 3 || b > distance * 3) a = b = distance / 3;
    const out = { x: left.x * a, y: left.y * a }, incoming = { x: right.x * b, y: right.y * b };
    let error = 0, lineError = 0, split = Math.floor((first + last) / 2);
    for (let i = first + 1; i < last; i++) {
      const u = parameter(i, first, last), v = 1 - u, b1 = 3 * u * v * v, b2 = 3 * u * u * v;
      const x = p.x * (v * v * v + b1) + out.x * b1 + q.x * (u * u * u + b2) + incoming.x * b2;
      const y = p.y * (v * v * v + b1) + out.y * b1 + q.y * (u * u * u + b2) + incoming.y * b2;
      const e = Math.hypot(x - points[i]!.x, y - points[i]!.y);
      if (e > error) { error = e; split = i; }
      lineError = Math.max(lineError, Math.hypot(p.x + (q.x - p.x) * u - points[i]!.x, p.y + (q.y - p.y) * u - points[i]!.y));
    }
    const line = lineError <= tolerance;
    return { first, last, out, incoming, error: line ? lineError : error, split, line };
  };
  const spans = [fit(0, points.length - 1)];
  while (spans.length < 127) {
    let worst = -1;
    for (let i = 0; i < spans.length; i++) if (spans[i]!.error > tolerance && (worst < 0 || spans[i]!.error > spans[worst]!.error)) worst = i;
    if (worst < 0) break;
    const s = spans[worst]!;
    if (s.split <= s.first || s.split >= s.last) break;
    spans.splice(worst, 1, fit(s.first, s.split), fit(s.split, s.last));
  }
  const node = (point: Point): PathNode => ({ id: newId(), point, in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line', tangent_mode: 'Corner' });
  const nodes = [node(points[0]!)], parameters = new Float64Array(points.length);
  spans.forEach((s, segment) => {
    const a = nodes.at(-1)!, b = node(points[s.last]!);
    if (!s.line) { a.segment = 'Cubic'; a.out_handle = s.out; b.in_handle = s.incoming; }
    nodes.push(b);
    for (let i = s.first; i <= s.last; i++) parameters[i] = segment + parameter(i, s.first, s.last);
  });
  return { path: { nodes }, parameters, limited: spans.some(s => s.error > tolerance) };
}
