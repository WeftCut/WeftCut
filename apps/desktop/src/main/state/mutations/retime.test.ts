import { describe, it, expect } from 'vitest';
import { createActor } from '../actor';
import { blankProject, rootComposition, type Layer, type Keyframe } from '../model';
import { seededGen } from '../ids';
import { applyAddLayer } from './add';
import { videoClipParams, audioParams, mediaItemTemplate } from './media';
import { applyLinksCreate } from './links';
import { applyRetimeLayers } from './retime';
import { applyTrimLayer } from './trim';
import { applySplitLayer } from './split';
import { sourceIn, sourceOut, keyTimeExact, layerRate } from '../../../renderer/layerTiming';
import { addTime, multiplyTime, exactTime } from '../../../renderer/timeMapping';
import { normalizeKeyframes } from './animated';
import { upgradeWire } from '../migrate';

function setup() {
  const gen = seededGen(); const p = blankProject(gen, 'retime'); const c = rootComposition(p);
  const media = gen(); p.media_pool[media] = mediaItemTemplate(media, 'Video', 30_000_000, true);
  const v = applyAddLayer(p, gen, c.tracks[0].id, videoClipParams(media, 2_000_000, 8_000_000), 1_000_000, 7_000_000);
  const a = applyAddLayer(p, gen, c.tracks[1].id, audioParams(media, 2_000_000, 8_000_000), 1_000_000, 6_000_000);
  applyLinksCreate(p, gen, [v, a], false);
  const layer = (id: string): Layer => c.tracks.flatMap(t => t.layers).find(l => l.id === id)!;
  return { p, c, gen, media, v, a, layer };
}

describe('time-remapping transactions', () => {
  it('MCP retiming returns the committed rate, keeps linked audio unchanged, and undoes once', () => {
    const { p, gen, v, a } = setup(); const actor = createActor({ initial: p, idGen: gen });
    const before = actor.snapshot();
    const result = actor.mcpCall('retime_layers', JSON.stringify({ layer_ids: [v], target: { kind: 'Rate', value: { num: 2, den: 1 } } }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const record = JSON.parse(result.result.content[0].text);
    expect(record.layers).toHaveLength(1);
    expect(record.layers[0]).toMatchObject({ layer_id: v, t_end_us: 4_000_000, timing: { time_map: { kind: 'Affine', rate: { num: 2, den: 1 } } } });
    const layers = rootComposition(actor.snapshot()).tracks.flatMap(t => t.layers);
    expect(layers.find(l => l.id === a)).toEqual(rootComposition(before).tracks.flatMap(t => t.layers).find(l => l.id === a));
    expect(actor.mcpCall('undo', '{}').ok).toBe(true);
    expect(actor.snapshot()).toEqual(before);
  });

  it('MCP reads and replaces retimed animation keys without losing fractional times', () => {
    const { p, gen, v, layer } = setup(); const l = layer(v);
    if (l.params.kind !== 'VideoClip') throw new Error('fixture');
    const key = (t_us: number): Keyframe<number> => ({ id: gen(), t_us, value: 0.5,
      in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } });
    l.params.opacity = { mode: 'Keyframed', value: [key(1), key(2)], extrapolate: { before: 'Hold', after: 'Hold' } };
    const actor = createActor({ initial: p, idGen: gen });
    expect(actor.mcpCall('retime_layers', JSON.stringify({ layer_ids: [v], target: { kind: 'Rate', value: { num: 3, den: 1 } } })).ok).toBe(true);
    const read = actor.mcpCall('get_param_track', JSON.stringify({ layer_id: v, param_key: 'opacity' }));
    if (!read.ok) throw new Error(JSON.stringify(read));
    const record = JSON.parse(read.result.content[0].text);
    expect(record.keyframes.map((k: Keyframe<number>) => k.time_fraction)).toEqual([{ num: 1, den: 3 }, { num: 2, den: 3 }]);
    const keys = record.keyframes.map(({ id, t_local_us, preset_id, ...k }: Record<string, unknown>) => k);
    const written = actor.mcpCall('set_param_track', JSON.stringify({ layer_id: v, param_key: 'opacity', track: { mode: 'Keyframed', value: keys } }));
    expect(written.ok, JSON.stringify(written)).toBe(true);
    const params = rootComposition(actor.snapshot()).tracks.flatMap(t => t.layers).find(l => l.id === v)!.params;
    if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture');
    expect(params.opacity.value.map(keyTimeExact)).toEqual([exactTime(1, 3), exactTime(2, 3)]);
  });

  it.each(['layer', 'track'])('MCP interpolation refuses a locked %s without changing the project or history', lock => {
    const { p, gen, c, v, layer } = setup();
    if (lock === 'layer') layer(v).locked = true;
    else c.tracks[0].locked = true;
    const actor = createActor({ initial: p, idGen: gen });
    const before = actor.snapshot(), history = actor.historyStatus();
    const result = actor.mcpCall('set_frame_interpolation', JSON.stringify({ layer_ids: [v], interpolation: { kind: 'FrameSampling' } }));
    expect(result.ok).toBe(false);
    expect(actor.snapshot()).toBe(before);
    expect(actor.historyStatus()).toEqual(history);
  });

  it('retimes only explicit IDs, preserves content, and undoes/redoes as one edit', () => {
    const { p, gen, v, a } = setup(); const actor = createActor({ initial: p, idGen: gen });
    const before = structuredClone(actor.snapshot());
    const result = actor.command('retime_layers', { layerIds: [v], target: { kind: 'Rate', value: { num: 2, den: 1 } } });
    expect(result.ok).toBe(true);
    const after = actor.snapshot();
    const layers = rootComposition(after).tracks.flatMap(t => t.layers);
    expect(layers.find(l => l.id === v)?.t_end_us).toBe(4_000_000);
    expect(layers.find(l => l.id === a)).toEqual(rootComposition(before).tracks.flatMap(t => t.layers).find(l => l.id === a));
    expect(actor.dispatch('undo', {}).ok).toBe(true); expect(actor.snapshot()).toEqual(before);
    expect(actor.dispatch('redo', {}).ok).toBe(true); expect(actor.snapshot()).toEqual(after);
  });

  it('rejects a whole batch without history or partial writes on collision', () => {
    const { p, gen, media, c, v, a } = setup();
    applyAddLayer(p, gen, c.tracks[0].id, videoClipParams(media, 0, 2_000_000), 8_000_000, 10_000_000);
    const actor = createActor({ initial: p, idGen: gen }); const before = actor.snapshot(); const history = actor.historyStatus();
    const r = actor.command('retime_layers', { layerIds: [a, v], target: { kind: 'Rate', value: { num: 1, den: 2 } } });
    expect(r.ok).toBe(false); expect(actor.snapshot()).toBe(before); expect(actor.historyStatus()).toEqual(history);
  });

  it('preserves exact key identities through repeated retimes and subsequent normalization', () => {
    const { p, v, layer } = setup(); const l = layer(v);
    if (l.params.kind !== 'VideoClip') throw new Error('fixture');
    const key = (id: string, t_us: number): Keyframe<number> => ({ id, t_us, value: 0.5,
      in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } });
    l.params.opacity = { mode: 'Keyframed', value: [key('k1', 1), key('k2', 2)], extrapolate: { before: 'Hold', after: 'Hold' } };
    l.params.fade_in_us = 100_001;
    applyRetimeLayers(p, [v], { kind: 'Rate', value: { num: 3, den: 1 } });
    expect(l.params.opacity.value.map(keyTimeExact)).toEqual([exactTime(1, 3), exactTime(2, 3)]);
    normalizeKeyframes(l.params.opacity, () => 0);
    expect(l.params.opacity.value.map(k => k.id)).toEqual(['k1', 'k2']);
    applyRetimeLayers(p, [v], { kind: 'Rate', value: { num: 1, den: 1 } });
    expect(l.params.opacity.value.map(keyTimeExact)).toEqual([exactTime(1), exactTime(2)]);
    expect(l.params.fade_in_us).toBe(100_001); expect(l.params.fade_phase).toBeUndefined();
  });

  it('trim and split retain the same mapped source boundary at fractional rates', () => {
    const { p, gen, v, layer } = setup();
    applyRetimeLayers(p, [v], { kind: 'Rate', value: { num: 7, den: 3 } });
    const l = layer(v); const rate = layerRate(l.params); const oldIn = sourceIn(l.params); const oldOut = sourceOut(l);
    applyTrimLayer(p, v, 'In', 1_100_000, true);
    expect(sourceIn(l.params)).toEqual(addTime(oldIn, multiplyTime(exactTime(100_000), rate)));
    const split = applySplitLayer(p, gen, v, 1_500_000, true);
    expect(sourceOut(layer(split.left))).toEqual(sourceIn(layer(split.right).params));
    expect(sourceOut(layer(split.right))).toEqual(oldOut);
  });

  it('v2 migration discards inert video speed and preserves Motif props.speed', () => {
    const { p, v, layer } = setup();
    const params = layer(v).params as unknown as Record<string, unknown>;
    params.speed = 9;
    const legacyProject = structuredClone(p);
    const legacyMotif = legacyProject.compositions[legacyProject.root_id].tracks[1].layers[0];
    legacyMotif.params = { kind: 'Motif', src_in_us: 0, props: { speed: 9 } } as unknown as Layer['params'];
    const legacy = legacyProject as unknown as Record<string, unknown>;
    const result = upgradeWire(legacy, 2, 3).wire as unknown as typeof p;
    const migrated = rootComposition(result).tracks.flatMap(t => t.layers).find(l => l.id === v)!;
    expect(migrated.params).not.toHaveProperty('speed'); expect(layerRate(migrated.params)).toEqual({ num: 1, den: 1 });
    const motif = { schema_version: 2, compositions: { c: { tracks: [{ layers: [{ t_start_us: 0, t_end_us: 10, params: { kind: 'Motif', props: { speed: 9 } } }] }] } } };
    expect((upgradeWire(motif, 2, 3).wire as typeof motif).compositions.c.tracks[0].layers[0].params.props.speed).toBe(9);
  });
});
