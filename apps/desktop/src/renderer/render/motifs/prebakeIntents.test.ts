import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerSummary, ProjectSummary } from '../../ipc';
import { groupLayerFixture, summaryFixture } from '../../testing/summaryFixture';
import {
  bindPrebakeIntents,
  clearPrebakeIntents,
  explicitPrebakeLayers,
  requestPrebake,
  resolvePrebakeIntents,
  subscribePrebakeIntents,
  takePrebakePromotions,
} from './prebakeIntents';

const project = (...ids: string[]): ProjectSummary => summaryFixture({ root: { tracks: [{
  id: 'track', kind: 'Video', label: null, enabled: true, locked: false, muted: false, solo: false,
  role: null, transient: false, layers: ids.map(id => groupLayerFixture({ id })),
}] } });
/** A Group named `g…` expands to its two children; anything else to itself. */
const expand = (layer: LayerSummary) => layer.id.startsWith('g') ? [`${layer.id}-a`, `${layer.id}-b`] : [layer.id];
const resolve = (summary: ProjectSummary, generation: number | null = 1) => resolvePrebakeIntents(summary, generation, expand);

beforeEach(() => clearPrebakeIntents());

describe('Pre-bake now intents', () => {
  it('keeps a request made before any preview listens, and wakes a listener on a new one', () => {
    requestPrebake('early');
    const wake = vi.fn();
    const off = subscribePrebakeIntents(wake);
    try {
      expect(wake).not.toHaveBeenCalled();
      expect(resolve(project('early'))).toBe(true);
      expect([...explicitPrebakeLayers()]).toEqual(['early']);
      requestPrebake('later');
      expect(wake).toHaveBeenCalledOnce();
    } finally { off(); }
  });

  it('resolves a request on first sight, expanding it then', () => {
    requestPrebake('g1');
    expect(resolve(project('other'))).toBe(false);
    expect(explicitPrebakeLayers().size).toBe(0);
    expect(resolve(project('other', 'g1', 'g1-a', 'g1-b'))).toBe(true);
    expect([...explicitPrebakeLayers()]).toEqual(['g1-a', 'g1-b']);
    // A later project change re-expands nothing: the request already resolved.
    expect(resolvePrebakeIntents(project('g1', 'g1-a', 'g1-b', 'g1-c'), 1, () => ['g1-c'])).toBe(false);
    expect([...explicitPrebakeLayers()]).toEqual(['g1-a', 'g1-b']);
  });

  it('drops a deleted layer\'s intent with its pending promotion', () => {
    requestPrebake('m1'); requestPrebake('m2');
    resolve(project('m1', 'm2'));
    resolve(project('m2'));
    expect([...explicitPrebakeLayers()]).toEqual(['m2']);
    expect(takePrebakePromotions()).toEqual([['m2']]);
    // Undo restores the layer, not the choice.
    resolve(project('m1', 'm2'));
    expect([...explicitPrebakeLayers()]).toEqual(['m2']);
  });

  it('drops a deleted Motif from its Group\'s intent', () => {
    requestPrebake('g1');
    resolve(project('g1', 'g1-a', 'g1-b'));
    resolve(project('g1', 'g1-b'));
    expect([...explicitPrebakeLayers()]).toEqual(['g1-b']);
    expect(takePrebakePromotions()).toEqual([['g1-b']]);
    resolve(project('g1-b', 'g1-a'));
    expect(explicitPrebakeLayers().size).toBe(0);
  });

  it('keeps a request for a layer no project has shown yet', () => {
    resolve(project('m1'));
    requestPrebake('new');
    expect(resolve(project('m1'))).toBe(false);
    expect(resolve(project())).toBe(false);
    expect(resolve(project('new'))).toBe(true);
    expect([...explicitPrebakeLayers()]).toEqual(['new']);
  });

  it('clears on a new session and without a project, keeping what resolved before a session was known', () => {
    requestPrebake('m1');
    resolve(project('m1', 'm2'), 1);
    bindPrebakeIntents(1);
    expect([...explicitPrebakeLayers()]).toEqual(['m1']);
    requestPrebake('m2');
    resolve(project('m1', 'm2'), null);
    bindPrebakeIntents(2);
    expect([...explicitPrebakeLayers()]).toEqual(['m2']);
    expect(takePrebakePromotions()).toEqual([['m2']]);
    requestPrebake('m3');
    clearPrebakeIntents();
    expect(explicitPrebakeLayers().size).toBe(0);
    expect(resolve(project('m3'))).toBe(false);
  });

  it('hands each promotion out once, newest request first', () => {
    requestPrebake('m1');
    resolve(project('m1', 'g2', 'g2-a', 'g2-b'));
    requestPrebake('g2');
    resolve(project('m1', 'g2', 'g2-a', 'g2-b'));
    expect(takePrebakePromotions()).toEqual([['g2-a', 'g2-b'], ['m1']]);
    expect(takePrebakePromotions()).toEqual([]);
    expect([...explicitPrebakeLayers()]).toEqual(['m1', 'g2-a', 'g2-b']);
    requestPrebake('m1');
    resolve(project('m1', 'g2', 'g2-a', 'g2-b'));
    expect(takePrebakePromotions()).toEqual([['m1']]);
  });
});
