import { describe, expect, it } from 'vitest';
import type { LayerSummary } from '../ipc';
import { layerFrameAt, centerShift } from './centerInFrame';
import { layerQuad, layerPivot, scaleHandlePoints, solveScale, scaleCompensation, anchorCompensation, compDeltaToLocal, type LayerQuadInput } from './gizmoGeometry';
import { cropQuad } from './cropGeometry';
import { quadAabb, snapMove, snapTargets } from './previewSnap';

const crop = { x: 0.2, y: 0.1, w: 0.4, h: 0.7 };
const base: LayerQuadInput = { x: 100, y: 50, naturalW: 400, naturalH: 200, anchorX: 0.3, anchorY: 0.6, scaleX: 1.2, scaleY: 0.8, rotationDeg: 37, origin: 'top-left' };
function closePoints(actual: readonly { x: number; y: number }[], expected: readonly { x: number; y: number }[]) {
  actual.forEach((p, i) => { expect(p.x).toBeCloseTo(expected[i]!.x, 8); expect(p.y).toBeCloseTo(expected[i]!.y, 8); });
}

describe('cropped transform footprint', () => {
  it('reads crop and independent media flip flags from the layer', () => {
    const layer = { t_start_us: 0, params: { kind: 'VideoClip', crop, flip_h: true, flip_v: true } } as LayerSummary;
    const frame = layerFrameAt(layer, 0, { w: 400, h: 200 });
    expect(frame.visibleRect).toEqual(crop);
    expect(frame.flipX).toBe(true); expect(frame.flipY).toBe(true);
    expect(frame.scaleX).toBe(1); expect(frame.naturalW).toBe(400);
  });

  for (const flipX of [false, true]) for (const flipY of [false, true]) {
    it(`keeps crop, pivot and scale handles aligned with a rotated source (flip ${flipX}, ${flipY})`, () => {
      const source = { ...base, flipX, flipY };
      const frame = { ...source, visibleRect: crop };
      closePoints(layerQuad(frame), cropQuad(layerQuad(source), crop));
      expect(layerPivot(frame)).toEqual(layerPivot(source));
      for (const { id, at } of scaleHandlePoints(layerQuad(frame))!) {
        const same = solveScale(frame, id, at, layerPivot(frame), false)!;
        expect(same.scaleX).toBeCloseTo(base.scaleX, 8);
        expect(same.scaleY).toBeCloseTo(base.scaleY, 8);
      }
      const pivot = layerPivot(frame);
      const handle = scaleHandlePoints(layerQuad(frame))!.find(h => h.id === 'br')!.at;
      const target = { x: pivot.x + 1.5 * (handle.x - pivot.x), y: pivot.y + 1.5 * (handle.y - pivot.y) };
      const next = solveScale(frame, 'br', target, pivot, true)!;
      const fix = scaleCompensation(frame, next.scaleX, next.scaleY);
      const resized = { ...frame, ...next, x: frame.x + fix.x, y: frame.y + fix.y };
      closePoints([layerPivot(resized)], [pivot]);
      closePoints([scaleHandlePoints(layerQuad(resized))!.find(h => h.id === 'br')!.at], [target]);

      // Changing the original-source anchor must not displace visible pixels.
      const shift = anchorCompensation(frame, 0.12, -0.08);
      closePoints(layerQuad({ ...frame, x: frame.x + shift.x, y: frame.y + shift.y, anchorX: frame.anchorX! + 0.12, anchorY: frame.anchorY! - 0.08 }), layerQuad(frame));
      const q = layerQuad(source), dx = q[1].x - q[0].x, dy = q[1].y - q[0].y;
      closePoints([compDeltaToLocal({ x: dx, y: dy }, frame)!], [{ x: 400, y: 0 }]);
    });
  }

  it('centres and snaps the visible edge, and uses other cropped layers as snap targets', () => {
    const frame = { ...base, x: -78, y: 200, rotationDeg: 0, scaleX: 1, scaleY: 1, visibleRect: crop };
    const box = quadAabb(layerQuad(frame))!;
    expect(box.left).toBeCloseTo(2);
    const snapped = snapMove(box, snapTargets(1000, 800, []), 5);
    expect(snapped.dx).toBeCloseTo(-2);
    expect(snapped.guides.x).toBe(0);
    const shift = centerShift(frame, 1000, 800)!;
    const centered = quadAabb(layerQuad({ ...frame, x: frame.x + shift.x, y: frame.y + shift.y }))!;
    expect((centered.left + centered.right) / 2).toBeCloseTo(500);
    const other = quadAabb(layerQuad({ ...frame, x: 420 }))!;
    const target = snapMove({ left: other.left - 2, right: other.left + 98, top: 420, bottom: 520 }, snapTargets(1000, 800, [other]), 5);
    expect(target.guides.x).toBe(other.left);
  });
});
