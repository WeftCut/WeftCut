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
  it('serves a state view as a pretty JSON application/json block, and no whole-project view', () => {
    const actor = mkActor()
    const out = serveProjectResource('project://settings', actor)!
    expect((out as { contents: Array<{ mimeType: string; text: string }> }).contents[0].mimeType).toBe('application/json')
    expect(text(out)).toContain('\n  ')
    // project://current is gone: every part of it has a smaller view.
    expect(serveProjectResource('project://current', actor)).toBeNull()
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
    const r = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ track_id: track, t_start_us: 0, t_end_us: 1_000_000, content: { kind: 'color', color: { r: 0, g: 0, b: 0, a: 1 } } }] }))
    expect(r.ok).toBe(true)
    const layerId = root(actor.snapshot()).tracks.flatMap((t) => t.layers)[0].id
    expect(JSON.parse(text(serveProjectResource(`project://layers/${layerId}`, actor))).id).toBe(layerId)
  })
  it('throws not-found for an absent layer id', () => {
    expect(() => serveProjectResource('project://layers/gone', mkActor())).toThrow(/not found/)
    // MCP's resource-not-found, not JSON-RPC "method not found" (-32601).
    try { serveProjectResource('project://layers/gone', mkActor()) } catch (e) { expect((e as { code?: number }).code).toBe(-32002) }
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
    expect(comp.composition_id).toBe(p.root_id)
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
      expect.objectContaining({ composition_id: p.root_id, label: null, ref_count: 0 }),
      expect.objectContaining({ composition_id: groupId, ref_count: 1, duration_us: 1_000_000 }),
    ]))
    expect(JSON.parse(text(serveProjectResource(`project://tracks?composition=${groupId}`, actor)))).toHaveLength(2)
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(p).tracks.length)
    expect(JSON.parse(text(serveProjectResource(`project://markers?composition=${groupId}`, actor)))).toEqual([])
    expect(() => serveProjectResource('project://tracks?composition=ghost', actor)).toThrow(/not found/)
  })

  it('project://composition scopes too — a Group\'s settings by id, not the root under the wrong name', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    const scoped = JSON.parse(text(serveProjectResource(`project://composition?composition=${groupId}`, actor)))
    expect(scoped.composition_id).toBe(groupId)
    expect(JSON.parse(text(serveProjectResource('project://composition', actor))).composition_id).toBe(p.root_id)
    expect(() => serveProjectResource('project://composition?composition=ghost', actor)).toThrow(/not found/)
  })

  it('refuses an unknown query key and a scope on a project-wide view', () => {
    // A misspelt key silently answered the ROOT under the URI the caller wrote
    // — the wrong object, reported as the right one.
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    expect(() => serveProjectResource(`project://tracks?compositon=${groupId}`, actor)).toThrow(/unknown query key/)
    expect(() => serveProjectResource(`project://media?name=clip`, actor)).toThrow(/unknown query key/)
    expect(() => serveProjectResource(`project://current?composition=${groupId}`, actor)).toThrow(/no .*scope/)
  })

  it('project://links and project://transitions scope the same way', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    expect(JSON.parse(text(serveProjectResource(`project://links?composition=${groupId}`, actor)))).toEqual(p.compositions[groupId].links)
    expect(JSON.parse(text(serveProjectResource('project://transitions', actor)))).toEqual(root(p).transitions)
    expect(() => serveProjectResource('project://links?composition=ghost', actor)).toThrow(/not found/)
  })

  it('rows are the records the edits answer with — one id key name for a read and a write', () => {
    const gen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(gen, 'rows'), idGen: gen, clock: () => '<TS>' })
    const call = (name: string, args: unknown) => {
      const r = actor.mcpCall(name, JSON.stringify(args))
      if (!r.ok) throw new Error(r.error.message)
      const { adjusted: _a, ...rec } = JSON.parse(r.result.content[0].text) as Record<string, unknown>
      return rec
    }
    const track = root(actor.snapshot()).tracks[0].id
    const color = { kind: 'color', color: { r: 0, g: 0, b: 0, a: 255 } }
    const placed = call('add_layers', { layers: [{ track_id: track, t_start_us: 0, t_end_us: 2_000_000, content: color }, { track_id: track, t_start_us: 2_000_000, t_end_us: 4_000_000, content: color }] }) as { layers: Array<{ layer_id: string }> }
    const [a, b] = placed.layers.map((l) => l.layer_id)
    const other = (call('add_layers', { layers: [{ track_id: root(actor.snapshot()).tracks[1].id, t_start_us: 0, t_end_us: 2_000_000, content: color }] }) as { layers: Array<{ layer_id: string }> }).layers[0]!.layer_id
    const link = call('create_link', { layer_ids: [a, other] })
    const marker = call('add_marker', { t_us: 1_000_000, t_end_us: 2_000_000, label: 'm' })
    const transition = call('add_transition', { from_layer_id: a, to_layer_id: b, duration_us: 500_000 })
    const rows = (uri: string) => JSON.parse(text(serveProjectResource(uri, actor))) as Array<Record<string, unknown>>
    expect(rows('project://links')).toEqual([expect.objectContaining({ link_id: link.link_id, members: expect.arrayContaining([a, other]) })])
    expect(rows('project://markers')).toEqual([marker])
    expect(rows('project://markers')[0]).toMatchObject({ t_end_us: 2_000_000 })
    expect(rows('project://transitions')).toEqual([expect.objectContaining({ transition_id: transition.transition_id, from_layer_id: a, to_layer_id: b })])
    for (const uri of ['project://links', 'project://markers', 'project://transitions', 'project://compositions'])
      for (const row of rows(uri)) expect('id' in row, uri).toBe(false)
  })
})

describe('project://tracks lists envelopes', () => {
  it('a layer row is the envelope — kind at the top, no params, its link, its effects by kind, its keyframed params', () => {
    const gen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(gen, 'env'), idGen: gen, clock: () => '<TS>' })
    const aRoll = root(actor.snapshot()).tracks[0].id
    const added = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ track_id: aRoll, t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'color', color: { r: 0, g: 0, b: 0, a: 255 } } }] }))
    if (!added.ok) throw new Error(added.error.message)
    const layerId = (JSON.parse(added.result.content[0].text) as { layers: Array<{ layer_id: string }> }).layers[0]!.layer_id
    const title = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ track_id: root(actor.snapshot()).tracks[1].id, t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'text', content: 'Hi' } }] }))
    if (!title.ok) throw new Error(title.error.message)
    const titleId = (JSON.parse(title.result.content[0].text) as { layers: Array<{ layer_id: string }> }).layers[0]!.layer_id
    const link = actor.mcpCall('create_link', JSON.stringify({ layer_ids: [layerId, titleId] }))
    if (!link.ok) throw new Error(link.error.message)
    const effect = actor.mcpCall('add_effect', JSON.stringify({ layer_id: titleId, kind: 'blur' }))
    if (!effect.ok) throw new Error(effect.error.message)
    const key = actor.mcpCall('set_keyframe', JSON.stringify({ layer_id: titleId, param_key: 'opacity', t_us: 0, value: 1 }))
    if (!key.ok) throw new Error(key.error.message)

    const tracks = JSON.parse(text(serveProjectResource('project://tracks', actor))) as Array<{ track_id: string; layers: Array<Record<string, unknown>> }>
    const rows = tracks.flatMap((tr) => tr.layers)
    const color = rows.find((r) => r.layer_id === layerId)!
    const textRow = rows.find((r) => r.layer_id === titleId)!
    expect(color).toEqual({
      layer_id: layerId, label: null, kind: 'Color', t_start_us: 0, t_end_us: 2_000_000,
      enabled: true, locked: false, link_id: JSON.parse(link.result.content[0].text).link_id,
      effects: [], keyframed: [],
    })
    expect('params' in color).toBe(false)
    expect(textRow.kind).toBe('Text')
    expect(textRow.link_id).toBe(color.link_id)
    expect(textRow.effects).toEqual([{ effect_id: JSON.parse(effect.result.content[0].text).effect_id, kind: 'blur' }])
    // What tells it apart from another title rides the row.
    expect(textRow.content).toBe('Hi')
    expect(textRow.keyframed).toEqual(['opacity'])
    // The full record is still one read away.
    const full = JSON.parse(text(serveProjectResource(`project://layers/${titleId}`, actor)))
    expect(full.params.kind).toBe('Text')
    expect(full.params.opacity.mode).toBe('Keyframed')
    // Stored key times are layer-local, and the wire names them so.
    expect(full.params.opacity.value[0]).toMatchObject({ local_t_us: 0 })
    expect(JSON.stringify(full)).not.toMatch(/"t_us"/)
  })

  it('a media-bearing layer carries its source window; the track keeps its own flags', () => {
    const gen = uuidV7Gen()
    const p = blankProject(gen, 'env')
    const MID = '00000000-0000-0000-0000-0000000000aa'
    p.media_pool[MID] = mediaItemTemplate(MID, 'Video', 4_000_000)
    const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    const aRoll = root(actor.snapshot()).tracks[0].id
    const added = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ track_id: aRoll, t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'video', media_id: MID, src_in_us: 500_000 } }] }))
    if (!added.ok) throw new Error(added.error.message)
    const tracks = JSON.parse(text(serveProjectResource('project://tracks', actor))) as Array<Record<string, unknown> & { layers: Array<Record<string, unknown>> }>
    const row = tracks[0].layers[0]
    expect(row).toMatchObject({ kind: 'VideoClip', media_id: MID, src_in_us: 500_000, src_out_us: 2_500_000 })
    // Identity rate stays off the row; a retimed one rides it, so a source
    // time maps onto the timeline from the envelope alone.
    expect('rate' in row).toBe(false)
    const retimed = actor.mcpCall('retime_layers', JSON.stringify({ layer_ids: [row.layer_id], target: { kind: 'Rate', value: { num: 2, den: 1 } } }))
    if (!retimed.ok) throw new Error(retimed.error.message)
    const after = (JSON.parse(text(serveProjectResource('project://tracks', actor))) as typeof tracks)[0].layers[0]
    expect(after.rate).toEqual({ num: 2, den: 1 })
    expect(tracks[0]).toMatchObject({ track_id: aRoll, enabled: true, locked: false })
    expect('id' in tracks[0]).toBe(false)
    expect(Object.keys(tracks[0])).toContain('role')
    // Per-track mute/solo have no writer and nothing mixes by them: a control
    // the read does not advertise (mute and solo are per ROLE — set_role_flags).
    expect(Object.keys(tracks[0])).not.toContain('muted')
    expect(Object.keys(tracks[0])).not.toContain('solo')
  })

  it('names what each kind is, so a layer is found without a per-layer read', () => {
    const gen = uuidV7Gen()
    const p = blankProject(gen, 'env')
    const AID = '00000000-0000-0000-0000-0000000000ab'
    p.media_pool[AID] = mediaItemTemplate(AID, 'Audio', 4_000_000)
    const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    const tracks = () => JSON.parse(text(serveProjectResource('project://tracks', actor))) as Array<{ layers: Array<Record<string, unknown>> }>
    const add = (content: Record<string, unknown>, t0: number) => {
      const r = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: t0, t_end_us: t0 + 1_000_000, content }] }))
      if (!r.ok) throw new Error(r.error.message)
      return (JSON.parse(r.result.content[0].text) as { layers: Array<{ layer_id: string }> }).layers[0]!.layer_id
    }
    const long = 'A title long enough that the envelope has to cut it short, because rows are not paragraphs at all'
    const text1 = add({ kind: 'text', content: long }, 0)
    const music = add({ kind: 'audio', media_id: AID, src_in_us: 0, role: 'music' }, 0)
    const row = (id: string) => tracks().flatMap((t) => t.layers).find((l) => l.layer_id === id)!
    expect([...(row(text1).content as string)]).toHaveLength(80)
    expect((row(text1).content as string).endsWith('…')).toBe(true)
    expect(row(music)).toMatchObject({ kind: 'Audio', media_id: AID, role: 'music' })
    const group = actor.mcpCall('create_group', JSON.stringify({ layer_ids: [text1] }))
    if (!group.ok) throw new Error(group.error.message)
    const g = JSON.parse(group.result.content[0].text) as { layer_id: string; composition_id: string }
    expect(row(g.layer_id)).toMatchObject({ kind: 'CompositionRef', composition_id: g.composition_id })
  })
})

describe('project://settings', () => {
  it('is the preferences, the role mix and the metadata — without the whole project', () => {
    const gen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(gen, 'set'), idGen: gen, clock: () => '<TS>' })
    expect(actor.mcpCall('set_role_gain', JSON.stringify({ role: 'music', gain_db: -6 })).ok).toBe(true)
    const body = JSON.parse(text(serveProjectResource('project://settings', actor)))
    expect(body).toEqual({ ...actor.snapshot().settings, audio_roles: actor.snapshot().audio_roles, metadata: actor.snapshot().metadata })
    expect(body.audio_roles.music).toEqual({ gain_db: -6, muted: false, solo: false })
    expect(body.metadata.name).toBe('set')
    expect('compositions' in body).toBe(false)
  })
})
