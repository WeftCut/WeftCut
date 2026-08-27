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
