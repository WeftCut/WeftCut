import type { CropRect } from '../../shared/crop';
import type { Pt } from './gizmoGeometry';

/** Source-normalized -> composition/client, using the source's transformed
 * full quad. The same basis handles rotation, mirrored axes and proxy size. */
export function cropPoint(q: readonly Pt[], x: number, y: number): Pt {
  return { x: q[0]!.x + (q[1]!.x - q[0]!.x) * x + (q[3]!.x - q[0]!.x) * y,
    y: q[0]!.y + (q[1]!.y - q[0]!.y) * x + (q[3]!.y - q[0]!.y) * y };
}
export function cropQuad(q: readonly Pt[], r: CropRect): Pt[] {
  return [cropPoint(q, r.x, r.y), cropPoint(q, r.x + r.w, r.y), cropPoint(q, r.x + r.w, r.y + r.h), cropPoint(q, r.x, r.y + r.h)];
}
export function cropDelta(q: readonly Pt[], dx: number, dy: number): Pt | null {
  const ax = q[1]!.x - q[0]!.x, ay = q[1]!.y - q[0]!.y;
  const bx = q[3]!.x - q[0]!.x, by = q[3]!.y - q[0]!.y;
  const det = ax * by - ay * bx;
  return Math.abs(det) < 1e-12 ? null : { x: (dx * by - dy * bx) / det, y: (dy * ax - dx * ay) / det };
}
