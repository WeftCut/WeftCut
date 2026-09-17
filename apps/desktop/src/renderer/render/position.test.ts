import { beforeAll, describe, expect, it } from 'vitest';
import { initEval, compileMotionPath, evaluateMotionPath } from '../eval';
import { evaluatePosition } from './position';
import { staticPosition, type MotionPath, type PathPosition } from '../../shared/position';
import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY } from '../../shared/keyframe';
beforeAll(initEval);
const path: MotionPath = { nodes: [{ tangent_mode: 'Corner' as const, id: 'a', point: { x: 0, y: 0 }, in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line' }, { tangent_mode: 'Corner' as const, id: 'b', point: { x: 10, y: 0 }, in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line' }, { tangent_mode: 'Corner' as const, id: 'c', point: { x: 10, y: 90 }, in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line' }] };
const position: PathPosition = { mode: 'Path', path, progress: { mode: 'Keyframed', extrapolate: HOLD_EXTRAPOLATION, value: [0, 1].map((value) => ({ id: String(value), t_us: value * 1e6, value, in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } })) } };
describe('position evaluation across the real Wasm seam', () => {
    it('retains XY coordinates and walks by distance', () => {
        expect(evaluatePosition(staticPosition(32, 45), 200)).toEqual({ x: 32, y: 45 });
        expect(evaluatePosition(position, 500000)).toEqual({ x: 10, y: 40 });
        expect(evaluatePosition(position, 2e6)).toEqual({ x: 10, y: 90 });
    });
    it('reuses compiled geometry when progress changes and restores resident buffers between layers', () => {
        const original = compileMotionPath(path);
        const other: MotionPath = { nodes: path.nodes.map(n => ({ ...n, point: { x: n.point.x + 100, y: n.point.y } })) };
        expect(evaluateMotionPath(other, 0.5)).toEqual({ x: 110, y: 40 });
        expect(evaluateMotionPath(path, 0.5)).toEqual({ x: 10, y: 40 });
        expect(compileMotionPath(path)).toBe(original);
    });
    it('preserves loop timing after a local-time rebase', () => {
        const loop: PathPosition = { ...position, progress: { ...position.progress, mode: 'Keyframed', extrapolate: { before: 'Loop', after: 'Loop' }, value: position.progress.mode === 'Keyframed' ? position.progress.value : [] } };
        const right: PathPosition = { ...loop, progress: { ...loop.progress, mode: 'Keyframed', extrapolate: { before: 'Loop', after: 'Loop' }, value: loop.progress.mode === 'Keyframed' ? loop.progress.value.map(k => ({ ...k, t_us: k.t_us - 400000 })) : [] } };
        for (const time of [400000, 500000, 999999, 1000000, 1750000])
            expect(evaluatePosition(right, time - 400000)).toEqual(evaluatePosition(loop, time));
    });
    it('extends overshoot along endpoint directions', () => {
        expect(evaluateMotionPath(path, -0.1)).toEqual({ x: -10, y: 0 });
        expect(evaluateMotionPath(path, 1.1).y).toBeCloseTo(100, 10);
    });
});
