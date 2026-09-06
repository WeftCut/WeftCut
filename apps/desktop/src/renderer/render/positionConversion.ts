import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY, type Animated } from '../../shared/keyframe';
import { positionProblem, type PositionAnimation } from '../../shared/position';
import { MAX_KEYFRAMES } from '../eval';
import { evaluatePositions } from './position';
export interface ConversionOptions {
    fpsNum: number;
    fpsDen: number;
    /** Inclusive layer-local frame anchors; outside this range the result holds. */
    startFrame: number;
    endFrame: number;
    pathSamples: number;
    /** XY baking step on the composition's frame grid. */
    everyFrames: number;
}
export interface PositionConversion {
    position: PositionAnimation;
    sampleCount: number;
    maxErrorPx: number;
    checkCount: number;
}
/** Explicit, bounded approximation. No authoring state is touched. Error is a
 * measurement at frames, quarter-frames and authored jump boundaries, NOT a
 * continuous-time bound. Both directions use the same playback evaluator. */
export function convertPosition(source: PositionAnimation, options: ConversionOptions): PositionConversion {
    const { fpsNum, fpsDen, startFrame, endFrame, pathSamples, everyFrames } = options;
    if (![fpsNum, fpsDen].every(n => Number.isSafeInteger(n) && n > 0)
        || ![startFrame, endFrame].every(n => Number.isSafeInteger(n) && n >= 0)
        || endFrame <= startFrame || endFrame - startFrame > 16384)
        throw new Error('Choose a positive range of at most 16384 frames.');
    if (!Number.isInteger(pathSamples) || pathSamples < 2 || pathSamples > 128
        || !Number.isInteger(everyFrames) || everyFrames < 1)
        throw new Error('Use 2–128 path samples and a positive integer frame interval.');
    const tracks = source.mode === 'XY' ? [source.x, source.y] : [source.progress];
    if (tracks.some(t => t.mode === 'Keyframed' && t.value.length > MAX_KEYFRAMES))
        throw new Error(`Conversion supports at most ${MAX_KEYFRAMES} source keys per property.`);
    const time = (frame: number) => Math.round(frame * 1e6 * fpsDen / fpsNum);
    const firstUs = time(startFrame), lastUs = time(endFrame);
    const frames = new Set<number>([startFrame, endFrame]);
    if (source.mode === 'XY') {
        for (let i = 0; i < pathSamples; i++)
            frames.add(Math.round(startFrame + (endFrame - startFrame) * i / (pathSamples - 1)));
    }
    else {
        if (Math.ceil((endFrame - startFrame) / everyFrames) + 1 > MAX_KEYFRAMES)
            throw new Error(`Baking needs more than ${MAX_KEYFRAMES} keys. Shorten the range or increase the frame interval.`);
        for (let f = startFrame; f < endFrame; f += everyFrames)
            frames.add(f);
    }
    const times = [...frames].sort((a, b) => a - b).map(time);
    if (new Set(times).size !== times.length)
        throw new Error('Frame rate exceeds microsecond precision.');
    const points = evaluatePositions(source, times);
    const track = (values: number[]): Animated<number> => ({
        mode: 'Keyframed', extrapolate: { ...HOLD_EXTRAPOLATION },
        value: times.map((t_us, i) => ({
            id: crypto.randomUUID(), t_us, value: values[i]!,
            in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' },
            continuity: 'Broken', segment: { kind: 'Linear' },
        })),
    });
    let position: PositionAnimation;
    if (source.mode === 'XY') {
        const distances = [0];
        for (let i = 1; i < points.length; i++)
            distances.push(distances[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
        const total = distances.at(-1)!;
        position = {
            mode: 'Path',
            path: { nodes: points.map(point => ({ id: crypto.randomUUID(), point, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line' })) },
            progress: track(distances.map(d => total ? d / total : 0)),
        };
    }
    else
        position = { mode: 'XY', x: track(points.map(p => p.x)), y: track(points.map(p => p.y)) };
    const problem = positionProblem(position);
    if (problem)
        throw new Error(problem);
    const checks = new Set<number>(times);
    for (let f = startFrame; f <= endFrame; f += 0.25)
        checks.add(time(f));
    // Holds and procedural discontinuities can hide between uniform checks.
    for (const t of tracks)
        if (t.mode === 'Keyframed')
            for (const k of t.value)
                for (const at of [k.t_us - 1, k.t_us, k.t_us + 1])
                    if (at >= firstUs && at <= lastUs)
                        checks.add(at);
    let maxErrorPx = 0;
    const checkTimes = [...checks];
    const original = evaluatePositions(source, checkTimes), converted = evaluatePositions(position, checkTimes);
    for (let i = 0; i < checkTimes.length; i++) {
        const a = original[i]!, b = converted[i]!;
        maxErrorPx = Math.max(maxErrorPx, Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (!Number.isFinite(maxErrorPx))
        throw new Error('Cannot convert non-finite evaluated positions.');
    return { position, sampleCount: times.length, maxErrorPx, checkCount: checks.size };
}
