import type { MotionPath } from '../../shared/position';
import { pathPointAt } from '../../shared/pathGeometry';
import { compileMotionPath } from '../eval';

/** Map fitted Bezier parameters to the very same distance table used in playback.
 * Project the evaluated point within its flattened chord: interpolating t alone
 * would give incorrect distance even on a straight cubic with uneven handles. */
export function progressAtParameter(path: MotionPath, parameter: number): number {
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

