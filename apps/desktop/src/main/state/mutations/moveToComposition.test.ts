// apps/desktop/src/main/state/mutations/moveToComposition.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Composition, type Layer, type Project, type Uuid } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyGroupsCreate } from './groups'
import { applyLinksCreate } from './links'
import { applyMoveLayersToComposition } from './moveToComposition'
import { frameGrid, isCanonicalOnGrid } from '../snap'
import { validate } from '../validate'
import { isCommandFailure } from '../errors'
import { group, root } from '../__tests__/fixtures/project'

const S = 1_000_000
const RED = { r: 255, g: 0, b: 0, a: 255 }
const color = () => colorParams(RED, 1920, 1080)

function expectCmd(fn: () => void): Record<string, unknown> {
  try { fn() } catch (e) { if (isCommandFailure(e)) return e.err as unknown as Record<string, unknown>; throw e }
  throw new Error('expected a CommandFailure')
}
function layerOf(c: Composition, id: Uuid): Layer {
  for (const t of c.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error(`layer ${id} not in composition ${c.id}`)
}
function trackOf(c: Composition, id: Uuid): number {
  return c.tracks.findIndex((t) => t.layers.some((l) => l.id === id))
}

/** A root holding a Group clip `[2 s, 3 s)` over a composition whose A roll
 *  holds one colour layer at `[0, 1 s)`, plus two colour layers waiting to move:
 *  `[3 s, 4 s)` on B roll and `[5 s, 6 s)` on a transient lane. Two source
 *  tracks, so a move carries two blocks; disjoint in time, so the two blocks can
 *  share one lane without colliding with each other. */
function crossing(): { p: Project; gen: IdGen; comp: Uuid; g: Uuid; inner: Uuid; x: Uuid; y: Uuid; lane: Uuid } {
  const gen = seededGen()
  const p = blankProject(gen, 't')
  const inner = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 2 * S, 3 * S)
  const r = applyGroupsCreate(p, gen, [inner], null)
  const lane = applyAddTrack(p, gen, null)
  const x = applyAddLayer(p, gen, root(p).tracks[1].id, color(), 3 * S, 4 * S)
  const y = applyAddLayer(p, gen, lane, color(), 5 * S, 6 * S)
  return { p, gen, comp: r.compositionId, g: r.layerId, inner, x, y, lane }
}

describe('applyMoveLayersToComposition', () => {
  it('accepts the root as a destination, so a member can leave a Group for the film', () => {
    const { p, gen, comp, inner } = crossing()
    applyMoveLayersToComposition(p, gen, [inner], p.root_id, inner, 7 * S, null)
    expect(layerOf(root(p), inner)).toMatchObject({ t_start_us: 7 * S, t_end_us: 8 * S })
    expect(trackOf(root(p), inner)).toBe(0) // the k-th source lane prefers the destination's k-th
    expect(group(p, comp).tracks.flatMap((t) => t.layers)).toEqual([])
    expect(group(p, comp).duration_us).toBe(0) // the emptied destination refits too
    expect(root(p).duration_us).toBe(8 * S)
    expect(() => validate(p)).not.toThrow()
  })

  it('lands every source block on a named lane, rather than one lane per source track', () => {
    const { p, gen, comp, inner, x, y, lane } = crossing()
    const bRoll = group(p, comp).tracks[1].id
    // Left to itself the walk would split these: x onto the destination's first
    // lane, y onto its second. Naming a lane collapses both blocks onto it.
    applyMoveLayersToComposition(p, gen, [x, y], comp, x, S, bRoll)
    const c = group(p, comp)
    expect(c.tracks).toHaveLength(2) // nothing spawned, nothing bounced
    expect(c.tracks[1].layers.map((l) => l.id)).toEqual([x, y]) // and still t-sorted
    expect(layerOf(c, x)).toMatchObject({ t_start_us: S, t_end_us: 2 * S })
    expect(layerOf(c, y)).toMatchObject({ t_start_us: 3 * S, t_end_us: 4 * S }) // phase kept: 2 s after the anchor
    expect(trackOf(c, inner)).toBe(0)
    expect(root(p).tracks.some((t) => t.id === lane)).toBe(false) // emptied transient source lane pruned
    expect(() => validate(p)).not.toThrow()
  })

  it('refuses a named lane already holding same-class content at the landing times, writing nothing', () => {
    const { p, gen, comp, inner, x, y } = crossing()
    const aRoll = group(p, comp).tracks[0].id // holds `inner` across [0, 1 s)
    const before = structuredClone(p)
    expect(expectCmd(() => applyMoveLayersToComposition(p, gen, [x, y], comp, x, 500_000, aRoll)))
      .toEqual({ error: 'ValidationFailed', detail: {
        rule: 'LayerOverlap', track: aRoll,
        a: inner, a_start: 0, a_end: S,
        b: x, b_start: 500_000, b_end: 1_500_000,
      } })
    expect(p).toEqual(before)
  })

  it('refuses a named lane that is locked', () => {
    const { p, gen, comp, x, y } = crossing()
    const bRoll = group(p, comp).tracks[1].id
    group(p, comp).tracks[1].locked = true
    const before = structuredClone(p)
    expect(expectCmd(() => applyMoveLayersToComposition(p, gen, [x, y], comp, x, S, bRoll)))
      .toEqual({ error: 'TrackLocked', track: bRoll })
    expect(p).toEqual(before)
  })

  it("spawns ONE fresh lane past the destination's last one for `spawn`, and every block lands on it", () => {
    const { p, gen, comp, x, y } = crossing()
    const skeleton = group(p, comp).tracks.map((t) => t.id)
    applyMoveLayersToComposition(p, gen, [x, y], comp, x, S, 'spawn')
    const c = group(p, comp)
    expect(c.tracks).toHaveLength(3)
    expect(c.tracks.slice(0, 2).map((t) => t.id)).toEqual(skeleton) // appended, so top of the z-stack
    expect(c.tracks[2]).toMatchObject({ role: null, transient: true })
    expect(c.tracks[2].layers.map((l) => l.id)).toEqual([x, y])
    expect(() => validate(p)).not.toThrow()
  })

  it('refuses an anchor that is not one of the moving layers', () => {
    const { p, gen, comp, g, x, y } = crossing()
    const before = structuredClone(p)
    const e = expectCmd(() => applyMoveLayersToComposition(p, gen, [x, y], comp, g, S, null))
    expect(e).toMatchObject({ error: 'InvalidArgument', field: 'anchor_layer_id' })
    expect(e.detail).toContain(g)
    expect(p).toEqual(before)
  })

  // Not merely undefined: `moveLinksAndTransitions` would splice and push one
  // array and never terminate, wedging the main process on a synchronous loop no
  // timeout can interrupt. The linked pair is what makes that reachable.
  it('refuses a destination that is the composition the set is already in', () => {
    const { p, gen, x, y } = crossing()
    applyLinksCreate(p, gen, [x, y], null, false)
    const before = structuredClone(p)
    const e = expectCmd(() => applyMoveLayersToComposition(p, gen, [x, y], p.root_id, x, 8 * S, null))
    expect(e).toMatchObject({ error: 'InvalidArgument', field: 'to_composition' })
    expect(p).toEqual(before)
  })

  it("snaps both endpoints of every member on the DESTINATION's lattice, not the source's", () => {
    const { p, gen, comp, x } = crossing()
    // One project cannot really hold two rates — validate refuses that
    // (`CompositionLatticeMismatch`) — so the destination is retuned by hand and
    // this case is deliberately not validated. What is under test is which fps
    // reaches `snapOnGrid`, and only the destination's does.
    const c = group(p, comp)
    c.fps = { num: 30000, den: 1001 } // 29.97; the root stays at 30
    applyMoveLayersToComposition(p, gen, [x], comp, x, 0, null)
    const grid = frameGrid(c.fps)
    const moved = layerOf(c, x)
    expect(isCanonicalOnGrid(moved.t_start_us, grid)).toBe(true)
    expect(isCanonicalOnGrid(moved.t_end_us, grid)).toBe(true)
    // The layer spanned exactly 1 s on the root's 30/1 lattice; the nearest
    // 29.97 frame to that end is 1 001 000 µs, so the span is not preserved and
    // A → B → A would not return it to the microsecond it left.
    expect(moved).toMatchObject({ t_start_us: 0, t_end_us: 1_001_000 })
  })
})
