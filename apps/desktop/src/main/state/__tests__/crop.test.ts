import { describe, it, expect } from 'vitest';
import { createActor } from '../actor';
import { blankProject, rootComposition, type VideoClipParams } from '../model';
import { seededGen } from '../ids';
import { applyAddLayer } from '../mutations/add';
import { mediaItemTemplate, videoClipParams } from '../mutations/media';
import { serializeProject, parseProject } from '../serialize';
import { layerParamsView } from '../summary';

function setup() {
  const gen = seededGen(), p = blankProject(gen, 'crop');
  const mid = gen(); p.media_pool[mid] = mediaItemTemplate(mid, 'Video', 2_000_000);
  const id = applyAddLayer(p, gen, rootComposition(p).tracks[0]!.id, videoClipParams(mid, 0, 2_000_000), 0, 2_000_000);
  const actor = createActor({ initial: p, idGen: gen, clock: () => '<test>' });
  const layer = () => rootComposition(actor.snapshot()).tracks.flatMap(t => t.layers).find(l => l.id === id)!;
  const crop = () => layer().params.kind === 'VideoClip' ? (layer().params as VideoClipParams).crop : undefined;
  const patch = (crop: unknown, extra = {}) => actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: id, patch: { kind: 'VideoClip', crop, ...extra } }));
  return { actor, id, layer, crop, patch };
}
const rect = { x: 0.2, y: 0.1, w: 0.5, h: 0.6 };
describe('crop through the authoritative command and persistence surfaces', () => {
  it('changes only crop, projects it, round-trips, undoes, redoes and resets', () => {
    const { actor, layer, crop, patch } = setup();
    const before = structuredClone(layer().params);
    expect(patch(rect).ok).toBe(true);
    expect(layer().params).toEqual({ ...before, crop: rect });
    expect(layerParamsView(layer().params, actor.snapshot().media_pool)).toMatchObject({ crop: rect });
    const loaded = parseProject(serializeProject(actor.snapshot()));
    expect(rootComposition(loaded).tracks[0]!.layers[0]!.params).toMatchObject({ crop: rect });
    expect(actor.dispatch('undo', {}).ok).toBe(true); expect(crop()).toBeNull();
    expect(actor.dispatch('redo', {}).ok).toBe(true); expect(crop()).toEqual(rect);
    expect(patch(null).ok).toBe(true); expect(crop()).toBeNull();
  });
  it('invalid crops and locked clips refuse atomically, including accompanying transforms', () => {
    const { actor, id, patch } = setup();
    for (const bad of [{ ...rect, w: 2 }, { ...rect, h: 0 }, { ...rect, x: null }, { ...rect, extra: 1 }]) {
      const before = JSON.stringify(actor.snapshot());
      expect(patch(bad, { x: 200 }).ok).toBe(false);
      expect(JSON.stringify(actor.snapshot())).toBe(before);
    }
    expect(actor.dispatch('update_layer', { layer: id, patch: { locked: true } }).ok).toBe(true);
    expect(patch(rect).ok).toBe(false);
  });
  it('rejects invalid crop data when opening a project', () => {
    const { actor } = setup();
    const wire = serializeProject(actor.snapshot()) as any;
    wire.compositions[wire.root_id].tracks[0].layers[0].params.crop = { ...rect, w: -1 };
    expect(() => parseProject(wire)).toThrow();
  });
  it('preserves the same source rectangle on both sides of a split', () => {
    const { actor, id, patch } = setup();
    expect(patch(rect).ok).toBe(true);
    expect(actor.mcpCall('split_layer', JSON.stringify({ layer_id: id, at_t_us: [1_000_000] })).ok).toBe(true);
    const layers = rootComposition(actor.snapshot()).tracks[0]!.layers;
    expect(layers).toHaveLength(2);
    for (const layer of layers) expect(layer.params).toMatchObject({ crop: rect });
  });
});
