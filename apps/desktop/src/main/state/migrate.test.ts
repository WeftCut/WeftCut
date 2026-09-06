// apps/desktop/src/main/state/migrate.test.ts
//
// The migration RUNNER, exercised against synthetic steps. The real chain is
// empty at v1, so without injected steps none of this — the walk, the stamp, the
// clone isolation, the hole report — would be covered until the first real bump
// shipped. Which is the wrong time to find out.
import { describe, it, expect } from 'vitest'
import { upgradeWire, MIN_SCHEMA_VERSION, STEPS, type MigrationStep } from './migrate'

/** A step that records that it ran and renames one field. */
const renameStep = (from: number, oldKey: string, newKey: string): MigrationStep => ({
  from,
  apply: (wire) => {
    wire[newKey] = wire[oldKey]
    delete wire[oldKey]
  },
})

describe('upgradeWire', () => {
  it('is the identity at the current version, and hands back the same object', () => {
    const wire = { schema_version: 1, a: 1 }
    const out = upgradeWire(wire, 1, 1, [renameStep(1, 'a', 'b')])
    expect(out.wire).toBe(wire)      // no clone when nothing runs
    expect(out.from).toBe(1)
    expect(wire).toEqual({ schema_version: 1, a: 1 })
  })

  it('applies one step and stamps the new version', () => {
    const out = upgradeWire({ schema_version: 1, a: 7 }, 1, 2, [renameStep(1, 'a', 'b')])
    expect(out.wire).toEqual({ schema_version: 2, b: 7 })
    expect(out.from).toBe(1)
  })

  it('walks multiple generations in ascending order', () => {
    const order: number[] = []
    const trace = (from: number): MigrationStep => ({ from, apply: () => { order.push(from) } })
    // Deliberately registered OUT of order: steps are selected by `from`, not by
    // array position, so a chain appended to carelessly still runs correctly.
    const out = upgradeWire({ schema_version: 1 }, 1, 4, [trace(3), trace(1), trace(2)])
    expect(order).toEqual([1, 2, 3])
    expect(out.wire.schema_version).toBe(4)
    expect(out.from).toBe(1)
  })

  it('leaves the input untouched — the walk works on a clone', () => {
    const wire = { schema_version: 1, nested: { keep: [1, 2] }, a: 1 }
    upgradeWire(wire, 1, 2, [{
      from: 1,
      apply: (w) => {
        (w.nested as { keep: number[] }).keep.push(99)
        delete w.a
      },
    }])
    expect(wire).toEqual({ schema_version: 1, nested: { keep: [1, 2] }, a: 1 })
  })

  it('leaves the input untouched when a step throws mid-walk', () => {
    const wire = { schema_version: 1, a: 1 }
    const boom: MigrationStep = { from: 2, apply: () => { throw new Error('step 2 exploded') } }
    expect(() => upgradeWire(wire, 1, 3, [renameStep(1, 'a', 'b'), boom])).toThrow(/step 2 exploded/)
    // The v1→v2 rename really did run before the throw; the caller must still see
    // the ORIGINAL file, so it can report on what is actually on disk.
    expect(wire).toEqual({ schema_version: 1, a: 1 })
  })

  it('owns the version stamp, overwriting whatever a step wrote', () => {
    const liar: MigrationStep = { from: 1, apply: (w) => { w.schema_version = 999 } }
    expect(upgradeWire({ schema_version: 1 }, 1, 2, [liar]).wire.schema_version).toBe(2)
  })

  it('refuses a hole in the chain, naming the missing generation', () => {
    expect(() => upgradeWire({ schema_version: 1 }, 1, 3, [renameStep(1, 'a', 'b')]))
      .toThrow(/no upgrade step from project schema v2 to v3/)
  })

  it('refuses a version below the upgradable floor', () => {
    expect(() => upgradeWire({ schema_version: 0 }, 0, 1, []))
      .toThrow(/predates the oldest upgradable version/)
    expect(() => upgradeWire({ schema_version: -3 }, -3, 1, [])).toThrow(/predates/)
  })

  it('has no downgrade path', () => {
    expect(() => upgradeWire({ schema_version: 5 }, 5, 2, [])).toThrow(/no downgrade path/)
  })
})

describe('the shipped chain', () => {
  it('wraps independent axes in every composition without rewriting or mutating their records', () => {
    const x={mode:'Keyframed',value:[{id:'x-key',t_us:12345,value:1.23456789,in:{x:0.123,y:-2,mode:'Free'},out:{x:0.789,y:4,mode:'Free'},segment:{kind:'Hold'},continuity:'Broken'}],extrapolate:{before:'Continue',after:'Offset'}}
    const y={mode:'Static',value:-9.87654321}
    const wire={schema_version:1,compositions:{root:{tracks:[{layers:[{params:{transform:{x,y,scale_x:{mode:'Static',value:1}}}}]}]},group:{tracks:[{layers:[{params:{transform:{x:y,y:x}}}]}]}}}
    const original=structuredClone(wire)
    const result=upgradeWire(wire,1,2).wire as unknown as {compositions:Record<string,{tracks:Array<{layers:Array<{params:{transform:Record<string,unknown>}}>}>}>}
    const root=result.compositions.root!.tracks[0]!.layers[0]!.params.transform
    const group=result.compositions.group!.tracks[0]!.layers[0]!.params.transform
    expect(root.position).toEqual({mode:'XY',x,y})
    expect(group.position).toEqual({mode:'XY',x:y,y:x})
    expect(root).not.toHaveProperty('x');expect(root).not.toHaveProperty('y')
    expect(root.scale_x).toEqual({mode:'Static',value:1})
    expect(wire).toEqual(original)
  })
  it('starts at v1 — the first published format', () => {
    expect(MIN_SCHEMA_VERSION).toBe(1)
  })
  it('is registered in ascending `from` order, one step per generation', () => {
    const froms = STEPS.map((s) => s.from)
    expect(froms).toEqual([...froms].sort((a, b) => a - b))
    expect(new Set(froms).size).toBe(froms.length)
  })
})
