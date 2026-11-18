// apps/desktop/src/main/state/__tests__/add-motif.test.ts
// add_motif as a pure TS recorded mutation.
import { describe, it, expect } from 'vitest'
import { routeChannel } from '../router'
import { routeMcpTool } from '../../mcp/mutationTools'
import { createActor } from '../actor'
import { blankProject } from '../model'
import { seededGen } from '../ids'
import { root } from './fixtures/project'
import { libraryMotifs } from './fixtures/motifs'

// ── helpers ──────────────────────────────────────────────────────────────────
function makeActor() {
  const idGen = seededGen()
  const proj = blankProject(idGen, 'test')
  return createActor({ initial: proj, idGen, motifs: libraryMotifs() })
}

// ── a. routing ────────────────────────────────────────────────────────────────
describe('add_motif routing', () => {
  it('routeChannel("add_motif") → {kind:"command"}', () => {
    expect(routeChannel('add_motif').kind).toBe('command')
  })

  it('routeMcpTool("add_layers") → "ts"', () => {
    expect(routeMcpTool('add_layers')).toBe('ts')
  })
})

// ── b. actor.command – no-track path (two-commit, id order) ──────────────────
describe('actor.command("add_motif") — no track_id', () => {
  it('creates Overlay track THEN Motif layer (track id < layer id, idGen order)', () => {
    const actor = makeActor()
    const before = actor.snapshot()
    const trackCountBefore = root(before).tracks.length

    const result = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''

    const snap = actor.snapshot()
    // One new track was created
    expect(root(snap).tracks.length).toBe(trackCountBefore + 1)
    // The new track stores no label — its name is derived renderer-side — and
    // carries no role, so it is the spawned one.
    const overlayTrack = root(snap).tracks.find((t) => t.label === null && t.role === null)
    expect(overlayTrack).toBeDefined()
    // The layer is on the overlay track
    const layer = overlayTrack!.layers.find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    // The returned id is the LAYER id (not the track id)
    expect(layerId).not.toBe(overlayTrack!.id)
    // id order: track id was minted BEFORE layer id (both are UUID v7-seeded, track < layer lexically by minting order)
    expect(overlayTrack!.id < layerId).toBe(true)
  })

  it('layer params: kind=Motif, correct motif_id, canonical defaults, src_in_us=0, identity transform, Static(1) opacity', () => {
    const actor = makeActor()
    const result = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''

    const snap = actor.snapshot()
    const layer = root(snap).tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    const p = layer!.params
    expect(p.kind).toBe('Motif')
    if (p.kind !== 'Motif') return
    expect(p.motif_id).toBe('countdown')
    // Canonical defaults for countdown: accent, label, seconds (alphabetical BTreeMap order)
    expect(p.props).toEqual({ accent: '#ff4d4d', label: 'GO', seconds: 5 })
    expect(p.src_in_us).toBe(0)
    // identity transform
    expect(p.transform).toEqual({
      position: { mode: 'XY' as const, x: { mode: 'Static', value: 240 }, y: { mode: 'Static', value: 240 } },

      scale_x: { mode: 'Static', value: 1 },
      scale_y: { mode: 'Static', value: 1 },
      rotation_deg: { mode: 'Static', value: 0 },
      anchor_x: { mode: 'Static', value: 0.5 }, anchor_y: { mode: 'Static', value: 0.5 },
      scale_linked: true,
    })
    expect(p.opacity).toEqual({ mode: 'Static', value: 1 })
  })

  it('uses default duration from manifest when t_end_us is absent (countdown: 5s)', () => {
    const actor = makeActor()
    const result = actor.command('add_motif', { motifId: 'countdown', tStartUs: 1_000_000 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''
    const snap = actor.snapshot()
    const layer = root(snap).tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    // default_duration_s=5.0 → Math.trunc(5.0*1e6)+1e6 = 6_000_000
    expect(layer!.t_end_us - layer!.t_start_us).toBeGreaterThan(0)
    // t_start_us=1_000_000, t_end=1_000_000+5_000_000=6_000_000 before snap
    // (snap may round to fps grid but direction is correct)
    expect(layer!.t_end_us).toBeGreaterThan(layer!.t_start_us)
  })
})

// ── b. actor.command – with track_id (single-commit) ─────────────────────────
describe('actor.command("add_motif") — with track_id', () => {
  it('uses the provided track, no new track created, returns layer id', () => {
    const actor = makeActor()
    // First add a track manually
    const trackResult = actor.dispatch('add_track', { label: 'MyTrack' })
    expect(trackResult.ok).toBe(true)
    const trackId = trackResult.ok ? trackResult.value as string : ''
    const trackCountBefore = root(actor.snapshot()).tracks.length

    const result = actor.command('add_motif', { motifId: 'countdown', trackId, tStartUs: 0 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''

    const snap = actor.snapshot()
    // No new tracks
    expect(root(snap).tracks.length).toBe(trackCountBefore)
    // Layer is on the specified track
    const track = root(snap).tracks.find((t) => t.id === trackId)
    const layer = track?.layers.find((l) => l.id === layerId)
    expect(layer).toBeDefined()
  })
})

// ── c. reject-before-commit (bad props burn no id) ────────────────────────────
describe('actor.command("add_motif") — reject-before-commit', () => {
  it('unknown prop key → reject, no track/layer committed', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()

    const result = actor.command('add_motif', {
      motifId: 'countdown', tStartUs: 0, props: { unknownKey: 'bad' },
    })
    expect(result.ok).toBe(false)
    const snapAfter = actor.snapshot()
    // No new tracks or layers committed
    expect(root(snapAfter).tracks.length).toBe(root(snapBefore).tracks.length)
    expect(root(snapAfter).tracks.flatMap((t) => t.layers).length)
      .toBe(root(snapBefore).tracks.flatMap((t) => t.layers).length)
  })

  it('unknown motif_id → reject, no track/layer committed', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()

    const result = actor.command('add_motif', { motifId: 'nonexistent-motif', tStartUs: 0 })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { error: string; detail?: string } }).error.error).toBe('InvalidArgument')
    const snapAfter = actor.snapshot()
    expect(root(snapAfter).tracks.length).toBe(root(snapBefore).tracks.length)
  })

  it('invalid prop value (seconds out of range) → reject before commit', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()

    const result = actor.command('add_motif', {
      motifId: 'countdown', tStartUs: 0, props: { seconds: 9999 }, // max is 60
    })
    expect(result.ok).toBe(false)
    const snapAfter = actor.snapshot()
    expect(root(snapAfter).tracks.length).toBe(root(snapBefore).tracks.length)
  })
})

// ── d. MCP path ───────────────────────────────────────────────────────────────
describe('actor.mcpCall("add_layers") — kind motif', () => {
  it('creates a Motif layer via MCP and returns its record', () => {
    const actor = makeActor()
    const result = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'motif', motif_id: 'countdown' } }] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const record = (JSON.parse(result.result.content[0]!.text) as { layers: Array<{ layer_id: string }> }).layers[0]!
    const text = record.layer_id
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
    // Verify the layer was actually created
    const snap = actor.snapshot()
    const layers = root(snap).tracks.flatMap((t) => t.layers)
    const layer = layers.find((l) => l.id === text)
    expect(layer).toBeDefined()
    expect(layer!.params.kind).toBe('Motif')
    // No-track MCP path mints the spawned track FIRST, then the layer — so the
    // returned layer id is ordered AFTER the minted track id (idGen call order).
    // This mirrors the command-path id-order assertion.
    const overlayTrack = root(snap).tracks.find((t) => t.label === null && t.role === null)
    expect(overlayTrack).toBeDefined()
    expect(overlayTrack!.id < text!).toBe(true)
  })

  it('MCP bad motif_id → ok:false invalid_params', () => {
    const actor = makeActor()
    const result = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'motif', motif_id: 'no-such-motif' } }] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_params')
  })

  it('MCP bad props → ok:false invalid_params, no commit', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()
    const result = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'motif', motif_id: 'countdown', props: { badKey: 'oops' } } }] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_params')
    const snapAfter = actor.snapshot()
    expect(root(snapAfter).tracks.length).toBe(root(snapBefore).tracks.length)
  })

  it('MCP missing motif_id → rejects (required field)', () => {
    const actor = makeActor()
    const result = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'motif' } }] }))
    expect(result.ok).toBe(false)
  })

  it('MCP with explicit track_id → single commit, no new track', () => {
    const actor = makeActor()
    const trackResult = actor.dispatch('add_track', { label: 'MyTrack' })
    const trackId = trackResult.ok ? trackResult.value as string : ''
    const trackCountBefore = root(actor.snapshot()).tracks.length

    const result = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: 0, t_end_us: 2_000_000, track_id: trackId, content: { kind: 'motif', motif_id: 'countdown' } }] }))
    expect(result.ok).toBe(true)
    expect(root(actor.snapshot()).tracks.length).toBe(trackCountBefore)
  })
})

// ── e. the project's Motif table ──────────────────────────────────────────────
// A layer renders the project's own copy: placing a library Motif records its
// table entry in the commit that adds the layer.
describe('placing records the project Motif with its layer', () => {
  const entries = (actor: ReturnType<typeof makeActor>) => actor.snapshot().motifs
  const layersOn = (actor: ReturnType<typeof makeActor>, id: string) =>
    root(actor.snapshot()).tracks.flatMap((t) => t.layers).filter((l) => l.params.kind === 'Motif' && l.params.motif_id === id)

  it('a library Motif lands in the table with its layer, and one undo removes both', () => {
    const actor = makeActor()
    const track = actor.dispatch('add_track', { label: 'T' })
    const trackId = track.ok ? track.value as string : ''
    const before = actor.historyStatus().len
    expect(actor.command('add_motif', { motifId: 'countdown', trackId, tStartUs: 0 }).ok).toBe(true)
    expect(Object.keys(entries(actor))).toEqual(['countdown'])
    expect(actor.historyStatus().len).toBe(before + 1)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(entries(actor)).toEqual({})
    expect(layersOn(actor, 'countdown')).toHaveLength(0)
  })

  it('placing it again reuses the entry the table holds', () => {
    const actor = makeActor()
    expect(actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 }).ok).toBe(true)
    const entry = entries(actor).countdown
    expect(actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 }).ok).toBe(true)
    expect(entries(actor)).toEqual({ countdown: entry })
    expect(layersOn(actor, 'countdown')).toHaveLength(2)
  })

  it('from_library places the library Motif under a new id when another lineage holds the id', () => {
    const motifs = libraryMotifs()
    const idGen = seededGen()
    const actor = createActor({ initial: blankProject(idGen, 'p'), idGen, motifs })
    const own = { uid: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', revision: 'a'.repeat(64), from: null }
    expect(actor.dispatch('set_project_motif', { motif_id: 'countdown', ...own }).ok).toBe(true)
    motifs.folders.set('countdown', { id: 'countdown', name: 'Own', version: 1, size: [10, 10], default_duration_s: 1, fonts: [], props_schema: {} })
    // Without from_library the project's own Motif is placed.
    expect(actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 }).ok).toBe(true)
    const r = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'motif', motif_id: 'countdown', from_library: true } }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const placed = (r.result.structuredContent as { layers: Array<{ motif_id: string }> }).layers[0]!.motif_id
    expect(placed).not.toBe('countdown')
    expect(entries(actor).countdown).toEqual(own)
    expect(entries(actor)[placed]!.uid).not.toBe(own.uid)
    expect(layersOn(actor, 'countdown')).toHaveLength(1)
    expect(layersOn(actor, placed)).toHaveLength(1)
  })

  it('remove_project_motif is refused while a layer uses it, and drops the entry once none does', () => {
    const actor = makeActor()
    const added = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    const layerId = added.ok ? added.value as string : ''
    const refused = actor.dispatch('remove_project_motif', { motif_id: 'countdown' })
    expect(refused).toEqual({ ok: false, error: { error: 'MotifInUse', motif_id: 'countdown', referenced_by: [layerId] } })
    expect(actor.dispatch('delete_layers', { layers: [layerId] }).ok).toBe(true)
    expect(actor.dispatch('remove_project_motif', { motif_id: 'countdown' }).ok).toBe(true)
    expect(entries(actor)).toEqual({})
  })

  it('a layer may name only a Motif the table holds', () => {
    const actor = makeActor()
    const added = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    const layerId = added.ok ? added.value as string : ''
    const r = actor.dispatch('update_layer_params', { layer: layerId, patch: { kind: 'Motif', motif_id: 'not-in-project' } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatchObject({ error: 'ValidationFailed', detail: { rule: 'MotifNotInProject', layer: layerId, motif_id: 'not-in-project' } })
  })

  it('set_project_motif records a new revision of that Motif alone', () => {
    const actor = makeActor()
    actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    actor.command('add_motif', { motifId: 'lower-third', tStartUs: 0 })
    const before = entries(actor)
    expect(actor.dispatch('set_project_motif', { motif_id: 'countdown', revision: 'b'.repeat(64) }).ok).toBe(true)
    expect(entries(actor)).toEqual({ ...before, countdown: { ...before.countdown!, revision: 'b'.repeat(64) } })
  })

  it('update_project_motif records the new revision, source and rebound props in one step', () => {
    const actor = makeActor()
    const added = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0, props: { seconds: 3 } })
    const layerId = added.ok ? added.value as string : ''
    const before = actor.snapshot()
    const from = { uid: before.motifs.countdown!.uid, version: 2, revision: 'c'.repeat(64) }
    const r = actor.dispatch('update_project_motif', { motif_id: 'countdown', revision: 'd'.repeat(64), from, updates: [{ layer_id: layerId, motif_id: 'countdown', props: { seconds: 4 } }] })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().motifs.countdown).toEqual({ uid: from.uid, revision: 'd'.repeat(64), from })
    expect(layersOn(actor, 'countdown')[0]!.params).toMatchObject({ props: { seconds: 4 } })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().motifs).toEqual(before.motifs)
    expect(layersOn(actor, 'countdown')[0]!.params).toMatchObject({ props: { seconds: 3 } })
  })
})

// ── f. Review ─────────────────────────────────────────────────────────────────
describe('an agent edit of a project Motif in Review', () => {
  it('is an unreviewed change of that Motif, ranged where its layers play and nowhere else', () => {
    const actor = makeActor()
    const edited = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0, tEndUs: 2_000_000 })
    actor.command('add_motif', { motifId: 'lower-third', tStartUs: 4_000_000, tEndUs: 6_000_000 })
    const layer = root(actor.snapshot()).tracks.flatMap((t) => t.layers).find((l) => edited.ok && l.id === edited.value)!
    actor.dispatch('set_project_motif', { motif_id: 'countdown', revision: 'e'.repeat(64) }, { kind: 'Agent', client: 'files' })
    const review = actor.reviewState()
    expect(review.unreviewed.map((c) => c.id)).toEqual(['Motif:countdown'])
    expect(review.ranges.map((r) => [r.t_start_us, r.t_end_us, r.change_ids])).toEqual([[layer.t_start_us, layer.t_end_us, ['Motif:countdown']]])
  })
})
