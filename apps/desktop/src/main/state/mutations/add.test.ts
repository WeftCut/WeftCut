// apps/desktop/src/main/state/mutations/add.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject } from '../model'
import { applyAddGroupLayer, applyAddLayer, applyAddMarker, applyAddTrack, colorParams, defaultTransform } from './add'
import { isCommandFailure } from '../errors'
import { group, groupedProject, mkComposition, root, withGroup } from '../__tests__/fixtures/project'

describe('additive mutations', () => {
  it('applyAddLayer snaps both edges, inserts t-start-sorted, autofits, returns id', () => {
    const g = seededGen(); const p = blankProject(g, 't') // ids 1,2,3 used
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080), 1_000_000, 2_000_000)
    expect(a).toBe('00000000-0000-0000-0000-000000000005') // first post-blank id
    expect(root(p).tracks[0].layers).toHaveLength(1)
    expect(root(p).duration_us).toBe(2_000_000)
    // insert sorted: add an earlier layer, it goes to index 0
    applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 500_000)
    expect(root(p).tracks[0].layers[0].t_start_us).toBe(0)
  })
  it('applyAddLayer rejects an unknown track BEFORE consuming the layer id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyAddLayer(p, g, 'ghost', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackNotFound') }
    // next id is still 4 (none consumed by the rejected add)
    expect(applyAddTrack(p, g, 'L')).toBe('00000000-0000-0000-0000-000000000005')
  })
  it('applyAddTrack uses Track::new defaults (removable, role null, height 64) and stamps transient', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const id = applyAddTrack(p, g, 'Track')
    const t = root(p).tracks.find((x) => x.id === id)!
    // transient == (role === null): a role-less lane is a cleanup candidate.
    expect(t).toMatchObject({ label: 'Track', enabled: true, locked: false, muted: false, solo: false, removable: true, role: null, transient: true, height_px: 64 })
  })
  it('applyAddMarker inserts t-sorted', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    applyAddMarker(p, g, 2_000_000, null, 'm2', { r: 0, g: 128, b: 255, a: 255 })
    applyAddMarker(p, g, 1_000_000, null, 'm1', { r: 0, g: 128, b: 255, a: 255 })
    expect(root(p).markers.map((m) => m.t_us)).toEqual([1_000_000, 2_000_000])
  })
  it('applyAddMarker snaps both times to the composition frame grid before inserting', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    root(p).fps = { num: 30000, den: 1001 }
    applyAddMarker(p, g, 1_000_000, 2_000_000, 'm', { r: 0, g: 128, b: 255, a: 255 })
    // 29.97: frame 30 = 1_001_000 µs, frame 60 = 2_002_000 µs.
    expect([root(p).markers[0].t_us, root(p).markers[0].end_t_us]).toEqual([1_001_000, 2_002_000])
  })
  it('applyAddMarker rejects a collapsed region BEFORE consuming the marker id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyAddMarker(p, g, 1_000_000, 1_000_001, 'm', { r: 0, g: 128, b: 255, a: 255 }); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('InvalidArgument') }
    expect(root(p).markers).toEqual([])
    expect(applyAddTrack(p, g, 'L')).toBe('00000000-0000-0000-0000-000000000005') // no id consumed
  })
})

// The creation ops are the ONLY ops that take a scope (ADR 0052): a track names
// its composition, and `composition_id` picks where a lane / marker is born.
describe('additive mutations inside a Group', () => {
  const RED = { r: 255, g: 0, b: 0, a: 255 }
  const BLUE = { r: 0, g: 128, b: 255, a: 255 }
  it('applyAddLayer onto a Group track lands in the Group and autofits ONLY the Group', () => {
    const { p, idGen, groupId, innerTrackId } = groupedProject()
    const rootBefore = structuredClone(root(p))
    const id = applyAddLayer(p, idGen, innerTrackId, colorParams(RED, 1, 1), 1_000_000, 3_000_000)
    expect(group(p, groupId).tracks[0].layers.map((l) => l.id)).toContain(id)
    expect(group(p, groupId).duration_us).toBe(3_000_000)
    expect(root(p)).toEqual(rootBefore)
  })
  it('applyAddTrack / applyAddMarker take composition_id (root by default; unknown → CompositionNotFound)', () => {
    const { p, idGen, groupId } = groupedProject()
    const t = applyAddTrack(p, idGen, null, undefined, groupId)
    expect(group(p, groupId).tracks.at(-1)!.id).toBe(t)
    expect(root(p).tracks.some((x) => x.id === t)).toBe(false)
    const m = applyAddMarker(p, idGen, 500_000, null, 'm', BLUE, groupId)
    expect(group(p, groupId).markers.map((x) => x.id)).toEqual([m])
    expect(root(p).markers).toEqual([])
    const rootTrack = applyAddTrack(p, idGen, null)
    expect(root(p).tracks.at(-1)!.id).toBe(rootTrack)
    try { applyAddTrack(p, idGen, null, undefined, 'ghost'); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('CompositionNotFound') }
  })
})

// Placing an EXISTING composition — the media pool's drag, and the reuse story a
// Group's whole reason for being an entity rests on (ADR 0052; spec § Group
// semantics).
describe('applyAddGroupLayer', () => {
  const RED = { r: 255, g: 0, b: 0, a: 255 }

  /** Counts the ids a run mints, so "a refused op burns none" is assertable
   *  without knowing where the seeded stream has got to. */
  function counted(gen: IdGen): { gen: IdGen; minted: () => number } {
    let n = 0
    return { gen: () => { n++; return gen() }, minted: () => n }
  }

  /** `root ⊃ first`, plus a second Group in the root; both compositions hold one
   *  Color layer `[0, 1 s)` on their A roll. Everything a placement needs: two
   *  lanes in two compositions, and a root lane to place onto. */
  function twoGroups() {
    const base = groupedProject()
    const { p, groupId: second } = withGroup(base.p, base.idGen, (g, view) =>
      applyAddLayer(view, base.idGen, g.tracks[0].id, colorParams(RED, 16, 9), 0, 1_000_000))
    return {
      p, idGen: base.idGen,
      first: base.groupId, firstTrackId: base.innerTrackId,
      second, secondTrackId: p.compositions[second].tracks[0].id,
      rootTrackId: root(p).tracks[0].id,
    }
  }

  it('windows the layer over the whole composition with an identity transform', () => {
    const { p, idGen, first, rootTrackId } = twoGroups()
    const duration = group(p, first).duration_us
    const id = applyAddGroupLayer(p, idGen, first, rootTrackId, 2_000_000)
    const placed = root(p).tracks.find((t) => t.id === rootTrackId)!.layers.find((l) => l.id === id)!
    expect([placed.t_start_us, placed.t_end_us]).toEqual([2_000_000, 2_000_000 + duration])
    if (placed.params.kind !== 'CompositionRef') throw new Error('expected a Group layer')
    expect(placed.params.composition).toBe(first)
    expect([placed.params.src_in_us, placed.params.src_out_us]).toEqual([0, duration])
    expect(placed.params.transform).toEqual(defaultTransform())
    expect(placed.params.opacity).toEqual({ mode: 'Static', value: 1 })
    expect(placed.params.blend_mode).toBe('Normal')
    // A second instance is a second layer, not a second composition.
    applyAddGroupLayer(p, idGen, first, rootTrackId, 10_000_000)
    expect(Object.keys(p.compositions)).toHaveLength(3)
  })

  it('places into the TRACK\'s composition — a Group inside a Group', () => {
    const { p, idGen, first, second, secondTrackId } = twoGroups()
    const rootBefore = structuredClone(root(p))
    const id = applyAddGroupLayer(p, idGen, first, secondTrackId, 2_000_000)
    expect(group(p, second).tracks[0].layers.map((l) => l.id)).toContain(id)
    // Autofit is per composition: the nesting grew the holder, not the root.
    expect(group(p, second).duration_us).toBe(2_000_000 + group(p, first).duration_us)
    expect(root(p)).toEqual(rootBefore)
  })

  it('refuses a composition that would contain itself, naming the loop', () => {
    const { p, idGen, first, firstTrackId } = twoGroups()
    const g = counted(idGen)
    const before = structuredClone(p)
    try { applyAddGroupLayer(p, g.gen, first, firstTrackId, 2_000_000); throw new Error('x') }
    catch (e) {
      expect(isCommandFailure(e) && e.err.error).toBe('ValidationFailed')
      expect(isCommandFailure(e) && e.err.error === 'ValidationFailed' && e.err.detail)
        .toEqual({ rule: 'CompositionCycle', path: [first, first] })
    }
    expect(p).toEqual(before)
    expect(g.minted()).toBe(0)
  })

  it('refuses a composition that already reaches the destination, however deep', () => {
    const { p, idGen, first, second, secondTrackId, firstTrackId } = twoGroups()
    // first ⊃ second, so second can no longer take first.
    applyAddGroupLayer(p, idGen, second, firstTrackId, 2_000_000)
    const g = counted(idGen)
    const before = structuredClone(p)
    try { applyAddGroupLayer(p, g.gen, first, secondTrackId, 2_000_000); throw new Error('x') }
    catch (e) {
      expect(isCommandFailure(e) && e.err.error === 'ValidationFailed' && e.err.detail)
        .toEqual({ rule: 'CompositionCycle', path: [second, first, second] })
    }
    expect(p).toEqual(before)
    expect(g.minted()).toBe(0)
  })

  it('refuses the root, an unknown composition, an unknown track and an empty composition', () => {
    const { p, idGen, first, rootTrackId } = twoGroups()
    const g = counted(idGen)
    const before = structuredClone(p)
    const refuse = (fn: () => void): string => {
      try { fn(); throw new Error('expected a refusal') }
      catch (e) { return isCommandFailure(e) ? e.err.error : 'not-a-CommandFailure' }
    }
    expect(refuse(() => applyAddGroupLayer(p, g.gen, p.root_id, rootTrackId, 0))).toBe('RootComposition')
    expect(refuse(() => applyAddGroupLayer(p, g.gen, 'ghost', rootTrackId, 0))).toBe('CompositionNotFound')
    expect(refuse(() => applyAddGroupLayer(p, g.gen, first, 'ghost', 0))).toBe('TrackNotFound')
    // An empty composition has a 0 duration, so the only window it could take is
    // a collapsed one — refused here rather than left to InvalidSrcRange.
    const empty = mkComposition(idGen)
    p.compositions[empty.id] = empty
    expect(refuse(() => applyAddGroupLayer(p, g.gen, empty.id, rootTrackId, 0))).toBe('InvalidArgument')
    delete p.compositions[empty.id]
    expect(p).toEqual(before)
    expect(g.minted()).toBe(0)
  })
})
