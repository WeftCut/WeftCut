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
import { insertPathNode, setPathNodeMode } from '../../../shared/pathGeometry';
import { convertPosition } from '../../../renderer/render/positionConversion';
function setup() {
    const gen = seededGen(), p = blankProject(gen, 'paths'), c = rootComposition(p), id = gen();
    c.duration_us = 2000000;
    const params = textParamsDefault('Path', c);
    c.tracks[0]!.layers.push({ id, label: null, t_start_us: 0, t_end_us: 2000000, enabled: true, locked: false, metadata: {}, effects: [], params });
    const path: PathPosition = { mode: 'Path', path: { nodes: [0, 1].map(i => ({ tangent_mode: 'Corner' as const, id: gen(), point: { x: 100 * i, y: 200 * i }, in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line' })) }, progress: { mode: 'Keyframed', extrapolate: { before: 'Loop', after: 'Loop' }, value: [0, 1].map(value => ({ id: gen(), t_us: value * 1000000, value, in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } })) } };
    return { p, c, id, params, path, gen };
}
describe('path authoring through state operations', () => {
    it('commits fitted and baked records without changing the measured conversion', () => {
        const { p, c, id, params, path } = setup();
        c.fps = { num: 30000, den: 1001 };
        c.duration_us = 2002000;
        c.tracks[0]!.layers[0]!.t_end_us = 2002000;
        const x = structuredClone(path.progress), y = structuredClone(path.progress);
        if (x.mode !== 'Keyframed' || y.mode !== 'Keyframed') throw new Error('test setup');
        for (const axis of [x, y]) {
            axis.extrapolate = { before: 'Hold', after: 'Hold' };
            axis.value[0]!.value = 0; axis.value[1]!.value = 300;
            axis.value[1]!.t_us = 2002000;
        }
        y.value[0]!.segment = { kind: 'Spline' };
        y.value[0]!.out.y = 0; y.value[1]!.in.y = 0;
        applySetPosition(p, id, { mode: 'XY', x, y });
        for (let direction = 0; direction < 2; direction++) {
            const source = structuredClone(params.transform.position);
            const conversion = convertPosition(source, { fpsNum: c.fps.num, fpsDen: c.fps.den, startFrame: 0, endFrame: 60, tolerancePx: 0.5, everyFrames: 10 });
            expect(conversion.withinTolerance).toBe(true);
            applySetPosition(p, id, conversion.position);
            expect(params.transform.position).toEqual(conversion.position);
            const serialized = serializeProjectToJson(p);
            expect(serializeProjectToJson(parseProjectJson(serialized).project)).toEqual(serialized);
        }
    });
    it('solves Auto on commit and inserts without changing progress or motion, with one-step undo', () => {
        const {p,id,path,gen}=setup();
        path.path.nodes[1]!.point={x:100,y:80};
        path.path.nodes.push({...path.path.nodes[1]!,id:gen(),point:{x:200,y:0}});
        path.path=setPathNodeMode(path.path,1,'Auto');
        const actor=createActor({initial:p,idGen:gen});
        expect(actor.dispatch('set_position',{layer:id,position:path}).ok).toBe(true);
        const before=actor.snapshot();
        const original=(rootComposition(before).tracks[0]!.layers[0]!.params as TextParams).transform.position as PathPosition;
        const next={...original,path:insertPathNode(original.path,0,0.37,gen())};
        expect(actor.dispatch('set_position',{layer:id,position:next,geometry_only:true}).ok).toBe(true);
        const stored=(rootComposition(actor.snapshot()).tracks[0]!.layers[0]!.params as TextParams).transform.position as PathPosition;
        expect(stored.progress).toEqual(original.progress);
        for(let time=0;time<2000000;time+=10000){
            const a=evaluatePosition(original,time),b=evaluatePosition(stored,time);
            expect(Math.hypot(a.x-b.x,a.y-b.y)).toBeLessThan(0.05);
        }
        expect(actor.dispatch('undo',{}).ok).toBe(true);
        expect(actor.snapshot()).toEqual(before);
    });
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
