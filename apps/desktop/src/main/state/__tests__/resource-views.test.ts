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
})
