// apps/desktop/src/main/state/__tests__/mcp.surface-consolidation.test.ts
// The one-verb-per-resource pass (ADR 0074): three keyframe tools became
// `update_keyframe`, three link tools became `update_link`, the duration unpin
// became `update_composition { duration_us: null }`, the reads gained a
// tool-shaped fallback (`read_project`), and an Image no longer has to invent a
// source window for `add_video_layer`.
//
// What is pinned is what the merged descriptions promise and a caller cannot
// see from the schema: ONE commit per call, the order the aspects apply in,
// the refusal of an empty update, and that the fallback read serves exactly
// what the resource serves.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Project } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { root } from './fixtures/project'

const IMAGE = '00000000-0000-0000-0000-0000000000c1'
const VIDEO = '00000000-0000-0000-0000-0000000000c2'
const NOWHERE = '00000000-0000-7000-8000-000000000009'

function actorWithPool() {
  const gen = seededGen()
  const p: Project = blankProject(gen, 'consolidation')
  p.media_pool[IMAGE] = mediaItemTemplate(IMAGE, 'Image', null)
  p.media_pool[VIDEO] = mediaItemTemplate(VIDEO, 'Video', 20_000_000)
  return createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
}
type Actor = ReturnType<typeof actorWithPool>

function call(a: Actor, tool: string, args: Record<string, unknown> = {}) {
  return a.mcpCall(tool, JSON.stringify(args))
}
function text(r: ReturnType<Actor['mcpCall']>): string {
  expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
  if (!r.ok) throw new Error('call failed')
  return r.result.content[0].text
}
function json<T>(r: ReturnType<Actor['mcpCall']>): T { return JSON.parse(text(r)) as T }
function refusal(r: ReturnType<Actor['mcpCall']>): { code: string; message: string } {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}
function aRoll(a: Actor): string { return root(a.snapshot()).tracks[0].id }
function bRoll(a: Actor): string { return root(a.snapshot()).tracks[1].id }
function threeClips(a: Actor): string[] {
  const track = aRoll(a)
  return [0, 1, 2].map((i) => text(call(a, 'add_color_layer', {
    track_id: track, t_start_us: i * 1_000_000, t_end_us: (i + 1) * 1_000_000, color: { r: 1, g: 2, b: 3, a: 255 },
  })))
}

interface Key { id: string; t_us: number; in: { x: number; y: number; mode: string }; out: { x: number; y: number; mode: string }; continuity: string; segment: { kind: string }; preset_id?: string }
function keyedText(a: Actor): { layerId: string; keys: Key[] } {
  const layerId = text(call(a, 'add_text_layer', { track_id: bRoll(a), t_start_us: 0, t_end_us: 4_000_000, content: 'k' }))
  for (const [t, v] of [[0, 0], [2_000_000, 1]] as const)
    expect(call(a, 'set_keyframe', { layer_id: layerId, param_key: 'opacity', t_us: t, value: v }).ok).toBe(true)
  return { layerId, keys: readKeys(a, layerId) }
}
function readKeys(a: Actor, layerId: string): Key[] {
  return json<{ keyframes: Key[] }>(call(a, 'get_param_track', { layer_id: layerId, param_key: 'opacity' })).keyframes
}

describe('update_keyframe', () => {
  it('applies retime, easing, a side and continuity to one key in ONE commit, in that order', () => {
    const a = actorWithPool()
    const { layerId, keys } = keyedText(a)
    const before = a.historyStatus().len
    const r = call(a, 'update_keyframe', {
      layer_id: layerId, param_key: 'opacity', keyframe_id: keys[0].id,
      t_us: 1_000_000, easing: { preset: 'ease_in_out' }, out: { x: 0.3, y: 0 }, continuity: 'Broken',
    })
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    expect(a.historyStatus().len).toBe(before + 1)
    const after = readKeys(a, layerId)
    const k = after.find((x) => x.id === keys[0].id)!
    expect(k.t_us).toBe(1_000_000)
    // `out` is written AFTER the easing, so the side sent wins over the preset's.
    expect(k.out).toEqual({ x: 0.3, y: 0, mode: 'Free' })
    expect(k.segment).toEqual({ kind: 'Spline' })
    expect(k.continuity).toBe('Broken')
    // The preset still landed on the NEXT key's arriving side.
    expect(after[1].in).toEqual({ x: 0.58, y: 1, mode: 'Free' })
  })

  it('bakes a named preset alone and reads its id back', () => {
    const a = actorWithPool()
    const { layerId, keys } = keyedText(a)
    expect(call(a, 'update_keyframe', { layer_id: layerId, param_key: 'opacity', keyframe_id: keys[0].id, easing: { preset: 'ease_in_out' } }).ok).toBe(true)
    expect(readKeys(a, layerId)[0].preset_id).toBe('ease_in_out')
  })

  it('refuses an update that changes nothing, before any write', () => {
    const a = actorWithPool()
    const { layerId, keys } = keyedText(a)
    const before = a.historyStatus().len
    const e = refusal(call(a, 'update_keyframe', { layer_id: layerId, param_key: 'opacity', keyframe_id: keys[0].id }))
    expect(e.code).toBe('invalid_params')
    expect(e.message).toMatch(/at least one of t_us, easing, in, out, continuity/)
    expect(a.historyStatus().len).toBe(before)
  })

  it('the three retired names are gone, not aliased', () => {
    const a = actorWithPool()
    for (const old of ['retime_keyframe', 'set_keyframe_easing', 'set_keyframe_tangents'])
      expect(refusal(call(a, old, {})).code).toBe('not_found')
  })
})

describe('update_link', () => {
  function linked(a: Actor) {
    const [c1, c2, c3] = threeClips(a)
    const linkId = text(call(a, 'create_link', { layer_ids: [c1, c2] }))
    return { c1, c2, c3, linkId }
  }
  function link(a: Actor, id: string) { return root(a.snapshot()).links.find((g) => g.id === id) }

  it('adds, removes and renames in ONE recorded edit', () => {
    const a = actorWithPool()
    const { c1, c2, c3, linkId } = linked(a)
    const before = a.historyStatus().len
    expect(call(a, 'update_link', { link_id: linkId, add_layer_ids: [c3], remove_layer_ids: [c1], label: 'pair' }).ok).toBe(true)
    expect(a.historyStatus().len).toBe(before + 1)
    const g = link(a, linkId)!
    expect([...g.members].sort()).toEqual([c2, c3].sort())
    expect(g.label).toBe('pair')
    expect(call(a, 'undo').ok).toBe(true)
    expect([...link(a, linkId)!.members].sort()).toEqual([c1, c2].sort())
  })

  it('dissolves the link when a removal leaves it below two members', () => {
    const a = actorWithPool()
    const { c1, linkId } = linked(a)
    expect(call(a, 'update_link', { link_id: linkId, remove_layer_ids: [c1] }).ok).toBe(true)
    expect(link(a, linkId)).toBeUndefined()
  })

  it('clears the label with null, and refuses a call that changes nothing', () => {
    const a = actorWithPool()
    const { linkId } = linked(a)
    expect(call(a, 'update_link', { link_id: linkId, label: 'x' }).ok).toBe(true)
    expect(call(a, 'update_link', { link_id: linkId, label: null }).ok).toBe(true)
    expect(link(a, linkId)!.label).toBeUndefined()
    const e = refusal(call(a, 'update_link', { link_id: linkId }))
    expect(e.code).toBe('invalid_params')
    expect(e.message).toMatch(/at least one of add_layer_ids, remove_layer_ids, label/)
  })
})

describe('update_composition { duration_us: null }', () => {
  it('unpins the duration and refits it to the layers', () => {
    const a = actorWithPool()
    threeClips(a)
    expect(call(a, 'update_composition', { patch: { duration_us: 30_000_000 } }).ok).toBe(true)
    expect(root(a.snapshot()).duration_pinned).toBe(true)
    expect(root(a.snapshot()).duration_us).toBe(30_000_000)
    expect(call(a, 'update_composition', { patch: { duration_us: null } }).ok).toBe(true)
    expect(root(a.snapshot()).duration_pinned).toBe(false)
    expect(root(a.snapshot()).duration_us).toBe(3_000_000)
  })

  it('refuses the unpin beside a canvas field, naming what to send separately', () => {
    const a = actorWithPool()
    const e = refusal(call(a, 'update_composition', { patch: { duration_us: null, width: 640 } }))
    expect(e.code).toBe('invalid_params')
    expect(e.message).toMatch(/duration_us: null.*width/)
  })

  it('the retired fit tool is gone', () => {
    const a = actorWithPool()
    expect(refusal(call(a, 'fit_composition_to_layers', {})).code).toBe('not_found')
  })
})

describe('read_project', () => {
  it('serves the project views the resources serve, as text', () => {
    const a = actorWithPool()
    const [c1] = threeClips(a)
    const tracks = json<Array<{ id: string; layers: Array<{ id: string }> }>>(call(a, 'read_project', { view: 'tracks' }))
    expect(tracks.map((t) => t.id)).toEqual(root(a.snapshot()).tracks.map((t) => t.id))
    expect(json<{ id: string }>(call(a, 'read_project', { view: 'layer', id: c1 })).id).toBe(c1)
    expect(json<{ ops: unknown[] }>(call(a, 'read_project', { view: 'history' })).ops.length).toBeGreaterThan(0)
    expect(json<Array<{ id: string; ref_count: number }>>(call(a, 'read_project', { view: 'compositions' }))).toHaveLength(1)
    expect(Object.keys(json<Record<string, unknown>>(call(a, 'read_project', { view: 'media' })))).toEqual(expect.arrayContaining([IMAGE, VIDEO]))
  })

  it('refuses an unknown view or a layer view without an id, and reports an unknown composition as not found', () => {
    const a = actorWithPool()
    expect(refusal(call(a, 'read_project', { view: 'nope' })).message).toMatch(/view must be one of/)
    expect(refusal(call(a, 'read_project', { view: 'layer' })).code).toBe('invalid_params')
    expect(refusal(call(a, 'read_project', { view: 'tracks', composition_id: NOWHERE })).code).toBe('not_found')
  })
})

describe('add_video_layer source bounds', () => {
  it('an Image needs no source window; a Video still does', () => {
    const a = actorWithPool()
    expect(call(a, 'add_video_layer', { track_id: bRoll(a), media_id: IMAGE, t_start_us: 0, t_end_us: 1_000_000 }).ok).toBe(true)
    const e = refusal(call(a, 'add_video_layer', { track_id: aRoll(a), media_id: VIDEO, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(e.code).toBe('invalid_params')
    expect(e.message).toMatch(/src_in_us and src_out_us are required for Video/)
  })
})

describe('set_position path nodes', () => {
  const node = (id: string, x: number) => ({ id, point: { x, y: 0 }, in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line', tangent_mode: 'Corner' })
  it('takes snake_case nodes and reads them back the same way', () => {
    const a = actorWithPool()
    const layerId = text(call(a, 'add_text_layer', { track_id: bRoll(a), t_start_us: 0, t_end_us: 4_000_000, content: 'p' }))
    const position = { mode: 'Path', path: { nodes: [node('a', 0), node('b', 100)] }, progress: { mode: 'Static', value: 0 } }
    expect(call(a, 'set_position', { layer_id: layerId, position }).ok).toBe(true)
    const back = text(call(a, 'read_project', { view: 'layer', id: layerId }))
    expect(back).toContain('"tangent_mode": "Corner"')
    expect(back).not.toMatch(/inHandle|outHandle|tangentMode/)
  })
  it('refuses the old camelCase spelling', () => {
    const a = actorWithPool()
    const layerId = text(call(a, 'add_text_layer', { track_id: bRoll(a), t_start_us: 0, t_end_us: 4_000_000, content: 'p' }))
    const old = { id: 'a', point: { x: 0, y: 0 }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line', tangentMode: 'Corner' }
    const e = refusal(call(a, 'set_position', { layer_id: layerId, position: { mode: 'Path', path: { nodes: [old, node('b', 100)] }, progress: { mode: 'Static', value: 0 } } }))
    expect(e.message).toMatch(/tangent_mode/)
  })
})

describe('renamed tools', () => {
  it('answer under the new names and not the old', () => {
    const a = actorWithPool()
    const [c1] = threeClips(a)
    expect(call(a, 'delete_track', { track_id: NOWHERE }).ok).toBe(false) // known tool, unknown track
    for (const [tool, args] of [
      ['create_link', { layer_ids: [c1, c1] }], ['delete_link', { link_id: NOWHERE }], ['create_group', { layer_ids: [NOWHERE] }],
      ['add_group_members', { layer_ids: [NOWHERE], group_layer_id: NOWHERE }], ['ungroup_layer', { layer_id: NOWHERE }],
      ['rename_composition', { composition_id: NOWHERE, label: 'x' }], ['delete_media', { media_id: NOWHERE }],
      ['delete_effect', { layer_id: NOWHERE, effect_id: NOWHERE }], ['delete_transition', { transition_id: NOWHERE }],
      ['delete_marker', { marker_id: NOWHERE }], ['delete_keyframe', { layer_id: NOWHERE, param_key: 'opacity', keyframe_id: NOWHERE }],
    ] as const) {
      expect(refusal(call(a, tool, args as Record<string, unknown>)).code, tool).not.toBe('not_found')
    }
    for (const old of ['remove_track', 'remove_media', 'remove_effect', 'remove_transition', 'remove_marker', 'remove_keyframe',
      'links_create', 'links_dissolve', 'links_add_members', 'links_remove_members', 'links_rename',
      'groups_create', 'groups_add_members', 'groups_ungroup', 'groups_rename'])
      expect(refusal(call(a, old, {})).code, old).toBe('not_found')
  })
})
