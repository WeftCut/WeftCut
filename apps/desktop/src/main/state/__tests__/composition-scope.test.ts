// The derived-scope rule at the actor's two surfaces (ADR 0052; spec
// § Invariants): a layer-addressed op finds its composition from the layer id
// and takes no scope argument, only creation ops take `composition_id` /
// `compositionId`, a destination in another composition is refused, and the
// per-composition envelope (`set_composition`, `fit_composition_to_layers`)
// targets one composition while the lattice cascades to all.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, applyAddMarker } from '../mutations/add'
import { mediaItemTemplate, videoClipParams } from '../mutations/media'
import { applyDeleteLayer } from '../mutations/delete'
import { groupedProject, root, withGroup } from './fixtures/project'

const BLUE = { r: 0, g: 128, b: 255, a: 255 }
function mk() {
  const g = groupedProject()
  const actor = createActor({ initial: g.p, idGen: g.idGen, clock: () => '<TS>' })
  return { ...g, actor }
}
const groupOf = (actor: ActorHandle, id: string) => actor.snapshot().compositions[id]
const errorOf = (r: { ok: boolean; error?: unknown }): string => JSON.stringify(r.error ?? null)

describe('composition scope — MCP tools', () => {
  it('move_layer on a layer inside a Group takes no scope argument', () => {
    const { actor, groupId, innerId } = mk()
    const bRoll = groupOf(actor, groupId).tracks[1].id
    const r = actor.mcpCall('move_layer', JSON.stringify({ layer_id: innerId, new_track_id: bRoll, new_t_start_us: 2_000_000 }))
    expect(r.ok).toBe(true)
    expect(groupOf(actor, groupId).tracks[1].layers[0]).toMatchObject({ id: innerId, t_start_us: 2_000_000 })
    expect(groupOf(actor, groupId).duration_us).toBe(3_000_000)
    expect(root(actor.snapshot()).duration_us).toBe(1_000_000) // the root did not autofit
  })
  it('move_layer to a track in another composition → CrossCompositionMove, nothing committed', () => {
    const { actor, innerId } = mk()
    const len = actor.historyStatus().len
    const r = actor.mcpCall('move_layer', JSON.stringify({ layer_id: innerId, new_track_id: root(actor.snapshot()).tracks[1].id, new_t_start_us: 0 }))
    expect(r.ok).toBe(false)
    expect(errorOf(r)).toMatch(/lives in composition .*destination is in composition/)
    expect(actor.historyStatus().len).toBe(len)
  })
  it('add_color_layer { composition_id } lands inside the Group; a track elsewhere and an unknown composition refuse', () => {
    const { actor, groupId } = mk()
    const gB = groupOf(actor, groupId).tracks[1].id
    const ok = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: gB, composition_id: groupId, color: BLUE, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(ok.ok).toBe(true)
    expect(groupOf(actor, groupId).tracks[1].layers).toHaveLength(1)
    const wrong = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: root(actor.snapshot()).tracks[1].id, composition_id: groupId, color: BLUE, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(wrong.ok).toBe(false)
    expect(errorOf(wrong)).toMatch(/belongs to composition/)
    const ghost = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: gB, composition_id: '00000000-0000-7000-8000-00000000dead', color: BLUE, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(ghost.ok).toBe(false)
    expect(errorOf(ghost)).toMatch(/composition .* not found/)
  })
  it('add_track / add_marker { composition_id } create inside the Group', () => {
    const { actor, groupId } = mk()
    expect(actor.mcpCall('add_track', JSON.stringify({ composition_id: groupId })).ok).toBe(true)
    expect(groupOf(actor, groupId).tracks).toHaveLength(3)
    expect(root(actor.snapshot()).tracks).toHaveLength(3)
    expect(actor.mcpCall('add_marker', JSON.stringify({ t_us: 500_000, label: 'x', color: BLUE, composition_id: groupId })).ok).toBe(true)
    expect(groupOf(actor, groupId).markers).toHaveLength(1)
    expect(root(actor.snapshot()).markers).toHaveLength(0)
  })
})

describe('composition scope — dispatch ops', () => {
  it("deleting the last layer on a transient track inside a Group prunes that track and leaves the root's alone", () => {
    const { actor, groupId } = mk()
    const t = actor.dispatch('add_track', { composition_id: groupId })
    const tid = t.ok ? (t.value as string) : ''
    const l = actor.dispatch('add_layer', { kind: 'color', track: tid, t_start_us: 0, t_end_us: 1_000_000 })
    expect(l.ok).toBe(true)
    const rootTracks = root(actor.snapshot()).tracks.map((x) => x.id)
    expect(actor.dispatch('delete_layer', { layer: l.ok ? l.value : '' }).ok).toBe(true)
    expect(groupOf(actor, groupId).tracks.some((x) => x.id === tid)).toBe(false)
    expect(root(actor.snapshot()).tracks.map((x) => x.id)).toEqual(rootTracks)
  })
  it('delete_layers / set_layers_enabled refuse a set spanning two compositions, recording nothing', () => {
    const { actor, groupId, innerId, refLayerId } = mk()
    const before = actor.snapshot()
    expect(actor.dispatch('delete_layers', { layers: [innerId, refLayerId] }))
      .toEqual({ ok: false, error: { error: 'CrossCompositionSet', layer: refLayerId, composition: before.root_id, expected: groupId } })
    expect(actor.dispatch('set_layers_enabled', { layers: [innerId, refLayerId], enabled: false }).ok).toBe(false)
    expect(actor.snapshot()).toBe(before)
  })
  it('set_composition { width, composition_id } changes ONE composition', () => {
    const { actor, groupId } = mk()
    expect(actor.dispatch('set_composition', { width: 640, composition_id: groupId }).ok).toBe(true)
    expect(groupOf(actor, groupId).width).toBe(640)
    expect(root(actor.snapshot()).width).toBe(1920)
    // The renderer channel spelling: the id rides beside the patch.
    expect(actor.command('set_composition', { patch: { height: 360 }, compositionId: groupId }).ok).toBe(true)
    expect(groupOf(actor, groupId).height).toBe(360)
    expect(root(actor.snapshot()).height).toBe(1080)
  })
  it("set_composition { fps } cascades to every composition and re-snaps every composition's markers", () => {
    // The rate is locked while any composition holds a layer — and a Group's
    // reference IS a layer — so the cascade is observable on an orphan Group
    // (legal state) holding markers, which never lock the rate.
    const gen = seededGen()
    const { p, refLayerId, groupId } = withGroup(blankProject(gen, 'm'), gen)
    applyDeleteLayer(p, refLayerId)
    applyAddMarker(p, gen, 1_020_000, null, 'r', BLUE)          // 30 fps: frame 31 = 1_033_333
    applyAddMarker(p, gen, 1_020_000, null, 'g', BLUE, groupId)
    const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    expect(actor.dispatch('set_composition', { fps: { num: 24, den: 1 } }).ok).toBe(true)
    const s = actor.snapshot()
    expect([root(s).fps, s.compositions[groupId].fps]).toEqual([{ num: 24, den: 1 }, { num: 24, den: 1 }])
    // 1_033_333 at 24 fps is frame 24.8 → 25 → 1_041_667, in BOTH compositions.
    expect([root(s).markers[0].t_us, s.compositions[groupId].markers[0].t_us]).toEqual([1_041_667, 1_041_667])
  })
  it('fit_composition_to_layers { composition_id } unpins ONE composition', () => {
    const { actor, groupId } = mk()
    expect(actor.dispatch('set_composition', { duration_us: 5_000_000, composition_id: groupId }).ok).toBe(true)
    expect(groupOf(actor, groupId)).toMatchObject({ duration_pinned: true, duration_us: 5_000_000 })
    expect(root(actor.snapshot()).duration_pinned).toBe(false)
    expect(actor.dispatch('fit_composition_to_layers', { composition_id: groupId }).ok).toBe(true)
    expect(groupOf(actor, groupId)).toMatchObject({ duration_pinned: false, duration_us: 1_000_000 })
  })
})

describe('composition scope — renderer channels', () => {
  it('add_color_layer { compositionId } without a trackId places on a free lane INSIDE the Group, spawning one there', () => {
    const { actor, groupId } = mk()
    const r = actor.command('add_color_layer', { tStartUs: 0, durationUs: 1_000_000, compositionId: groupId })
    expect(r.ok).toBe(true)
    const g = groupOf(actor, groupId)
    // The Group's skeleton lanes are role-stamped, so no overlay lane was free
    // and one was minted — in the Group.
    expect(g.tracks).toHaveLength(3)
    expect(g.tracks[2].layers.map((l) => l.id)).toEqual([r.ok ? r.value : ''])
    expect(root(actor.snapshot()).tracks).toHaveLength(3)
  })
  it('add_track / add_marker { compositionId } land in the Group', () => {
    const { actor, groupId } = mk()
    expect(actor.command('add_track', { compositionId: groupId }).ok).toBe(true)
    expect(actor.command('add_marker', { tUs: 0, compositionId: groupId }).ok).toBe(true)
    expect(groupOf(actor, groupId).tracks).toHaveLength(3)
    expect(groupOf(actor, groupId).markers).toHaveLength(1)
    expect(root(actor.snapshot()).markers).toHaveLength(0)
  })
})

describe('composition scope — an anchored marker travels with its layer', () => {
  const MEDIA_S = '00000000-0000-0000-0000-0000000000cc'

  it('crossing a composition carries the markers anchored to the set and leaves the free ones behind', () => {
    // A marker belongs to one composition, and the anchor is what decides which:
    // it names a layer, and a move is not a delete, so it goes where the layer
    // goes. A free marker marks the film's own time and stays.
    const gen = seededGen()
    const p = blankProject(gen, 'cross')
    p.media_pool[MEDIA_S] = mediaItemTemplate(MEDIA_S, 'Video', 10_000_000)
    const aRoll = root(p).tracks[0].id
    const clip = applyAddLayer(p, gen, aRoll, videoClipParams(MEDIA_S, 2_000_000, 4_000_000), 1_000_000, 3_000_000)
    const tied = applyAddMarker(p, gen, 2_000_000, null, 'tied', BLUE, null, '', { layer: clip, src_us: 3_000_000 })
    const free = applyAddMarker(p, gen, 500_000, null, 'free', BLUE)
    const { p: withComp, groupId } = withGroup(p, gen)
    const actor = createActor({ initial: withComp, idGen: gen, clock: () => '<TS>' })
    const r = actor.dispatch('move_layers_to_composition', {
      layers: [clip], to_composition: groupId, anchor_layer: clip, anchor_t_start_us: 4_000_000, to_track: 'spawn',
    })
    expect(r.ok).toBe(true)
    expect(root(actor.snapshot()).markers.map((m) => m.id)).toEqual([free])
    const inner = groupOf(actor, groupId)
    expect(inner.markers.map((m) => m.id)).toEqual([tied])
    // Re-derived in its new home by the same commit: 4 s + (3 s − 2 s).
    expect(inner.markers[0].t_us).toBe(5_000_000)
  })
})
