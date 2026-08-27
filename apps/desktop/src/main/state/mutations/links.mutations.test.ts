// apps/desktop/src/main/state/mutations/links.mutations.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyLinksCreate, applyLinksDissolve, applyLinksAddMembers, applyLinksRemoveMembers, applyLinksRename } from './links'
import { applyAddLayer, colorParams } from './add'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function withLayers(ids: string[]): Project {
  const p = blankProject(seededGen(), 't')
  root(p).tracks[0].layers = ids.map((id, i) => color(id, i * 1000, i * 1000 + 500))
  return p
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('link mutations', () => {
  it('create: rejects < 2 unique members', () => {
    const p = withLayers(['a'])
    expectCmd(() => applyLinksCreate(p, seededGen(), ['a', 'a'], null, false), 'LinkCreateNeedsTwoLayers')
  })
  it('create: rejects a missing member', () => {
    const p = withLayers(['a', 'b'])
    expectCmd(() => applyLinksCreate(p, seededGen(), ['a', 'ghost'], null, false), 'LayerNotFound')
  })
  it('create: makes a link with sorted members; label omitted when null', () => {
    const p = withLayers(['a', 'b'])
    const gen = seededGen()
    const gid = applyLinksCreate(p, gen, ['b', 'a'], null, false)
    expect(root(p).links.length).toBe(1)
    expect(root(p).links[0].id).toBe(gid)
    expect([...root(p).links[0].members].sort()).toEqual(['a', 'b'])
    expect('label' in root(p).links[0]).toBe(false) // null → field omitted (serde None parity)
  })
  it('create: rejects an already-linked layer unless reassign', () => {
    const p = withLayers(['a', 'b', 'c'])
    applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    expectCmd(() => applyLinksCreate(p, seededGen(), ['b', 'c'], null, false), 'LayerAlreadyLinked')
    // reassign moves 'b' to the new link; old link drops to 1 member → auto-dissolves
    applyLinksCreate(p, seededGen(), ['b', 'c'], 'L', true)
    expect(root(p).links.length).toBe(1)
    expect([...root(p).links[0].members].sort()).toEqual(['b', 'c'])
    expect(root(p).links[0].label).toBe('L')
  })
  it('dissolve: removes the link, errors when missing', () => {
    const p = withLayers(['a', 'b'])
    const gid = applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    applyLinksDissolve(p, gid); expect(root(p).links.length).toBe(0)
    expectCmd(() => applyLinksDissolve(p, gid), 'LinkNotFound')
  })
  it('addMembers: adds; already-linked→LayerAlreadyLinked (before link existence); missing link→LinkNotFound', () => {
    const p = withLayers(['a', 'b', 'c', 'd'])
    const gid = applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    applyLinksAddMembers(p, gid, ['c'], false)
    expect([...root(p).links[0].members].sort()).toEqual(['a', 'b', 'c'])
    // Rust checks already-linked BEFORE link existence:
    // 'a' is linked, target 'nope' missing, reassign=false → LayerAlreadyLinked.
    expectCmd(() => applyLinksAddMembers(p, 'nope', ['a'], false), 'LayerAlreadyLinked')
    // 'd' is unlinked → passes the already-linked scan → reaches the missing-link check.
    expectCmd(() => applyLinksAddMembers(p, 'nope', ['d'], false), 'LinkNotFound')
  })
  it('removeMembers: removes, auto-dissolves below 2, errors on non-member', () => {
    const p = withLayers(['a', 'b', 'c'])
    const gid = applyLinksCreate(p, seededGen(), ['a', 'b', 'c'], null, false)
    applyLinksRemoveMembers(p, gid, ['c'])
    expect([...root(p).links[0].members].sort()).toEqual(['a', 'b'])
    expectCmd(() => applyLinksRemoveMembers(p, gid, ['ghost']), 'LayerNotInLink')
    applyLinksRemoveMembers(p, gid, ['b']) // drops to 1 → dissolve
    expect(root(p).links.length).toBe(0)
  })
  it('rename: sets label, clears on null, errors when missing', () => {
    const p = withLayers(['a', 'b'])
    const gid = applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    applyLinksRename(p, gid, 'Scene 1'); expect(root(p).links[0].label).toBe('Scene 1')
    applyLinksRename(p, gid, null); expect('label' in root(p).links[0]).toBe(false) // null clears the field (serde None parity)
    expectCmd(() => applyLinksRename(p, 'nope', 'x'), 'LinkNotFound')
  })
})

describe('link mutations inside a Group', () => {
  const BLACK = { r: 0, g: 0, b: 0, a: 255 }
  it("links_create lands in the members' composition; a mixed set is CrossCompositionSet; rename / dissolve find the link by id", () => {
    const { p, idGen, groupId, innerId, refLayerId } = groupedProject()
    const second = applyAddLayer(p, idGen, group(p, groupId).tracks[1].id, colorParams(BLACK, 1, 1), 0, 500_000)
    expectCmd(() => applyLinksCreate(p, idGen, [innerId, refLayerId], null, false), 'CrossCompositionSet')
    const gid = applyLinksCreate(p, idGen, [innerId, second], null, false)
    expect(group(p, groupId).links.map((g) => g.id)).toEqual([gid])
    expect(root(p).links).toEqual([])
    applyLinksRename(p, gid, 'pair')
    expect(group(p, groupId).links[0].label).toBe('pair')
    // add_members: a link that exists in ANOTHER composition is a scope mismatch, not a missing link.
    const rootLink = applyLinksCreate(p, idGen, [refLayerId, applyAddLayer(p, idGen, root(p).tracks[1].id, colorParams(BLACK, 1, 1), 0, 500_000)], null, false)
    const third = applyAddLayer(p, idGen, group(p, groupId).tracks[1].id, colorParams(BLACK, 1, 1), 600_000, 900_000)
    expectCmd(() => applyLinksAddMembers(p, rootLink, [third], false), 'CrossCompositionSet')
    applyLinksDissolve(p, gid)
    expect(group(p, groupId).links).toEqual([])
  })
})
