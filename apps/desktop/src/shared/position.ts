import { MAX_RESIDENT_KEYFRAMES, type Animated } from './keyframe';
export interface Point {
    x: number;
    y: number;
}
export interface PathNode {
    id: string;
    point: Point;
    inHandle: Point;
    outHandle: Point;
    segment: 'Line' | 'Cubic';
    tangentMode: 'Corner' | 'Smooth' | 'Auto';
}
export interface MotionPath {
    nodes: PathNode[];
}
export interface XYPosition {
    mode: 'XY';
    x: Animated<number>;
    y: Animated<number>;
}
export interface PathPosition {
    mode: 'Path';
    path: MotionPath;
    progress: Animated<number>;
    x?: never;
    y?: never;
}
export type PositionAnimation = XYPosition | PathPosition;
export function staticPosition(x = 0, y = 0): XYPosition {
    return { mode: 'XY', x: { mode: 'Static', value: x }, y: { mode: 'Static', value: y } };
}
export function positionTrack(position: PositionAnimation, key: string): Animated<number> | null {
    if (position.mode === 'Path')
        return key === 'path_progress' ? position.progress : null;
    return key === 'x' || key === 'y' ? position[key] : null;
}
export function setPositionTrack(position: PositionAnimation, key: string, track: Animated<number>): boolean {
    if (position.mode === 'Path') {
        if (key !== 'path_progress')
            return false;
        position.progress = track;
        return true;
    }
    if (key !== 'x' && key !== 'y')
        return false;
    position[key] = track;
    return true;
}
export function visitPositionTracks(position: PositionAnimation, fn: (track: Animated<number>) => void): void {
    if (position.mode === 'Path')
        fn(position.progress);
    else {
        fn(position.x);
        fn(position.y);
    }
}
/** Axis projections exist for legacy view consumers, never as stored tracks. */
export function positionView(position: PositionAnimation) {
    if (position.mode === 'XY')
        return { position, x: position.x, y: position.y };
    const p = position.path.nodes[0]!.point;
    const axes = staticPosition(p.x, p.y);
    return { position, x: axes.x, y: axes.y, path_progress: position.progress };
}
export function translatePath(position: PathPosition, dx: number, dy: number): PathPosition {
    return { ...position, path: { nodes: position.path.nodes.map(n => ({ ...n, point: { x: n.point.x + dx, y: n.point.y + dy } })) } };
}
export function positionProblem(value: unknown): string | null {
    if (!value || typeof value !== 'object')
        return 'Position must be an XY or Path record';
    const p = value as PositionAnimation;
    const trackProblem = (a: Animated<number> | undefined): string | null => {
        if (!a || (a.mode !== 'Static' && a.mode !== 'Keyframed'))
            return 'Position requires scalar animation records';
        if (a.mode === 'Static')
            return Number.isFinite(a.value) ? null : 'Position values must be finite';
        if (!Array.isArray(a.value) || a.value.length === 0)
            return 'Position keyframe tracks must not be empty';
        const ids = new Set<string>();
        for (const k of a.value) {
            if (!k || typeof k.id !== 'string' || !k.id || ids.has(k.id) || !Number.isSafeInteger(k.t_us) || !Number.isFinite(k.value))
                return 'Position keys require unique ids, integer times and finite values';
            ids.add(k.id);
            if (!k.in || !k.out || ![k.in.x, k.in.y, k.out.x, k.out.y].every(Number.isFinite) || k.in.x < 0 || k.in.x > 1 || k.out.x < 0 || k.out.x > 1)
                return 'Position temporal tangents require finite coordinates and time fractions in 0–1';
            if (k.segment?.kind === 'Elastic' && (!Number.isFinite(k.segment.period) || k.segment.period <= 0 || !Number.isFinite(k.segment.amplitude) || k.segment.amplitude < 1))
                return 'Elastic requires a positive period and amplitude at least 1';
        }
        return null;
    };
    if (p.mode === 'XY')
        return 'path' in p || 'progress' in p ? 'XY cannot also carry a path' : trackProblem(p.x) ?? trackProblem(p.y);
    if (p.mode !== 'Path' || 'x' in p || 'y' in p)
        return 'Position must have exactly one active mode';
    if (!p.path || !Array.isArray(p.path.nodes) || p.path.nodes.length < 1 || p.path.nodes.length > 128)
        return 'A path requires 1–128 nodes';
    const ids = new Set<string>();
    for (const n of p.path.nodes) {
        if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id))
            return 'Path node ids must be unique nonempty strings';
        ids.add(n.id);
        if (n.segment !== 'Line' && n.segment !== 'Cubic')
            return 'Path segments must be Line or Cubic';
        if (!['Corner', 'Smooth', 'Auto'].includes(n.tangentMode))
            return 'Path node tangentMode must be Corner, Smooth or Auto';
        for (const v of [n.point, n.inHandle, n.outHandle])
            if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || Math.abs(v.x) > 1e7 || Math.abs(v.y) > 1e7)
                return 'Path coordinates must be finite and within 10 million pixels';
    }
    if (!p.progress || !['Static', 'Keyframed'].includes(p.progress.mode))
        return 'Path requires a progress track';
    const problem = trackProblem(p.progress);
    if (problem)
        return problem;
    if (p.progress.mode === 'Keyframed' && p.progress.value.length > MAX_RESIDENT_KEYFRAMES)
        return `Path progress supports at most ${MAX_RESIDENT_KEYFRAMES} keys`;
    if (p.progress.mode === 'Keyframed' && (!p.progress.extrapolate || ![p.progress.extrapolate.before, p.progress.extrapolate.after].every(v => ['Hold', 'Loop', 'PingPong'].includes(v))))
        return 'Path progress supports Hold, Loop and PingPong extrapolation';
    return null;
}
