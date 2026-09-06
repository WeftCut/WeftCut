import { beforeAll, expect, it } from 'vitest';
import { initEval } from '../eval';
import { staticPosition, type XYPosition } from '../../shared/position';
import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY } from '../../shared/keyframe';
import { convertPosition, type ConversionOptions } from './positionConversion';
import { evaluatePosition } from './position';
beforeAll(initEval);
const options: ConversionOptions = { fpsNum: 30, fpsDen: 1, startFrame: 0, endFrame: 60, tolerancePx: 1, everyFrames: 1 };
function animated(): XYPosition {
    return { mode: 'XY', y: { mode: 'Static', value: 22.1234567 }, x: {
            mode: 'Keyframed', extrapolate: HOLD_EXTRAPOLATION,
            value: [0, 1].map(v => ({ id: String(v), t_us: v * 2e6, value: 10 + v * 300,
                in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } })),
        } };
}
it('converts without changing source and preserves sampled frame positions in both directions', () => {
    const source = animated(), original = structuredClone(source);
    const path = convertPosition(source, options);
    const xy = convertPosition(path.position, options);
    expect(path.position.mode).toBe('Path');
    expect(xy.position.mode).toBe('XY');
    expect(path.maxErrorPx).toBeLessThan(1e-9);
    for (let frame = 0; frame <= 60; frame++) {
        const at = Math.round(frame * 1e6 / 30);
        expect(evaluatePosition(xy.position, at).x).toBeCloseTo(evaluatePosition(source, at).x, 9);
        expect(evaluatePosition(xy.position, at).y).toBe(22.1234567);
    }
    expect(source).toEqual(original);
});
it('handles a stationary path without dividing by zero', () => {
    const result = convertPosition(staticPosition(3, 8), options);
    expect(result.maxErrorPx).toBe(0);
    expect(evaluatePosition(result.position, 1e6)).toEqual({ x: 3, y: 8 });
});
it('refuses a Hold jump instead of connecting an instantaneous teleport', () => {
    const source = animated();
    if (source.x.mode === 'Keyframed')
        source.x.value[0]!.segment = { kind: 'Hold' };
    expect(() => convertPosition(source, options)).toThrow('jump_error');
});
it('uses exact fractional-rate frame anchors and holds outside the chosen range', () => {
    const result = convertPosition(animated(), { ...options, fpsNum: 30000, fpsDen: 1001, startFrame: 10, endFrame: 20 });
    expect(evaluatePosition(result.position, 0)).toEqual(evaluatePosition(animated(), Math.round(10e6 * 1001 / 30000)));
    expect(evaluatePosition(result.position, 9e6)).toEqual(evaluatePosition(animated(), Math.round(20e6 * 1001 / 30000)));
});
it('rejects invalid ranges and oversized baking instead of truncating', () => {
    expect(() => convertPosition(animated(), { ...options, endFrame: 0 })).toThrow();
    const path = convertPosition(animated(), options).position;
    expect(() => convertPosition(path, { ...options, endFrame: 5000 })).toThrow('4096');
});
it('evaluates every key in a dense 4096-sample bake and switches back to a short track', () => {
    const path = convertPosition(animated(), options).position;
    const result = convertPosition(path, { ...options, endFrame: 4095 });
    expect(result.sampleCount).toBe(4096);
    expect(evaluatePosition(result.position, Math.round(4095e6 / 30))).toEqual({ x: 310, y: 22.1234567 });
    expect(evaluatePosition(animated(), 1000000).x).toBe(160);
});
it('fits curved XY motion with a small editable cubic path and a measured quality target', () => {
    const source = animated();
    source.y = structuredClone(source.x);
    if (source.y.mode !== 'Keyframed') throw new Error('test setup');
    source.y.value[0]!.value = 0;
    source.y.value[1]!.value = 300;
    source.y.value[0]!.segment = { kind: 'Spline' };
    source.y.value[0]!.out.y = 0;
    source.y.value[1]!.in.y = 0;
    const result = convertPosition(source, { ...options, tolerancePx: 0.5 });
    expect(result.withinTolerance).toBe(true);
    expect(result.maxErrorPx).toBeLessThanOrEqual(0.5);
    expect(result.nodeCount).toBeLessThan(20);
    if (result.position.mode !== 'Path') throw new Error('expected path');
    expect(result.position.path.nodes.some(n => n.segment === 'Cubic')).toBe(true);
    for (let frame = 0.125; frame < 60; frame += 0.25) {
        const a = evaluatePosition(source, Math.round(frame * 1e6 / 30));
        const b = evaluatePosition(result.position, Math.round(frame * 1e6 / 30));
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.6);
    }
    const bake = convertPosition(result.position, { ...options, tolerancePx: 0.5, everyFrames: 30 });
    expect(bake.withinTolerance).toBe(true);
    expect(bake.sampleCount).toBeGreaterThan(3);
});
it('retains the order of retracing motion and PingPong extrapolation', () => {
    const source = animated();
    if (source.x.mode !== 'Keyframed') throw new Error('test setup');
    source.x.extrapolate = { before: 'Hold', after: 'PingPong' };
    const result = convertPosition(source, { ...options, endFrame: 180 });
    expect(result.withinTolerance).toBe(true);
    for (const at of [0, 1e6, 2e6, 3e6, 4e6, 5e6, 6e6]) {
        expect(evaluatePosition(result.position, at).x).toBeCloseTo(evaluatePosition(source, at).x, 5);
    }
});
it('refuses Loop jumps inside a range but accepts the original pre-wrap range', () => {
    const source = animated();
    if (source.x.mode !== 'Keyframed') throw new Error('test setup');
    source.x.extrapolate = { before: 'Loop', after: 'Loop' };
    expect(convertPosition(source, options).withinTolerance).toBe(true);
    expect(() => convertPosition(source, { ...options, endFrame: 180 })).toThrow('jump_error');
    expect(() => convertPosition(source, { ...options, startFrame: 60, endFrame: 90 })).toThrow('jump_error');
});
it('does not label an unrepresentable subframe excursion as meeting the target', () => {
    const source = animated();
    if (source.x.mode !== 'Keyframed') throw new Error('test setup');
    const prototype = source.x.value[0]!;
    source.x.value = [0, 8333, 16667, 33333].map((t_us, i) => ({ ...structuredClone(prototype), id: String(i), t_us, value: i === 1 ? 300 : 0 }));
    const result = convertPosition(source, { ...options, endFrame: 1, tolerancePx: 0.05 });
    expect(result.withinTolerance).toBe(false);
    expect(result.limit).toBe('frame_grid');
    expect(result.maxErrorPx).toBeGreaterThan(100);
});
