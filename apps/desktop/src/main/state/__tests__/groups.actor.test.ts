// The Groups ops at the actor's two surfaces (ADR 0052; spec § Group semantics
// acceptance): one history row per op, undo of a pre-compose restores the
// members on their original lanes with their link, and the MCP result shapes.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Uuid } from '../model'
import { root } from './fixtures/project'

const S = 1_000_000

/** A root with a linked colour pair [2 s, 5 s) — V on A roll, W on B roll. */
function pairActor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'groups')
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const aRoll = root(initial).tracks[0].id
  const bRoll = root(initial).tracks[1].id
  const v = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2 * S, t_end_us: 5 * S })
  const w = actor.dispatch('add_layer', { track: bRoll, kind: 'color', t_start_us: 2 * S, t_end_us: 5 * S })
  if (!v.ok || !w.ok) throw new Error('fixture')
  const link = actor.dispatch('links_create', { layers: [v.value, w.value], label: null, reassign: false })
  if (!link.ok) throw new Error('fixture')
  return { actor, aRoll, bRoll, v: v.value as Uuid, w: w.value as Uuid, link: link.value as Uuid }
}
const groupsIn = (actor: ReturnType<typeof pairActor>['actor']) => Object.keys(actor.snapshot().compositions).filter((id) => id !== actor.snapshot().root_id)

describe('groups — actor dispatch', () => {
  it('groups_create is one history row naming the Group layer, returns { composition_id, layer_id }, and one undo restores the pair with its link', () => {
    const { actor, aRoll, bRoll, v, w, link } = pairActor()
    const before = actor.snapshot()
    const len = actor.historyStatus().len
    const r = actor.dispatch('groups_create', { layers: [v, w], label: 'Intro' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const value = r.value as { composition_id: Uuid; layer_id: Uuid }
    expect(Object.keys(value).sort()).toEqual(['composition_id', 'layer_id'])
    expect(actor.historyStatus().len).toBe(len + 1)
    const row = actor.historyView(1).ops[0]
    expect(row).toMatchObject({ summary: 'Grouped 2 layers', label_key: 'history.group.create', label_args: { count: 2 }, affected: [{ kind: 'Layer', id: value.layer_id }] })
    expect(groupsIn(actor)).toEqual([value.composition_id])
    expect(actor.snapshot().compositions[value.composition_id].label).toBe('Intro')

    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
    const rootAfter = root(actor.snapshot())
    expect(rootAfter.tracks.find((t) => t.id === aRoll)!.layers.map((l) => l.id)).toEqual([v])
    expect(rootAfter.tracks.find((t) => t.id === bRoll)!.layers.map((l) => l.id)).toEqual([w])
    expect(rootAfter.links).toEqual([{ id: link, members: [v, w].sort() }])
    expect(groupsIn(actor)).toEqual([])
  })

  it('groups_add_members is one row naming the members and the Group clip, and one undo restores their lanes, their times and a straddling link', () => {
    const { actor, aRoll, v, w } = pairActor()
    const made = actor.dispatch('groups_create', { layers: [v, w], label: null })
    if (!made.ok) throw new Error('fixture')
    const { composition_id, layer_id } = made.value as { composition_id: Uuid; layer_id: Uuid }
    // Two clips on the now-empty A roll, and a link from the first to the Group
    // clip — which straddles the move, so it dissolves and undo must bring it back.
    const z1 = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 6 * S, t_end_us: 7 * S })
    const z2 = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 7 * S, t_end_us: 8 * S })
    if (!z1.ok || !z2.ok) throw new Error('fixture')
    const link = actor.dispatch('links_create', { layers: [z1.value, layer_id], label: null, reassign: false })
    if (!link.ok) throw new Error('fixture')

    const before = actor.snapshot()
    const len = actor.historyStatus().len
    expect(actor.dispatch('groups_add_members', { layers: [z1.value, z2.value], group_layer: layer_id })).toEqual({ ok: true, value: null })
    expect(actor.historyStatus().len).toBe(len + 1)
    expect(actor.historyView(1).ops[0]).toMatchObject({
      summary: 'Added 2 layers to Group', label_key: 'history.group.add_members', label_args: { count: 2 },
      affected: [{ kind: 'Layer', id: z1.value }, { kind: 'Layer', id: z2.value }, { kind: 'Layer', id: layer_id }],
    })
    // The Group clip starts at 2 s over `src_in_us` 0, so both land 2 s earlier.
    const inside = actor.snapshot().compositions[composition_id]
    expect(inside.tracks.flatMap((t) => t.layers).filter((l) => l.id === z1.value || l.id === z2.value).map((l) => l.t_start_us).sort())
      .toEqual([4 * S, 5 * S])
    expect(root(actor.snapshot()).links).toEqual([]) // the straddling link fell below two

    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
    expect(root(actor.snapshot()).tracks.find((t) => t.id === aRoll)!.layers.map((l) => l.id)).toEqual([z1.value, z2.value])
    expect(root(actor.snapshot()).links).toEqual([{ id: link.value, members: [z1.value, layer_id].sort() }])
  })

  it('groups_ungroup, groups_rename and compositions_delete each record one row; refusals record nothing', () => {
    const { actor, v, w } = pairActor()
    const r = actor.dispatch('groups_create', { layers: [v, w], label: null })
    if (!r.ok) throw new Error('fixture')
    const { composition_id, layer_id } = r.value as { composition_id: Uuid; layer_id: Uuid }

    let len = actor.historyStatus().len
    expect(actor.dispatch('groups_rename', { composition: composition_id, label: 'Scene' })).toEqual({ ok: true, value: null })
    expect(actor.historyStatus().len).toBe(len + 1)
    expect(actor.historyView(1).ops[0]).toMatchObject({ label_key: 'history.group.rename', affected: [{ kind: 'Layer', id: layer_id }] })
    expect(actor.snapshot().compositions[composition_id].label).toBe('Scene')

    len = actor.historyStatus().len
    expect(actor.dispatch('groups_rename', { composition: actor.snapshot().root_id, label: 'x' })).toEqual({ ok: false, error: { error: 'RootComposition', composition: actor.snapshot().root_id } })
    expect(actor.dispatch('compositions_delete', { composition: composition_id })).toEqual({ ok: false, error: { error: 'CompositionInUse', composition: composition_id, ref_count: 1 } })
    expect(actor.dispatch('update_layer_param_track', { layer: layer_id, param_key: 'opacity', track: { mode: 'Static', value: 0.5 } }).ok).toBe(true)
    expect(actor.dispatch('groups_ungroup', { layer: layer_id })).toEqual({ ok: false, error: { error: 'GroupNotPlain', layer: layer_id, reason: 'opacity' } })
    expect(actor.historyStatus().len).toBe(len + 1) // only the opacity edit recorded
    expect(actor.dispatch('update_layer_param_track', { layer: layer_id, param_key: 'opacity', track: { mode: 'Static', value: 1 } }).ok).toBe(true)

    len = actor.historyStatus().len
    expect(actor.dispatch('groups_ungroup', { layer: layer_id })).toEqual({ ok: true, value: null })
    expect(actor.historyStatus().len).toBe(len + 1)
    expect(actor.historyView(1).ops[0]).toMatchObject({ summary: 'Ungrouped', label_key: 'history.group.ungroup', affected: [{ kind: 'Layer', id: layer_id }] })
    expect(groupsIn(actor)).toEqual([])
    expect(root(actor.snapshot()).tracks.flatMap((t) => t.layers)).toHaveLength(2)

    // An orphan: make a Group, delete its layer, then delete the composition.
    const [a, b] = root(actor.snapshot()).tracks.flatMap((t) => t.layers).map((l) => l.id)
    const r2 = actor.dispatch('groups_create', { layers: [a, b], label: null })
    if (!r2.ok) throw new Error('fixture')
    const orphan = (r2.value as { composition_id: Uuid; layer_id: Uuid })
    expect(actor.dispatch('delete_layer', { layer: orphan.layer_id }).ok).toBe(true)
    expect(groupsIn(actor)).toEqual([orphan.composition_id])
    len = actor.historyStatus().len
    expect(actor.dispatch('compositions_delete', { composition: orphan.composition_id })).toEqual({ ok: true, value: null })
    expect(actor.historyStatus().len).toBe(len + 1)
    expect(actor.historyView(1).ops[0]).toMatchObject({ summary: 'Deleted composition', label_key: 'history.composition.delete', affected: [] })
    expect(groupsIn(actor)).toEqual([])
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(groupsIn(actor)).toEqual([orphan.composition_id])
  })

  // Why the ordinal counter is monotonic rather than `max + 1`: undo of a
  // delete puts a composition back, and a reusing counter would by then have
  // handed its number to someone else.
  it('a deleted Group comes back from undo under its original number', () => {
    const { actor, v, w } = pairActor()
    const first = actor.dispatch('groups_create', { layers: [v, w], label: null })
    if (!first.ok) throw new Error('fixture')
    const g1 = (first.value as { composition_id: Uuid; layer_id: Uuid })
    expect(actor.snapshot().compositions[g1.composition_id].ordinal).toBe(1)
    expect(actor.dispatch('delete_layer', { layer: g1.layer_id }).ok).toBe(true)
    expect(actor.dispatch('compositions_delete', { composition: g1.composition_id }).ok).toBe(true)

    // A second Group made while the first is gone takes 2, not 1.
    const z = actor.dispatch('add_layer', { track: root(actor.snapshot()).tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: S })
    if (!z.ok) throw new Error('fixture')
    const second = actor.dispatch('groups_create', { layers: [z.value as Uuid], label: null })
    if (!second.ok) throw new Error('fixture')
    const g2 = (second.value as { composition_id: Uuid })
    expect(actor.snapshot().compositions[g2.composition_id].ordinal).toBe(2)

    // Undo back past the delete: both exist, still 1 and 2.
    for (let i = 0; i < 3; i++) expect(actor.dispatch('undo', {}).ok).toBe(true)
    const back = actor.snapshot()
    expect(back.compositions[g1.composition_id].ordinal).toBe(1)
    expect(back.compositions[g2.composition_id]).toBeUndefined()
  })

  it('a locked member refuses the whole set and records nothing', () => {
    const { actor, v, w } = pairActor()
    expect(actor.dispatch('update_layer', { layer: w, patch: { locked: true } }).ok).toBe(true)
    const before = actor.snapshot()
    const len = actor.historyStatus().len
    expect(actor.dispatch('groups_create', { layers: [v, w], label: null })).toEqual({ ok: false, error: { error: 'GroupLockedMember', layer: w } })
    expect(actor.snapshot()).toBe(before)
    expect(actor.historyStatus().len).toBe(len)
  })
})

describe('groups — MCP tools', () => {
  it('groups_create returns one JSON object { composition_id, layer_id }; the other three return empty results', () => {
    const { actor, v, w } = pairActor()
    const r = actor.mcpCall('groups_create', JSON.stringify({ layer_ids: [v, w], label: 'Intro' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const value = JSON.parse(r.result.content[0].text) as { composition_id: Uuid; layer_id: Uuid }
    expect(Object.keys(value)).toEqual(['composition_id', 'layer_id']) // sorted keys, exactly these
    expect(actor.snapshot().compositions[value.composition_id]).toBeDefined()

    expect(actor.mcpCall('groups_rename', JSON.stringify({ composition_id: value.composition_id, label: null }))).toEqual({ ok: true, result: { content: [] } })
    expect(actor.snapshot().compositions[value.composition_id].label).toBeNull()
    expect(actor.mcpCall('groups_ungroup', JSON.stringify({ layer_id: value.layer_id }))).toEqual({ ok: true, result: { content: [] } })
    expect(groupsIn(actor)).toEqual([])
  })

  it('groups_add_members moves the set and returns an empty result; a member that cannot land says where it would have to start', () => {
    const { actor, v, w } = pairActor()
    const made = actor.mcpCall('groups_create', JSON.stringify({ layer_ids: [v, w] }))
    if (!made.ok) throw new Error('fixture')
    const { composition_id, layer_id } = JSON.parse(made.result.content[0].text) as { composition_id: Uuid; layer_id: Uuid }
    const aRoll = root(actor.snapshot()).tracks[0].id // emptied by the pre-compose
    const z = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 6 * S, t_end_us: 7 * S })
    if (!z.ok) throw new Error('fixture')
    expect(actor.mcpCall('groups_add_members', JSON.stringify({ layer_ids: [z.value], group_layer_id: layer_id })))
      .toEqual({ ok: true, result: { content: [] } })
    expect(actor.snapshot().compositions[composition_id].tracks.flatMap((t) => t.layers).map((l) => l.id)).toContain(z.value)

    const early = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: S })
    if (!early.ok) throw new Error('fixture')
    const refused = actor.mcpCall('groups_add_members', JSON.stringify({ layer_ids: [early.value], group_layer_id: layer_id }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toMatch(/would land at .*before its start/)
  })

  it('refusals arrive as invalid_params with a message that says what and why', () => {
    const { actor, v, w } = pairActor()
    expect(actor.dispatch('update_layer', { layer: w, patch: { locked: true } }).ok).toBe(true)
    const locked = actor.mcpCall('groups_create', JSON.stringify({ layer_ids: [v, w] }))
    expect(locked.ok).toBe(false)
    if (!locked.ok) { expect(locked.error.code).toBe('invalid_params'); expect(locked.error.message).toMatch(/is locked.*every selected layer or none/) }

    const rootId = actor.snapshot().root_id
    const rootRename = actor.mcpCall('groups_rename', JSON.stringify({ composition_id: rootId, label: 'x' }))
    expect(rootRename.ok).toBe(false)
    if (!rootRename.ok) expect(rootRename.error.message).toMatch(/is the root/)

    expect(actor.dispatch('update_layer', { layer: w, patch: { locked: false } }).ok).toBe(true)
    const made = actor.mcpCall('groups_create', JSON.stringify({ layer_ids: [v, w] }))
    if (!made.ok) throw new Error('fixture')
    const { composition_id, layer_id } = JSON.parse(made.result.content[0].text) as { composition_id: Uuid; layer_id: Uuid }
    const inUse = actor.mcpCall('compositions_delete', JSON.stringify({ composition_id }))
    expect(inUse.ok).toBe(false)
    if (!inUse.ok) expect(inUse.error.message).toMatch(/referenced by 1 Group layer/)

    expect(actor.dispatch('update_layer_param_track', { layer: layer_id, param_key: 'opacity', track: { mode: 'Static', value: 0.5 } }).ok).toBe(true)
    const notPlain = actor.mcpCall('groups_ungroup', JSON.stringify({ layer_id }))
    expect(notPlain.ok).toBe(false)
    if (!notPlain.ok) expect(notPlain.error.message).toMatch(/not plain: its opacity/)

    // Malformed input never reaches the actor.
    const bad = actor.mcpCall('groups_create', JSON.stringify({ layer_ids: 'not-an-array' }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('invalid_params')
  })
})
