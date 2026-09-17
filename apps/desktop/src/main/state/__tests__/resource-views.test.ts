import { describe, it, expect } from 'vitest'
import { serveProjectResource, buildResourceInjection, compositionSettings } from '../resource-views'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { groupedProject, root, withGroup } from './fixtures/project'
import { applyAddLayer, colorParams } from '../mutations/add'

function mkActor() {
  const idGen = uuidV7Gen()
  return createActor({ initial: blankProject(idGen, 'rv'), idGen, clock: () => '<TS>' })
}
function text(out: ReturnType<typeof serveProjectResource>): string {
  return (out as { contents: Array<{ text: string }> }).contents[0].text
}

describe('serveProjectResource', () => {
  it('serves project://current as a pretty JSON application/json block', () => {
    const actor = mkActor()
    const out = serveProjectResource('project://current', actor)!
    expect((out as { contents: Array<{ mimeType: string }> }).contents[0].mimeType).toBe('application/json')
    expect(JSON.parse(text(out)).project_id).toBe(actor.snapshot().project_id)
  })
  it('serves project://history with the {ops,cursor,len,checkpoints} shape', () => {
    const actor = mkActor()
    const body = JSON.parse(text(serveProjectResource('project://history', actor)))
    expect(Array.isArray(body.ops)).toBe(true)
    expect(body).toMatchObject({ cursor: expect.any(Number), len: expect.any(Number), checkpoints: expect.any(Array) })
    // Whole stack fits in view(100) → the window IS the stack.
    expect(body.window_start).toBe(0)
  })

  /// The resource serves `view(100)` against a cap of 200, so `ops` is routinely
  /// a WINDOW: `cursor` is an absolute stack index that can sit past the end of
  /// the array handed over, and `evicted: 0` does NOT mean "the first op is the
  /// start of the project". `window_start` is the only field that says where the
  /// window begins — docs/mcp.md promises it.
  it('reports window_start when the stack is longer than the served window', () => {
    const actor = mkActor()
    for (let i = 0; i < 149; i++) {
      const r = actor.mcpCall('add_track', JSON.stringify({ label: `t${i}` }))
      expect(r.ok).toBe(true)
    }
    const body = JSON.parse(text(serveProjectResource('project://history', actor)))
    expect(body.len).toBe(150)          // seed + 149, still under the 200 cap
    expect(body.evicted).toBe(0)        // nothing dropped: the STACK holds it all
    expect(body.ops).toHaveLength(100)  // …but the WINDOW does not
    expect(body.window_start).toBe(50)
    expect(body.cursor).toBe(149)
    // The two identities a consumer needs to read any of it correctly.
    expect(body.window_start + body.ops.length).toBe(body.len)
    expect(body.cursor).toBeGreaterThan(body.ops.length)
  })
  it('serves composition / tracks from the snapshot', () => {
    const actor = mkActor()
    const snap = actor.snapshot()
    // The root's SETTINGS projection, not the whole root (docs/mcp.md: "composition only").
    expect(JSON.parse(text(serveProjectResource('project://composition', actor)))).toEqual(structuredClone(compositionSettings(root(snap))))
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(snap).tracks.length)
  })
  it('serves a single layer for project://layers/{id}', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    const r = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(r.ok).toBe(true)
    const layerId = root(actor.snapshot()).tracks.flatMap((t) => t.layers)[0].id
    expect(JSON.parse(text(serveProjectResource(`project://layers/${layerId}`, actor))).id).toBe(layerId)
  })
  it('throws not-found for an absent layer id', () => {
    expect(() => serveProjectResource('project://layers/gone', mkActor())).toThrow(/not found/)
  })
  it('returns null for the Rust-compute resources', () => {
    const actor = mkActor()
    expect(serveProjectResource('project://compiled', actor)).toBeNull()
    expect(serveProjectResource('media://x/thumbnail', actor)).toBeNull()
    expect(serveProjectResource('composition://meter', actor)).toBeNull()
  })
})

describe('buildResourceInjection', () => {
  it('injects the full project for project://compiled', () => {
    const actor = mkActor()
    expect(JSON.parse(buildResourceInjection('project://compiled', actor.snapshot())).project.project_id)
      .toBe(actor.snapshot().project_id)
  })
  it('injects the resolved MediaItem for media://{id}/...', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    expect(JSON.parse(buildResourceInjection('media://m1/waveform', snap)).media.id).toBe('m1')
  })
  it('injects media:null when the id is absent', () => {
    const actor = mkActor()
    expect(JSON.parse(buildResourceInjection('media://gone/thumbnail', actor.snapshot())).media).toBeNull()
  })
  it('injects only the MediaItem for the self-contained media://{id}/analysis view (no vlm_config)', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(buildResourceInjection('media://m1/analysis', snap, { qwen3_vl: {} }))
    expect(injected.media.id).toBe('m1')
    expect('vlm_config' in injected).toBe(false)
  })
  // The field names here are the contract with Rust's `ResourceState`. A rename
  // on either side degrades in silence: the reader keys the bare-core view, finds
  // nothing, and every source reports as undescribed.
  it('injects the config AND the whole describe view for media://{id}/description', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(
      buildResourceInjection('media://m1/description', snap, { qwen3_vl: {} }, {
        language: 'zh-CN',
        fps: 2.5,
        focus: 'shot-type',
        preferred: 'byo_endpoint',
      }),
    )
    expect(injected.media.id).toBe('m1')
    expect(injected.vlm_config).toEqual({ qwen3_vl: {} })
    expect(injected.language).toBe('zh-CN')
    expect(injected.describe_fps).toBe(2.5)
    expect(injected.describe_focus).toBe('shot-type')
    // The FOURTH axis, and the one whose absence is hardest to see: the backend
    // the preference resolves and that backend's model label are both hashed
    // into the key, so a read that omitted it would walk the plain availability
    // order and answer out of an entry `describe_clip` never writes.
    expect(injected.describe_preferred).toBe('byo_endpoint')
  })

  // "auto" is the setting's way of saying "no preference" — the same value the
  // tool path declines to send as `preferred_backend`. Sending it would be a tag
  // no backend answers to, which is harmless, but the two sides must state the
  // rule identically or one day only one of them will.
  it('treats an auto preference as no preference', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(
      buildResourceInjection('media://m1/description', snap, {}, { preferred: 'auto' }),
    )
    expect('describe_preferred' in injected).toBe(false)
  })

  // No UI to speak for → nothing injected, so Rust's own defaults decide. The
  // `detectPauses` rule: one statement of a default, on the side that owns it.
  it('injects no view axis the provider has none for', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(buildResourceInjection('media://m1/description', snap, {}))
    expect('language' in injected).toBe(false)
    expect('describe_fps' in injected).toBe(false)
    expect('describe_focus' in injected).toBe(false)
    expect('describe_preferred' in injected).toBe(false)
  })

  it('injects nothing for composition://meter', () => {
    const actor = mkActor()
    expect(buildResourceInjection('composition://meter', actor.snapshot())).toBe('{}')
  })
})

describe('serveProjectResource across compositions', () => {
  it('project://layers/{id} finds a layer inside a Group; project://tracks stays the root', () => {
    const gen = uuidV7Gen()
    const initial = blankProject(gen, 'r')
    const { p, groupId } = withGroup(initial, gen, (g, view) => applyAddLayer(view, gen, g.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9), 0, 1_000_000))
    const actor = createActor({ initial: p, idGen: gen })
    const inner = p.compositions[groupId].tracks[0].layers[0]
    const text = (r: ReturnType<typeof serveProjectResource>) => (r as { contents: Array<{ text: string }> }).contents[0].text
    expect(JSON.parse(text(serveProjectResource(`project://layers/${inner.id}`, actor))).id).toBe(inner.id)
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(p).tracks.length)
    const comp = JSON.parse(text(serveProjectResource('project://composition', actor)))
    expect(comp.id).toBe(p.root_id)
    expect('tracks' in comp).toBe(false)
  })
})

describe('project://compositions and the ?composition= scope', () => {
  it('lists every composition with its ref_count; tracks / markers select a composition, root when unscoped', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    const rows = JSON.parse(text(serveProjectResource('project://compositions', actor)))
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: p.root_id, label: null, ref_count: 0 }),
      expect.objectContaining({ id: groupId, ref_count: 1, duration_us: 1_000_000 }),
    ]))
    expect(JSON.parse(text(serveProjectResource(`project://tracks?composition=${groupId}`, actor)))).toHaveLength(2)
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(p).tracks.length)
    expect(JSON.parse(text(serveProjectResource(`project://markers?composition=${groupId}`, actor)))).toEqual([])
    expect(() => serveProjectResource('project://tracks?composition=ghost', actor)).toThrow(/not found/)
  })

  it('project://composition scopes too — a Group\'s settings by id, not the root under the wrong name (audit S14)', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    const scoped = JSON.parse(text(serveProjectResource(`project://composition?composition=${groupId}`, actor)))
    expect(scoped.id).toBe(groupId)
    expect(JSON.parse(text(serveProjectResource('project://composition', actor))).id).toBe(p.root_id)
    expect(() => serveProjectResource('project://composition?composition=ghost', actor)).toThrow(/not found/)
  })

  it('project://links and project://transitions scope the same way', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    expect(JSON.parse(text(serveProjectResource(`project://links?composition=${groupId}`, actor)))).toEqual(p.compositions[groupId].links)
    expect(JSON.parse(text(serveProjectResource('project://transitions', actor)))).toEqual(root(p).transitions)
    expect(() => serveProjectResource('project://links?composition=ghost', actor)).toThrow(/not found/)
  })
})

describe('project://tracks lists envelopes (audit D19)', () => {
  it('a layer row is the envelope — kind at the top, no params, its link, its effects by kind, its keyframed params', () => {
    const gen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(gen, 'env'), idGen: gen, clock: () => '<TS>' })
    const aRoll = root(actor.snapshot()).tracks[0].id
    const added = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: aRoll, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 2_000_000 }))
    if (!added.ok) throw new Error(added.error.message)
    const layerId = (JSON.parse(added.result.content[0].text) as { layer_id: string }).layer_id
    const title = actor.mcpCall('add_text_layer', JSON.stringify({ track_id: root(actor.snapshot()).tracks[1].id, content: 'Hi', t_start_us: 0, t_end_us: 2_000_000 }))
    if (!title.ok) throw new Error(title.error.message)
    const titleId = (JSON.parse(title.result.content[0].text) as { layer_id: string }).layer_id
    const link = actor.mcpCall('create_link', JSON.stringify({ layer_ids: [layerId, titleId] }))
    if (!link.ok) throw new Error(link.error.message)
    const effect = actor.mcpCall('add_effect', JSON.stringify({ layer_id: titleId, kind: 'blur' }))
    if (!effect.ok) throw new Error(effect.error.message)
    const key = actor.mcpCall('set_keyframe', JSON.stringify({ layer_id: titleId, param_key: 'opacity', t_us: 0, value: 1 }))
    if (!key.ok) throw new Error(key.error.message)

    const tracks = JSON.parse(text(serveProjectResource('project://tracks', actor))) as Array<{ id: string; layers: Array<Record<string, unknown>> }>
    const rows = tracks.flatMap((tr) => tr.layers)
    const color = rows.find((r) => r.id === layerId)!
    const textRow = rows.find((r) => r.id === titleId)!
    expect(color).toEqual({
      id: layerId, label: null, kind: 'Color', t_start_us: 0, t_end_us: 2_000_000,
      enabled: true, locked: false, link_id: JSON.parse(link.result.content[0].text).link_id,
      effects: [], keyframed: [],
    })
    expect('params' in color).toBe(false)
    expect(textRow.kind).toBe('Text')
    expect(textRow.link_id).toBe(color.link_id)
    expect(textRow.effects).toEqual([{ id: JSON.parse(effect.result.content[0].text).effect_id, kind: 'blur' }])
    expect(textRow.keyframed).toEqual(['opacity'])
    // The full record is still one read away.
    const full = JSON.parse(text(serveProjectResource(`project://layers/${titleId}`, actor)))
    expect(full.params.kind).toBe('Text')
    expect(full.params.opacity.mode).toBe('Keyframed')
  })

  it('a media-bearing layer carries its source window; the track keeps its own flags', () => {
    const gen = uuidV7Gen()
    const p = blankProject(gen, 'env')
    const MID = '00000000-0000-0000-0000-0000000000aa'
    p.media_pool[MID] = mediaItemTemplate(MID, 'Video', 4_000_000)
    const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    const aRoll = root(actor.snapshot()).tracks[0].id
    const added = actor.mcpCall('add_video_layer', JSON.stringify({ track_id: aRoll, media_id: MID, src_in_us: 500_000, src_out_us: 2_500_000, t_start_us: 0, t_end_us: 2_000_000 }))
    if (!added.ok) throw new Error(added.error.message)
    const tracks = JSON.parse(text(serveProjectResource('project://tracks', actor))) as Array<Record<string, unknown> & { layers: Array<Record<string, unknown>> }>
    const row = tracks[0].layers[0]
    expect(row).toMatchObject({ kind: 'VideoClip', src_in_us: 500_000, src_out_us: 2_500_000 })
    expect(tracks[0]).toMatchObject({ id: aRoll, enabled: true, locked: false })
    expect(Object.keys(tracks[0])).toContain('role')
  })
})

describe('project://settings', () => {
  it('is the preferences plus the metadata — six booleans no longer cost the whole project', () => {
    const gen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(gen, 'set'), idGen: gen, clock: () => '<TS>' })
    const body = JSON.parse(text(serveProjectResource('project://settings', actor)))
    expect(body).toEqual({ ...actor.snapshot().settings, metadata: actor.snapshot().metadata })
    expect(body.metadata.name).toBe('set')
    expect('compositions' in body).toBe(false)
  })
})
