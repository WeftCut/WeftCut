// apps/desktop/src/main/state/__tests__/mcp.graphic-role.test.ts
// `graphic_role` (H1-D1) over the wire: set at creation on the three kinds that
// carry it (a Motif defaulting to its manifest's), set and cleared through
// update_layer_params, refused when malformed, and reported in the record and
// the read view.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { layerParamsView } from '../summary'
import { layerEnvelope } from '../resource-views'
import { MotifCatalog, type Manifest } from '../../../shared/motifs/catalog'
import { root } from './fixtures/project'

const IMAGE = '00000000-0000-0000-0000-0000000000a3'
const VIDEO = '00000000-0000-0000-0000-0000000000a5'
const TAGGED: Manifest = {
  id: 'tagged-lower-third', name: 'Tagged', version: 1, size: [640, 160], default_duration_s: 3,
  props_schema: {}, graphic_role: 'lower_third',
}

function actor() {
  const gen = seededGen()
  const p: Project = blankProject(gen, 'graphic-role')
  p.media_pool[IMAGE] = mediaItemTemplate(IMAGE, 'Image', null)
  p.media_pool[VIDEO] = mediaItemTemplate(VIDEO, 'Video', 10_000_000)
  const motifCatalog = new MotifCatalog()
  motifCatalog.setUserManifests([TAGGED])
  return createActor({ initial: p, idGen: gen, clock: () => '<TS>', motifCatalog })
}
type Actor = ReturnType<typeof actor>

const call = (a: Actor, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const bRoll = (a: Actor) => root(a.snapshot()).tracks[1].id
function record(r: ReturnType<Actor['mcpCall']>): Record<string, unknown> {
  expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
  if (!r.ok) throw new Error('call failed')
  return JSON.parse(r.result.content[0].text) as Record<string, unknown>
}
function refusal(r: ReturnType<Actor['mcpCall']>): string {
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.error.message
}
function layerOf(a: Actor, id: unknown): Layer {
  for (const c of Object.values(a.snapshot().compositions)) for (const t of c.tracks) {
    const l = t.layers.find((x) => x.id === id)
    if (l) return l
  }
  throw new Error(`layer ${String(id)} not found`)
}
const roleOf = (a: Actor, id: unknown) => (layerOf(a, id).params as { graphic_role?: unknown }).graphic_role

describe('graphic_role at creation', () => {
  it('add_text_layer: untagged by default, the argument when given, and reported in the record', () => {
    const a = actor()
    const plain = record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000 }))
    expect(plain.graphic_role).toBeNull()
    expect(roleOf(a, plain.layer_id)).toBeNull()
    const title = record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'B', t_start_us: 2_000_000, t_end_us: 3_000_000, graphic_role: 'title' }))
    expect(title.graphic_role).toBe('title')
    expect(roleOf(a, title.layer_id)).toBe('title')
  })

  it('accepts a well-formed custom role and refuses a malformed one before committing', () => {
    const a = actor()
    const custom = record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000, graphic_role: 'chapter_card' }))
    expect(roleOf(a, custom.layer_id)).toBe('chapter_card')
    const before = a.snapshot()
    for (const bad of ['Title', 'lower-third', '1st', '', 'x'.repeat(33), 7]) {
      expect(refusal(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'B', t_start_us: 2_000_000, t_end_us: 3_000_000, graphic_role: bad }))).toMatch(/graphic_role/)
    }
    expect(a.snapshot()).toBe(before)
  })

  it('add_motif_layer: the manifest role by default, an explicit role or null overriding it', () => {
    const a = actor()
    const fromManifest = record(call(a, 'add_motif_layer', { motif_id: TAGGED.id, t_start_us: 0 }))
    expect(fromManifest.graphic_role).toBe('lower_third')
    const overridden = record(call(a, 'add_motif_layer', { motif_id: TAGGED.id, t_start_us: 0, graphic_role: 'callout' }))
    expect(roleOf(a, overridden.layer_id)).toBe('callout')
    const cleared = record(call(a, 'add_motif_layer', { motif_id: TAGGED.id, t_start_us: 0, graphic_role: null }))
    expect(roleOf(a, cleared.layer_id)).toBeNull()
    // A built-in that declares no role places untagged.
    const builtin = record(call(a, 'add_motif_layer', { motif_id: 'countdown', t_start_us: 0 }))
    expect(roleOf(a, builtin.layer_id)).toBeNull()
  })

  it('the UI add_motif path also takes the manifest role', () => {
    const a = actor()
    const r = a.command('add_motif', { motifId: TAGGED.id, tStartUs: 0 })
    expect(r.ok).toBe(true)
    expect(roleOf(a, r.ok ? r.value : null)).toBe('lower_third')
  })

  it('add_video_layer: an Image takes the role; a Video refuses one', () => {
    const a = actor()
    const img = record(call(a, 'add_video_layer', { track_id: bRoll(a), media_id: IMAGE, t_start_us: 0, t_end_us: 1_000_000, graphic_role: 'logo' }))
    expect(img.graphic_role).toBe('logo')
    expect(roleOf(a, img.layer_id)).toBe('logo')
    const plain = record(call(a, 'add_video_layer', { track_id: bRoll(a), media_id: IMAGE, t_start_us: 2_000_000, t_end_us: 3_000_000 }))
    expect(roleOf(a, plain.layer_id)).toBeNull()
    expect(refusal(call(a, 'add_video_layer', { track_id: bRoll(a), media_id: VIDEO, src_in_us: 0, src_out_us: 1_000_000, t_start_us: 4_000_000, t_end_us: 5_000_000, graphic_role: 'plate' }))).toMatch(/VideoClip carries no graphic role/)
    // The video record carries no role field at all.
    const video = record(call(a, 'add_video_layer', { track_id: bRoll(a), media_id: VIDEO, src_in_us: 0, src_out_us: 1_000_000, t_start_us: 4_000_000, t_end_us: 5_000_000 }))
    expect(video).not.toHaveProperty('graphic_role')
  })

  it('dry_run rehearses the role the wet call would store', () => {
    const a = actor()
    const r = record(call(a, 'dry_run', { operations: [
      { kind: 'add_text_layer', track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000, graphic_role: 'credit' },
      { kind: 'add_video_layer', track_id: bRoll(a), media_id: IMAGE, t_start_us: 2_000_000, t_end_us: 3_000_000, graphic_role: 'plate' },
    ] }))
    expect(r.halted_at).toBeNull()
    expect(refusal(call(a, 'dry_run', { operations: [
      { kind: 'add_text_layer', track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000, graphic_role: 'Bad' },
    ] }))).toMatch(/graphic_role/)
  })
})

describe('graphic_role through update_layer_params', () => {
  it('sets and clears the role on Text, ImageOverlay and Motif', () => {
    const a = actor()
    const ids = [
      ['Text', record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000 })).layer_id],
      ['ImageOverlay', record(call(a, 'add_video_layer', { track_id: bRoll(a), media_id: IMAGE, t_start_us: 2_000_000, t_end_us: 3_000_000 })).layer_id],
      ['Motif', record(call(a, 'add_motif_layer', { motif_id: TAGGED.id, t_start_us: 0 })).layer_id],
    ] as const
    for (const [kind, id] of ids) {
      record(call(a, 'update_layer_params', { layer_id: id, patch: { kind, graphic_role: 'callout' } }))
      expect(roleOf(a, id)).toBe('callout')
      record(call(a, 'update_layer_params', { layer_id: id, patch: { kind, graphic_role: null } }))
      expect(roleOf(a, id)).toBeNull()
    }
  })

  it('refuses a malformed role, and the role on a kind that has none', () => {
    const a = actor()
    const text = record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000 })).layer_id
    expect(refusal(call(a, 'update_layer_params', { layer_id: text, patch: { kind: 'Text', graphic_role: 'Lower Third' } }))).toMatch(/graphic_role/)
    expect(roleOf(a, text)).toBeNull()
    const color = record(call(a, 'add_color_layer', { track_id: root(a.snapshot()).tracks[0].id, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 })).layer_id
    expect(refusal(call(a, 'update_layer_params', { layer_id: color, patch: { kind: 'Color', graphic_role: 'plate' } }))).toMatch(/'graphic_role' is not a Color param/)
  })

  it('a Motif rebind keeps the layer role', () => {
    const a = actor()
    const id = record(call(a, 'add_motif_layer', { motif_id: TAGGED.id, t_start_us: 0 })).layer_id
    record(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Motif', motif_id: 'countdown' } }))
    expect(roleOf(a, id)).toBe('lower_third')
  })
})

describe('graphic_role in the read view', () => {
  it('layerParamsView reports it for the three kinds', () => {
    const a = actor()
    const id = record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000, graphic_role: 'title' })).layer_id
    expect(layerParamsView(layerOf(a, id).params, a.snapshot().media_pool)).toMatchObject({ kind: 'Text', graphic_role: 'title' })
  })
  it('the project://tracks envelope carries it for those kinds only', () => {
    const a = actor()
    const id = record(call(a, 'add_text_layer', { track_id: bRoll(a), content: 'A', t_start_us: 0, t_end_us: 1_000_000, graphic_role: 'credit' })).layer_id
    const color = record(call(a, 'add_color_layer', { track_id: root(a.snapshot()).tracks[0].id, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 })).layer_id
    const c = root(a.snapshot())
    expect(layerEnvelope(layerOf(a, id), c)).toHaveProperty('graphic_role', 'credit')
    expect(layerEnvelope(layerOf(a, color), c)).not.toHaveProperty('graphic_role')
  })
})
