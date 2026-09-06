import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY, type Animated } from '../../shared/keyframe';
import { positionProblem, type MotionPath, type PositionAnimation } from '../../shared/position';
import { fitMotionPath } from '../../shared/pathFitting';
import { pathPointAt } from '../../shared/pathGeometry';
import { compileMotionPath, evaluateMotionPath, MAX_KEYFRAMES } from '../eval';
import { evaluatePositions } from './position';

export interface ConversionOptions {
    fpsNum: number;
    fpsDen: number;
    /** Inclusive layer-local frame anchors; outside this range the result holds. */
    startFrame: number;
    endFrame: number;
    tolerancePx: number;
    /** Initial maximum XY baking interval; quality checks may add more keys. */
    everyFrames: number;
}
export interface PositionConversion {
    position: PositionAnimation;
    sampleCount: number;
    nodeCount: number;
    maxErrorPx: number;
    checkCount: number;
    withinTolerance: boolean;
    limit: 'node_limit' | 'key_limit' | 'frame_grid' | null;
}
export class PositionConversionError extends Error {
    constructor(readonly code: 'jump_error' | 'conversion_range_error' | 'conversion_options_error' | 'conversion_capacity_error') {
        super(code === 'conversion_capacity_error' ? `Conversion exceeds ${MAX_KEYFRAMES} keys or the bounded check budget.` : code);
    }
}

/** Fold authored boundaries into the requested interval, including repetitions.
 * A continuous fit cannot faithfully represent an instantaneous spatial jump. */
function criticalTimes(source: PositionAnimation, start: number, end: number): number[] {
    const times: number[] = [];
    const tracks = source.mode === 'XY' ? [source.x, source.y] : [source.progress];
    const jumps = (a: number, b: number) => {
        if (source.mode === 'XY') return Math.abs(a - b) > 1e-9;
        const p = evaluateMotionPath(source.path, a), q = evaluateMotionPath(source.path, b);
        return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9;
    };
    for (const track of tracks) {
        if (track.mode !== 'Keyframed' || track.value.length < 2) continue;
        const keys = track.value, first = keys[0]!.t_us, last = keys.at(-1)!.t_us, period = last - first;
        if (period <= 0) continue;
        const repeating = (mode: string) => ['Loop', 'PingPong', 'Offset'].includes(mode);
        const low = repeating(track.extrapolate.before) ? Math.min(0, Math.floor((start - first) / period) - 1) : 0;
        const high = repeating(track.extrapolate.after) ? Math.max(0, Math.ceil((end - first) / period) + 1) : 0;
        if (high - low > 65536 || (high - low) * keys.length > 262144)
            throw new PositionConversionError('conversion_capacity_error');
        for (let cycle = low; cycle <= high; cycle++) {
            const mode = cycle < 0 ? track.extrapolate.before : track.extrapolate.after;
            if (cycle !== 0 && !['Loop', 'PingPong', 'Offset'].includes(mode)) continue;
            const reverse = cycle !== 0 && mode === 'PingPong' && Math.abs(cycle % 2) === 1;
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]!, at = first + cycle * period + (reverse ? last - key.t_us : key.t_us - first);
                if (at >= start && at <= end) times.push(at);
                if (i > 0 && keys[i - 1]!.segment.kind === 'Hold' && jumps(keys[i - 1]!.value, key.value)
                    && (reverse ? at >= start && at < end : at > start && at <= end))
                    throw new PositionConversionError('jump_error');
            }
            const seam = first + cycle * period;
            const seamMode = cycle <= 0 ? track.extrapolate.before : track.extrapolate.after;
            if (seamMode === 'Loop' && jumps(keys[0]!.value, keys.at(-1)!.value)
                && seam > start && seam <= end && !(cycle === 1 && seam === end))
                throw new PositionConversionError('jump_error');
        }
        if (start === last && end > start && track.extrapolate.after === 'Loop' && jumps(keys[0]!.value, keys.at(-1)!.value))
            throw new PositionConversionError('jump_error');
    }
    return times;
}

/** Map fitted Bezier parameters to the very same distance table used in playback.
 * Project the evaluated point within its flattened chord: interpolating t alone
 * would give incorrect distance even on a straight cubic with uneven handles. */
function progressAtParameter(path: MotionPath, parameter: number): number {
    const { samples, length } = compileMotionPath(path);
    if (length === 0 || parameter <= 0) return 0;
    if (parameter >= path.nodes.length - 1) return 1;
    let low = 1, high = samples.length / 4 - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (samples[mid * 4 + 3]! < parameter) low = mid + 1; else high = mid; }
    const a = (low - 1) * 4, b = low * 4, segment = Math.floor(parameter);
    const p = pathPointAt(path, segment, parameter - segment);
    const dx = samples[b]! - samples[a]!, dy = samples[b + 1]! - samples[a + 1]!, squared = dx * dx + dy * dy;
    const u = squared > 0 ? Math.max(0, Math.min(1, ((p.x - samples[a]!) * dx + (p.y - samples[a + 1]!) * dy) / squared)) : 0;
    return (samples[a + 2]! + u * (samples[b + 2]! - samples[a + 2]!)) / length;
}

/** Bounded cubic fitting + adaptive temporal refinement, with no authoring writes.
 * Error is measured at quarter-frames and folded key/jump boundaries; it is NOT
 * a continuous-time guarantee. Failed targets remain previewable, not applicable. */
export function convertPosition(source: PositionAnimation, options: ConversionOptions): PositionConversion {
    const { fpsNum, fpsDen, startFrame, endFrame, tolerancePx, everyFrames } = options;
    if (![fpsNum, fpsDen].every(n => Number.isSafeInteger(n) && n > 0)
        || ![startFrame, endFrame].every(n => Number.isSafeInteger(n) && n >= 0)
        || endFrame <= startFrame || endFrame - startFrame > 16384)
        throw new PositionConversionError('conversion_range_error');
    if (!Number.isFinite(tolerancePx) || tolerancePx < 0.05 || !Number.isInteger(everyFrames) || everyFrames < 1)
        throw new PositionConversionError('conversion_options_error');
    const problem = positionProblem(source);
    if (problem) throw new Error(problem);
    const tracks = source.mode === 'XY' ? [source.x, source.y] : [source.progress];
    if (tracks.some(t => t.mode === 'Keyframed' && t.value.length > MAX_KEYFRAMES))
        throw new PositionConversionError('conversion_capacity_error');
    const time = (frame: number) => Math.round(frame * 1e6 * fpsDen / fpsNum);
    const firstUs = time(startFrame), lastUs = time(endFrame);
    if (!Number.isSafeInteger(lastUs) || time(startFrame + 0.25) <= firstUs)
        throw new PositionConversionError('conversion_range_error');
    const checks = new Set<number>();
    for (let f = startFrame; f <= endFrame; f += 0.25) checks.add(time(f));
    for (const boundary of criticalTimes(source, firstUs, lastUs))
        for (const at of [boundary - 1, boundary, boundary + 1]) if (at >= firstUs && at <= lastUs) checks.add(at);
    const times = [...checks].sort((a, b) => a - b), original = evaluatePositions(source, times);
    const indices = new Map(times.map((t, i) => [t, i]));
    const fit = source.mode === 'XY' ? fitMotionPath(original, tolerancePx * 0.35, () => crypto.randomUUID()) : null;
    const values = fit ? [Array.from(fit.parameters, p => progressAtParameter(fit.path, p))]
        : [original.map(p => p.x), original.map(p => p.y)];
    const slopes = values.map(axis => axis.map((_, i) => {
        const a = Math.max(0, i - 1), b = Math.min(times.length - 1, i + 1);
        return (axis[b]! - axis[a]!) / (times[b]! - times[a]!);
    }));
    const selected = new Set<number>([startFrame, endFrame]);
    if (!fit) {
        if (Math.ceil((endFrame - startFrame) / everyFrames) + 1 > MAX_KEYFRAMES)
            throw new PositionConversionError('conversion_capacity_error');
        for (let f = startFrame; f < endFrame; f += everyFrames) selected.add(f);
    }
    const track = (axis: number, frames: number[]): Animated<number> => {
        const keys = frames.map(f => ({
            id: crypto.randomUUID(), t_us: time(f), value: values[axis]![indices.get(time(f))!]!,
            in: { ...IN_IDENTITY, mode: 'Free' as const }, out: { ...OUT_IDENTITY, mode: 'Free' as const },
            continuity: 'Broken' as const, segment: { kind: 'Linear' as 'Linear' | 'Spline' },
        }));
        for (let i = 0; i + 1 < keys.length; i++) {
            const a = keys[i]!, b = keys[i + 1]!, dv = b.value - a.value, dt = b.t_us - a.t_us;
            if (Math.abs(dv) < 1e-12) continue;
            const clamp = (y: number) => fit ? Math.max(0, Math.min(1, y)) : y;
            a.segment = { kind: 'Spline' };
            a.out.y = clamp(slopes[axis]![indices.get(a.t_us)!]! * dt / (3 * dv));
            b.in.y = clamp(1 - slopes[axis]![indices.get(b.t_us)!]! * dt / (3 * dv));
            if (Math.abs(a.out.y - OUT_IDENTITY.y) < 1e-9 && Math.abs(b.in.y - IN_IDENTITY.y) < 1e-9) {
                a.segment = { kind: 'Linear' };
                a.out.y = OUT_IDENTITY.y;
                b.in.y = IN_IDENTITY.y;
            }
        }
        return { mode: 'Keyframed', extrapolate: { ...HOLD_EXTRAPOLATION }, value: keys };
    };
    for (let attempt = 0; ; attempt++) {
        const frames = [...selected].sort((a, b) => a - b);
        const position: PositionAnimation = fit ? { mode: 'Path', path: fit.path, progress: track(0, frames) }
            : { mode: 'XY', x: track(0, frames), y: track(1, frames) };
        const invalid = positionProblem(position);
        if (invalid) throw new Error(invalid);
        const converted = evaluatePositions(position, times);
        let maxErrorPx = 0, interval = 0;
        const worst = new Map<number, { error: number; at: number }>();
        for (let i = 0; i < times.length; i++) {
            const at = times[i]!, a = original[i]!, b = converted[i]!;
            const error = Math.hypot(a.x - b.x, a.y - b.y);
            if (!Number.isFinite(error)) throw new Error('Cannot convert non-finite positions.');
            maxErrorPx = Math.max(maxErrorPx, error);
            while (interval + 1 < frames.length - 1 && at > time(frames[interval + 1]!)) interval++;
            if (error > tolerancePx && error > (worst.get(interval)?.error ?? 0)) worst.set(interval, { error, at });
        }
        const result = (limit: PositionConversion['limit']): PositionConversion => ({
            position, sampleCount: frames.length, nodeCount: fit?.path.nodes.length ?? 0,
            maxErrorPx, checkCount: times.length, withinTolerance: maxErrorPx <= tolerancePx, limit,
        });
        if (maxErrorPx <= tolerancePx) return result(null);
        if (fit?.limited) return result('node_limit');
        const additions = new Set<number>();
        for (const [span, { at }] of worst) {
            const f = at * fpsNum / (1e6 * fpsDen);
            for (const next of [Math.floor(f), Math.ceil(f), Math.floor((frames[span]! + frames[span + 1]!) / 2)])
                if (next > startFrame && next < endFrame && !selected.has(next)) additions.add(next);
        }
        if (!additions.size || attempt >= 32) return result('frame_grid');
        if (selected.size + additions.size > MAX_KEYFRAMES) return result('key_limit');
        for (const f of additions) selected.add(f);
    }
}
