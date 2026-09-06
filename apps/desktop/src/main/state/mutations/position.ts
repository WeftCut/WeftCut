import type { Project, Uuid } from '../model';
import { CommandFailure } from '../errors';
import { checkTrackLock } from './helpers';
import { positionProblem, translatePath, visitPositionTracks, type PositionAnimation } from '../../../shared/position';
import { normalizeKeyframes } from './animated';
import { snapFrameRound } from '../snap';
import { solveAutoTangents } from '../../../shared/tangents';
import { refuseRetiredKeyframeShape } from '../serialize';
/** One atomic authoring command, shared by UI and MCP. */
export function applySetPosition(project: Project, id: Uuid, input: PositionAnimation, geometryOnly = false): void {
    const { layer, comp } = checkTrackLock(project, id);
    if (!('transform' in layer.params))
        throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: 'This layer has no position' });
    const position = structuredClone(input);
    if (geometryOnly) {
        if (position.mode !== 'Path' || layer.params.transform.position.mode !== 'Path')
            throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: 'Geometry editing requires Path mode' });
        position.progress = layer.params.transform.position.progress;
    }
    const problem = positionProblem(position);
    if (problem)
        throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: problem });
    try {
        refuseRetiredKeyframeShape({ compositions: { c: { tracks: [{ layers: [{ id, params: { transform: { position } } }] }] } } });
    }
    catch (error) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: String(error) });
    }
    if (!geometryOnly)
        visitPositionTracks(position, track => {
            normalizeKeyframes(track, t => snapFrameRound(t, comp.fps.num, comp.fps.den));
            if (track.mode === 'Keyframed')
                track.value = solveAutoTangents(track.value, v => v);
        });
    // Full records (including baked samples) retain numeric precision. Numeric
    // inspector edits still pass through the per-param precision policy.
    layer.params.transform.position = position;
}
/** Relative translation resolves on the authoritative state so successive
 * gestures cannot overwrite one another using an older UI snapshot. */
export function applyTranslatePath(project: Project, id: Uuid, dx: number, dy: number): void {
    const { layer } = checkTrackLock(project, id);
    if (!Number.isFinite(dx) || !Number.isFinite(dy))
        throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: 'Translation must be finite' });
    if (!('transform' in layer.params) || layer.params.transform.position.mode !== 'Path')
        throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: 'The layer must use Path mode' });
    const next = translatePath(layer.params.transform.position, dx, dy);
    const problem = positionProblem(next);
    if (problem)
        throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: problem });
    layer.params.transform.position = next;
}
