import type { PositionAnimation, Point } from '../../shared/position';
import { resolveAnimated } from './animated';
import { evaluateMotionPath } from '../eval';
import { invalidatePositionPreview } from './transformOverrides';
const previews = new WeakMap<PositionAnimation, PositionAnimation>();
const listeners = new Set<() => void>();
let revision = 0;
export function subscribePositionPreviews(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function positionPreviewRevision() { return revision; }
export function setPositionPreview(source: PositionAnimation, preview: PositionAnimation | null): void {
    if ((previews.get(source) ?? null) === preview)
        return;
    if (preview)
        previews.set(source, preview);
    else
        previews.delete(source);
    revision++;
    listeners.forEach(listener => listener());
    invalidatePositionPreview();
}
export function previewPosition(source: PositionAnimation): PositionAnimation { return previews.get(source) ?? source; }
/** Layer-local time in; the existing per-kind position coordinates out. */
export function evaluatePosition(position: PositionAnimation, tUs: number): Point {
    if (position.mode === 'Path')
        return evaluateMotionPath(position.path, resolveAnimated(position.progress, tUs, 0));
    return { x: resolveAnimated(position.x, tUs, 0), y: resolveAnimated(position.y, tUs, 0) };
}
/** Offline sampling groups axis reads so dense XY tracks upload only once per
 * axis, instead of alternating two Wasm uploads at every error-check time. */
export function evaluatePositions(position: PositionAnimation, times: readonly number[]): Point[] {
    if (position.mode === 'Path')
        return times.map(at => evaluatePosition(position, at));
    const xs = times.map(at => resolveAnimated(position.x, at, 0));
    return times.map((at, i) => ({ x: xs[i]!, y: resolveAnimated(position.y, at, 0) }));
}
