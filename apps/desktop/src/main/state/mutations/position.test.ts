import { describe, it, expect } from 'vitest';
import { blankProject, rootComposition, type TextParams } from '../model';
import { seededGen } from '../ids';
import { textParamsDefault } from './add';
import { applySetPosition, applyTranslatePath } from './position';
import { applyUpdateLayerParamTrack, applyParamsPatch } from './params';
import { applySplitLayer } from './split';
import { applyTrimLayer } from './trim';
import { createActor } from '../actor';
import { parseProjectJson, serializeProjectToJson } from '../persistence';
import { evaluatePosition } from '../../../renderer/render/position';
import { IN_IDENTITY, OUT_IDENTITY } from '../../../shared/keyframe';
import { type PathPosition } from '../../../shared/position';
function setup() {
    const gen = seededGen(), p = blankProject(gen, 'paths'), c = rootComposition(p), id = gen();
    c.duration_us = 2000000;
    const params = textParamsDefault('Path', c);
    c.tracks[0]!.layers.push({ id, label: null, t_start_us: 0, t_end_us: 2000000, enabled: true, locked: false, metadata: {}, effects: [], params });
    const path: PathPosition = { mode: 'Path', path: { nodes: [0, 1].map(i => ({ id: gen(), point: { x: 100 * i, y: 200 * i }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line' })) }, progress: { mode: 'Keyframed', extrapolate: { before: 'Loop', after: 'Loop' }, value: [0, 1].map(value => ({ id: gen(), t_us: value * 1000000, value, in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } })) } };
    return { p, c, id, params, path, gen };
}
describe('path authoring through state operations', () => {
    it('persists the path and rejects independent axis writes atomically', () => {
        const { p, id, params, path } = setup();
        applySetPosition(p, id, path);
        const before = serializeProjectToJson(p);
        expect(() => applyUpdateLayerParamTrack(p, id, 'x', { mode: 'Static', value: 99 })).toThrow();
        expect(() => applyParamsPatch({ id, params } as never, { kind: 'Text', x: 99 })).toThrow();
        expect(serializeProjectToJson(p)).toBe(before);
        expect(serializeProjectToJson(parseProjectJson(before).project)).toBe(before);
    });
    it('preserves movement on both sides of a split, including cyclic extrapolation', () => {
        const { p, c, id, path, gen } = setup();
        applySetPosition(p, id, path);
        applySplitLayer(p, gen, id, 400000, false);
        for (const layer of c.tracks[0]!.layers) {
            const pos = (layer.params as TextParams).transform.position;
            for (let time = layer.t_start_us; time < layer.t_end_us; time += 100000)
                expect(evaluatePosition(pos, time - layer.t_start_us)).toEqual(evaluatePosition(path, time));
        }
    });
    it('retains geometry and content timing on an in trim', () => {
        const { p, id, path, params } = setup();
        applySetPosition(p, id, path);
        applyTrimLayer(p, id, 'In', 400000, false);
        expect(evaluatePosition(params.transform.position, 100000)).toEqual(evaluatePosition(path, 500000));
    });
    it('rejects malformed geometry and unsupported extrapolation before changing position', () => {
        const { p, id, params, path } = setup();
        const before = structuredClone(params.transform.position);
        const bad = structuredClone(path);
        bad.path.nodes[0]!.point.x = NaN;
        expect(() => applySetPosition(p, id, bad)).toThrow();
        expect(params.transform.position).toEqual(before);
        applySetPosition(p, id, path);
        const progress = path.progress;
        if (progress.mode === 'Keyframed')
            expect(() => applyUpdateLayerParamTrack(p, id, 'path_progress', { ...progress, extrapolate: { before: 'Hold', after: 'Continue' } })).toThrow();
    });
    it('translates relatively and restores the exact XY source with one undo', () => {
        const { p, id, path, gen } = setup();
        const actor = createActor({ initial: p, idGen: gen });
        const before = actor.snapshot();
        expect(actor.dispatch('set_position', { layer: id, position: path }).ok).toBe(true);
        expect(actor.dispatch('undo', {}).ok).toBe(true);
        expect(actor.snapshot()).toEqual(before);
        applySetPosition(p, id, path);
        applyTranslatePath(p, id, 10, 20);
        applyTranslatePath(p, id, 10, 20);
        expect(evaluatePosition((rootComposition(p).tracks[0]!.layers[0]!.params as TextParams).transform.position, 0)).toEqual({ x: 20, y: 40 });
    });
});
