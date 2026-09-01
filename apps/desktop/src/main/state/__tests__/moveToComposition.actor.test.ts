// The crossing addressed by DESTINATION at the actor's two surfaces: one
// history row per move, the lane fork that turns a named lane's bounce into a
// refusal, and the two directions the op exists for — down into a Group and back
// up into the film. The mutation's own contract is covered by
// mutations/moveToComposition.test.ts; what is under test here is the arm, the
// row and the MCP shape.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Uuid } from '../model'
import { root } from './fixtures/project'

const S = 1_000_000

type Actor = ReturnType<typeof createActor>

function color(actor: Actor, track: Uuid, t0: number, t1: number): Uuid {
  const r = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: t0, t_end_us: t1 })
  if (!r.ok) throw new Error('fixture')
  return r.value as Uuid
}

/** Root with a Group named "Intro" holding V (its A roll) and W (its B roll) at
 *  0–3 s, its clip at 2–5 s on the root's A roll, and both root rolls otherwise
 *  free. */
function grouped() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'move')
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const [aRoll, bRoll] = root(initial).tracks.map((t) => t.id)
  const v = color(actor, aRoll, 2 * S, 5 * S)
  const w = color(actor, bRoll, 2 * S, 5 * S)
  const made = actor.dispatch('groups_create', { layers: [v, w], label: 'Intro' })
  if (!made.ok) throw new Error('fixture')
  const { composition_id, layer_id } = made.value as { composition_id: Uuid; layer_id: Uuid }
  return { actor, aRoll, bRoll, v, w, inside: composition_id, group: layer_id }
}

const lanesOf = (actor: Actor, comp: Uuid) => actor.snapshot().compositions[comp].tracks
const laneOf = (actor: Actor, comp: Uuid, layer: Uuid) =>
  lanesOf(actor, comp).find((t) => t.layers.some((l) => l.id === layer))
const findLayer = (actor: Actor, comp: Uuid, layer: Uuid) =>
  lanesOf(actor, comp).flatMap((t) => t.layers).find((l) => l.id === layer)

describe('move_layers_to_composition — actor dispatch', () => {
  it('carries a set into another composition, names the destination in the row, and one undo restores lanes, times and a link that straddled the boundary', () => {
    const { actor, aRoll, bRoll, inside, group } = grouped()
    const p = color(actor, aRoll, 6 * S, 7 * S)
    const q = color(actor, bRoll, 6 * S, 7 * S)
    // A link from a mover to the Group clip, which stays behind: it straddles
    // the move, drops below two members and dissolves — so undo has to bring the
    // link back, not merely the layers.
    const link = actor.dispatch('links_create', { layers: [p, group], label: null, reassign: false })
    if (!link.ok) throw new Error('fixture')

    const before = actor.snapshot()
    const len = actor.historyStatus().len
    expect(actor.dispatch('move_layers_to_composition', {
      layers: [p, q], to_composition: inside, anchor_layer: p, anchor_t_start_us: 4 * S, to_track: null,
    })).toEqual({ ok: true, value: null })

    expect(actor.historyStatus().len).toBe(len + 1)
    expect(actor.historyView(1).ops[0]).toMatchObject({
      summary: 'Moved 2 layers to Intro', label_key: 'history.layer.move_to_composition',
      label_args: { count: 2, composition: 'Intro' },
      // The members alone: a composition has no EntityRef of its own.
      affected: [{ kind: 'Layer', id: p }, { kind: 'Layer', id: q }],
    })
    // The anchor lands where it was asked to; the other member keeps its phase,
    // which here is zero — both started at 6 s.
    expect(findLayer(actor, inside, p)).toMatchObject({ t_start_us: 4 * S, t_end_us: 5 * S })
    expect(findLayer(actor, inside, q)).toMatchObject({ t_start_us: 4 * S, t_end_us: 5 * S })
    // One block per SOURCE track, mapped bottom-up onto the destination's own
    // lanes: the two arrive separated, not stacked on one.
    expect(laneOf(actor, inside, p)!.id).toBe(lanesOf(actor, inside)[0].id)
    expect(laneOf(actor, inside, q)!.id).toBe(lanesOf(actor, inside)[1].id)
    expect(root(actor.snapshot()).links).toEqual([])

    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
    expect(root(actor.snapshot()).tracks.find((t) => t.id === aRoll)!.layers.map((l) => l.id)).toContain(p)
    expect(root(actor.snapshot()).tracks.find((t) => t.id === bRoll)!.layers.map((l) => l.id)).toContain(q)
    expect(root(actor.snapshot()).links).toEqual([{ id: link.value, members: [p, group].sort() }])
  })

  it('refuses a named lane that is already occupied and leaves the project byte-identical', () => {
    const { actor, aRoll, inside, v } = grouped()
    const p = color(actor, aRoll, 6 * S, 7 * S)
    const occupied = lanesOf(actor, inside)[0].id // holds V at 0–3 s

    const before = actor.snapshot()
    const len = actor.historyStatus().len
    const r = actor.dispatch('move_layers_to_composition', {
      layers: [p], to_composition: inside, anchor_layer: p, anchor_t_start_us: 0, to_track: occupied,
    })
    expect(r).toEqual({ ok: false, error: { error: 'ValidationFailed', detail: {
      rule: 'LayerOverlap', track: occupied,
      a: v, a_start: 0, a_end: 3 * S,
      b: p, b_start: 0, b_end: S,
    } } })
    // Named-lane placement refuses rather than bouncing, and it refuses BEFORE
    // the first write — so there is nothing to roll back and no id was burned.
    expect(actor.snapshot()).toBe(before)
    expect(actor.historyStatus().len).toBe(len)
  })

  it('takes the ROOT as an ordinary destination — a layer moves out of a Group and back into the film', () => {
    const { actor, aRoll, inside, v, w } = grouped()
    const rootId = actor.snapshot().root_id

    expect(actor.dispatch('move_layers_to_composition', {
      layers: [w], to_composition: rootId, anchor_layer: w, anchor_t_start_us: 10 * S, to_track: null,
    })).toEqual({ ok: true, value: null })

    expect(findLayer(actor, inside, w)).toBeUndefined()
    expect(findLayer(actor, inside, v)).toBeDefined() // the Group keeps what stayed
    expect(findLayer(actor, rootId, w)).toMatchObject({ t_start_us: 10 * S, t_end_us: 13 * S })
    // One source lane, so it is the k=0 block and prefers the root's first lane.
    expect(laneOf(actor, rootId, w)!.id).toBe(aRoll)
    // The root has no name of its own — it IS the timeline — so the row takes
    // the phrase key rather than printing a uuid.
    expect(actor.historyView(1).ops[0]).toMatchObject({
      summary: 'Moved 1 layers elsewhere',
      label_key: 'history.layer.move_to_composition_unnamed', label_args: { count: 1 },
      affected: [{ kind: 'Layer', id: w }],
    })
  })

  it('refuses a Group clip moved into the composition it references, spelling out the loop, before any write', () => {
    const { actor, inside, group } = grouped()
    const before = actor.snapshot()
    const len = actor.historyStatus().len
    expect(actor.dispatch('move_layers_to_composition', {
      layers: [group], to_composition: inside, anchor_layer: group, anchor_t_start_us: 0, to_track: null,
    })).toEqual({ ok: false, error: { error: 'ValidationFailed', detail: { rule: 'CompositionCycle', path: [inside, inside] } } })
    expect(actor.snapshot()).toBe(before)
    expect(actor.historyStatus().len).toBe(len)
  })
})

describe('move_layers_to_composition — MCP tool', () => {
  it('moves the set and returns an empty result', () => {
    const { actor, aRoll, inside } = grouped()
    const p = color(actor, aRoll, 6 * S, 7 * S)
    expect(actor.mcpCall('move_layers_to_composition', JSON.stringify({
      layer_ids: [p], to_composition_id: inside, anchor_layer_id: p, anchor_t_start_us: 4 * S,
    }))).toEqual({ ok: true, result: { content: [] } })
    expect(findLayer(actor, inside, p)).toMatchObject({ t_start_us: 4 * S })
  })

  it('"spawn" mints one fresh lane at the top of the destination instead of preferring an existing one', () => {
    const { actor, aRoll, inside } = grouped()
    const p = color(actor, aRoll, 6 * S, 7 * S)
    const lanesBefore = lanesOf(actor, inside).length
    expect(actor.mcpCall('move_layers_to_composition', JSON.stringify({
      layer_ids: [p], to_composition_id: inside, anchor_layer_id: p, anchor_t_start_us: 4 * S, to_track_id: 'spawn',
    })).ok).toBe(true)
    const lanes = lanesOf(actor, inside)
    expect(lanes).toHaveLength(lanesBefore + 1)
    expect(laneOf(actor, inside, p)!.id).toBe(lanes[lanes.length - 1].id)
  })

  it('refusals arrive as invalid_params with a message that says what and why', () => {
    const { actor, inside, group } = grouped()
    const cycle = actor.mcpCall('move_layers_to_composition', JSON.stringify({
      layer_ids: [group], to_composition_id: inside, anchor_layer_id: group, anchor_t_start_us: 0,
    }))
    expect(cycle.ok).toBe(false)
    if (!cycle.ok) {
      expect(cycle.error.code).toBe('invalid_params')
      expect(cycle.error.message).toBe(`composition references form a cycle: ${inside} → ${inside}`)
    }

    // An in-composition landing is move_layer's, and the message says so.
    const sameComp = actor.mcpCall('move_layers_to_composition', JSON.stringify({
      layer_ids: [group], to_composition_id: actor.snapshot().root_id, anchor_layer_id: group, anchor_t_start_us: 0,
    }))
    expect(sameComp.ok).toBe(false)
    if (!sameComp.ok) expect(sameComp.error.message).toMatch(/already in composition .*move_layer/)

    // Malformed input never reaches the actor. A mistyped `to_track_id` is the
    // one worth pinning: the literal is not a uuid, so a lax parser would read a
    // typo as "no opinion" and bounce a move the caller meant to pin to a lane.
    for (const args of [
      { layer_ids: 'not-an-array', to_composition_id: inside, anchor_layer_id: group, anchor_t_start_us: 0 },
      { layer_ids: [group], to_composition_id: inside, anchor_layer_id: group, anchor_t_start_us: 'soon' },
      { layer_ids: [group], to_composition_id: inside, anchor_layer_id: group, anchor_t_start_us: 0, to_track_id: 'spwan' },
    ]) {
      const bad = actor.mcpCall('move_layers_to_composition', JSON.stringify(args))
      expect(bad.ok, JSON.stringify(args)).toBe(false)
      if (!bad.ok) expect(bad.error.code).toBe('invalid_params')
    }
  })
})
