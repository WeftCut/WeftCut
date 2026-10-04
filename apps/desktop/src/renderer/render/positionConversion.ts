import { HOLD_EXTRAPOLATION, keyTimeUs, type Animated, type Extrapolation, type Segment } from '../../shared/keyframe';
import { positionProblem, type PositionAnimation, type Point } from '../../shared/position';
import { CONVERSION_WASM_BASE64 } from '../eval/evalWasm.generated';

export interface ConversionOptions {
    fpsNum: number;
    fpsDen: number;
    /** Inclusive layer-local frame anchors; outside this range the result holds. */
    startFrame: number;
    endFrame: number;
    tolerancePx: number;
    /** Used only by explicit frame baking. */
    everyFrames: number;
    xyMode?: 'editable' | 'bake';
}
export interface PositionConversion {
    position: PositionAnimation;
    /** Largest output track count; static tracks have zero keys. */
    sampleCount: number;
    nodeCount: number;
    maxErrorPx: number;
    checkCount: number;
    withinTolerance: boolean;
    limit: 'node_limit' | 'key_limit' | 'frame_grid' | null;
}
export class PositionConversionError extends Error {
    constructor(readonly code: 'jump_error' | 'conversion_range_error' | 'conversion_options_error' | 'conversion_capacity_error') {
        super(code === 'conversion_capacity_error' ? 'Conversion exceeds 4096 keys per track or available memory.' : code);
    }
}

// Calculation DTOs use eval's existing Kf/Node/Segment records. IDs and editor
// tangent modes remain outside Rust; these are not new persistent project types.
interface ScalarKey { t_us: number; value: number; out: [number, number]; in_: [number, number]; segment: Segment }
interface ScalarTrack { keys: ScalarKey[]; extrapolate: Extrapolation }
interface Node { point: Point; incoming: Point; outgoing: Point; cubic: boolean }
interface Result extends Omit<PositionConversion, 'position'> { nodes: Node[] | null; tracks: ScalarTrack[] }
interface ConversionExports {
    memory: WebAssembly.Memory;
    conversion_input(length: number): number;
    conversion_run(): number;
    conversion_output(): number;
}
let instance: ConversionExports | undefined;
function engine(): ConversionExports {
    // Production invokes this only in the disposable worker. Tests exercise
    // the same Rust implementation, without a TS numerical fallback.
    instance ??= new WebAssembly.Instance(new WebAssembly.Module(
        Uint8Array.from(atob(CONVERSION_WASM_BASE64), c => c.charCodeAt(0)),
    )).exports as unknown as ConversionExports;
    return instance;
}
function pack(track: Animated<number>): ScalarTrack {
    return track.mode === 'Static'
        ? { keys: [{ t_us: 0, value: track.value, out: [1 / 3, 1 / 3], in_: [2 / 3, 2 / 3], segment: { kind: 'Linear' } }], extrapolate: HOLD_EXTRAPOLATION }
        : { keys: track.value.map(k => ({ t_us: keyTimeUs(k), value: k.value, out: [k.out.x, k.out.y], in_: [k.in.x, k.in.y], segment: k.segment })), extrapolate: track.extrapolate };
}
function unpack(track: ScalarTrack): Animated<number> {
    if (track.keys.length === 1) return { mode: 'Static', value: track.keys[0]!.value };
    return { mode: 'Keyframed', extrapolate: track.extrapolate, value: track.keys.map(k => ({
        id: crypto.randomUUID(), t_us: k.t_us, value: k.value, segment: k.segment,
        in: { x: k.in_[0], y: k.in_[1], mode: 'Free' },
        out: { x: k.out[0], y: k.out[1], mode: 'Free' }, continuity: 'Broken',
    })) };
}
/** Transport only: sampling, fitting, frame alignment and quality checks execute
 * in Rust in one call. No per-sample Wasm crossings or TS math fallback. */
export function convertPosition(source: PositionAnimation, options: ConversionOptions): PositionConversion {
    const problem = positionProblem(source);
    if (problem) throw new Error(problem);
    const input = new TextEncoder().encode(JSON.stringify({
        nodes: source.mode === 'Path' ? source.path.nodes.map(n => ({ point: n.point, incoming: n.in_handle, outgoing: n.out_handle, cubic: n.segment === 'Cubic' })) : null,
        tracks: (source.mode === 'Path' ? [source.progress] : [source.x, source.y]).map(pack), options,
    }));
    const e = engine();
    const ptr = e.conversion_input(input.length);
    new Uint8Array(e.memory.buffer, ptr, input.length).set(input);
    const length = e.conversion_run();
    const response = JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.conversion_output(), length))) as
        { ok: true; result: Result } | { ok: false; code: PositionConversionError['code'] };
    if (!response.ok) throw new PositionConversionError(response.code);
    const { nodes, tracks, ...report } = response.result;
    const position: PositionAnimation = nodes
        ? { mode: 'Path', path: { nodes: nodes.map(n => ({ id: crypto.randomUUID(), point: n.point,
            in_handle: n.incoming, out_handle: n.outgoing, tangent_mode: 'Corner', segment: n.cubic ? 'Cubic' : 'Line' })) }, progress: unpack(tracks[0]!) }
        : { mode: 'XY', x: unpack(tracks[0]!), y: unpack(tracks[1]!) };
    return { ...report, position };
}
