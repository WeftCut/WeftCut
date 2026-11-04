import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applySnapshotPatches, diffSnapshot } from './snapshotPatch';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const scalar = fc.oneof(fc.integer(), fc.string({ maxLength: 3 }), fc.boolean(), fc.constant(null));
// Records repeat a small alphabet of keys and ids so that two random trees
// overlap: shared keys, reordered ids and duplicate ids all come up.
const key = fc.constantFrom('a', 'b', 'c', 'd', 'id', '0', '1');
const tree = fc.letrec<{ node: unknown; identified: unknown }>(tie => ({
  node: fc.oneof({ depthSize: 'small' }, scalar, fc.array(tie('node'), { maxLength: 4 }), fc.array(tie('identified'), { maxLength: 5 }),
    fc.dictionary(key, tie('node'), { maxKeys: 4 })),
  identified: fc.record({ id: fc.constantFrom('x', 'y', 'z', 'p', 'q'), body: tie('node') }),
}));

describe('snapshot patches', () => {
  it('rebuilds any target exactly, key order included, without touching the base', () => {
    fc.assert(fc.property(tree.node, tree.node, (before, after) => {
      const rebuilt = applySnapshotPatches(deepFreeze(before), diffSnapshot(before, after));
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(after));
    }), { numRuns: 2000 });
  });

  it('does not enter a branch both sides share, and keeps its reference', () => {
    const keyframes = deepFreeze(Array.from({ length: 1000 }, (_, i) => ({ id: `k${i}`, t_us: i })));
    let visits = 0;
    const counted = new Proxy(keyframes, { get(target, property, receiver) { visits++; return Reflect.get(target, property, receiver); } });
    const before = { layers: [{ id: 'a', t: 0, track: counted }, { id: 'b', t: 0, track: [] }] };
    const after = { layers: [{ ...before.layers[0]!, t: 5 }, before.layers[1]!] };
    const patches = diffSnapshot(before, after);
    expect(visits).toBe(0);
    expect(patches).toEqual([{ path: ['layers', 0, 't'], value: 5 }]);
    const rebuilt = applySnapshotPatches(before, patches);
    expect(rebuilt.layers[0]!.track).toBe(counted);
    expect(rebuilt.layers[1]).toBe(before.layers[1]);
    expect(rebuilt).not.toBe(before);
  });

  it('moves an id-keyed element without sending it again', () => {
    const a = { id: 'a', heavy: [1, 2, 3] }, b = { id: 'b', heavy: [4, 5, 6] }, c = { id: 'c', heavy: [] };
    const patches = diffSnapshot({ list: [a, b] }, { list: [c, b, a] });
    expect(patches).toEqual([{ path: ['list'], items: [{ value: c }, 1, 0] }]);
    const rebuilt = applySnapshotPatches({ list: [a, b] }, patches);
    expect(rebuilt.list[2]).toBe(a);
    expect(rebuilt.list[1]).toBe(b);
  });

  it('applies later patches through an element an earlier patch moved', () => {
    const before = { list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] };
    const after = { list: [{ id: 'b', n: 3 }, { id: 'a', n: 1 }] };
    expect(applySnapshotPatches(before, diffSnapshot(before, after))).toEqual(after);
    expect(before.list[1]!.n).toBe(2);
  });

  it('an undone removal puts the key back where it was', () => {
    const before = { a: 1, c: 3 }, after = { a: 1, b: 2, c: 3 };
    expect(Object.keys(applySnapshotPatches(before, diffSnapshot(before, after)))).toEqual(['a', 'b', 'c']);
  });

  it('no difference returns the base itself', () => {
    const base = { a: [{ id: 'x' }] };
    expect(applySnapshotPatches(base, diffSnapshot(base, structuredClone(base)))).toBe(base);
  });

  it('refuses a patch that does not fit the base rather than inventing a shape', () => {
    expect(() => applySnapshotPatches({ a: 1 }, [{ path: ['a', 'b', 'c'], value: 2 }])).toThrow(/branch/);
    expect(() => applySnapshotPatches({ a: 1 }, [{ path: ['a'], items: [0] }])).toThrow(/array/);
  });
});
