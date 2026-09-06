import { beforeAll, expect, it } from 'vitest';
import { initEval } from '../eval';
import { staticPosition, type XYPosition } from '../../shared/position';
import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY } from '../../shared/keyframe';
import { convertPosition, type ConversionOptions } from './positionConversion';
import { evaluatePosition } from './position';
beforeAll(initEval);
const options: ConversionOptions = { fpsNum: 30, fpsDen: 1, startFrame: 0, endFrame: 60, pathSamples: 61, everyFrames: 1 };
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
it('reports approximation error at a Hold jump rather than claiming a lossless conversion', () => {
    const source = animated();
    if (source.x.mode === 'Keyframed')
        source.x.value[0]!.segment = { kind: 'Hold' };
    const result = convertPosition(source, { ...options, pathSamples: 2 });
    expect(result.maxErrorPx).toBeGreaterThan(299);
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
