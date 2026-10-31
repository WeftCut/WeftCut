// apps/desktop/src/main/state/__tests__/mcp.layer-adds.test.ts
// `add_layers` — the one tool that places new layers — and `set_track_flags`.
//
// Every kind lands from one call, a layer without a track opens one inside the
// same commit (T5), a mixed batch is one history entry, and any refusal rolls
// the whole batch back. The media-kind gates keep their refusals: audio-only
// media as a picture once got a success report for a clip that neither shows
// nor plays.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { root } from './fixtures/project'

const AUDIO = '00000000-0000-0000-0000-0000000000a1'
const VIDEO_WITH_SOUND = '00000000-0000-0000-0000-0000000000a2'
const SILENT_IMAGE = '00000000-0000-0000-0000-0000000000a3'
const SUBTITLE = '00000000-0000-0000-0000-0000000000a4'
const SILENT_VIDEO = '00000000-0000-0000-0000-0000000000a5'
const NOWHERE = '00000000-0000-7000-8000-00000000dead'
const BLACK = { r: 0, g: 0, b: 0, a: 255 }

/** Blank project + every pool shape the media-kind gates discriminate on: the
 *  four kinds, and a Video whose probe found no audio stream. */
function actorWithPool() {
  const gen = seededGen()
  const p: Project = blankProject(gen, 'layer-adds')
  p.media_pool[AUDIO] = mediaItemTemplate(AUDIO, 'Audio', 10_000_000)
  p.media_pool[VIDEO_WITH_SOUND] = mediaItemTemplate(VIDEO_WITH_SOUND, 'Video', 10_000_000, true)
  p.media_pool[SILENT_IMAGE] = mediaItemTemplate(SILENT_IMAGE, 'Image', null)
  p.media_pool[SUBTITLE] = mediaItemTemplate(SUBTITLE, 'Subtitle', null)
  p.media_pool[SILENT_VIDEO] = mediaItemTemplate(SILENT_VIDEO, 'Video', 10_000_000)
  return createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
}

type Actor = ReturnType<typeof actorWithPool>
interface Placed { layer_id: string; track_id: string; t_start_us: number; t_end_us: number; adjusted: Array<{ field: string; requested: number; applied: number; reason: string }>; linked: { audio_layer_id: string; link_id: string } | null }

function call(a: Actor, tool: string, args: Record<string, unknown>) {
  return a.mcpCall(tool, JSON.stringify(args))
}
const add = (a: Actor, layers: unknown[], extra: Record<string, unknown> = {}) => call(a, 'add_layers', { ...extra, layers })
function aRoll(a: Actor): string { return root(a.snapshot()).tracks[0].id }
function bRoll(a: Actor): string { return root(a.snapshot()).tracks[1].id }

/** The placed records, in input order. Fails loudly on a refusal. */
function placed(r: ReturnType<Actor['mcpCall']>): Placed[] {
  expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
  if (!r.ok) throw new Error('call failed')
  return (JSON.parse(r.result.content[0].text) as { layers: Placed[] }).layers
}
function refusal(r: ReturnType<Actor['mcpCall']>): string {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected refusal')
  expect(r.error.code).toBe('invalid_params')
  return r.error.message
}
function layerOf(a: Actor, id: string): Layer {
  for (const c of Object.values(a.snapshot().compositions))
    for (const t of c.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error(`layer ${id} not found`)
}
function layerCount(a: Actor): number {
  return Object.values(a.snapshot().compositions).reduce((n, c) => n + c.tracks.reduce((m, t) => m + t.layers.length, 0), 0)
}
const trackCount = (a: Actor) => root(a.snapshot()).tracks.length

const span = (t0: number, t1: number) => ({ t_start_us: t0, t_end_us: t1 })
const color = (track: string | undefined, t0: number, t1: number) => ({ ...(track ? { track_id: track } : {}), ...span(t0, t1), content: { kind: 'color', color: BLACK } })

describe('add_layers: every kind', () => {
  it('video: the source window is src_in_us plus the span, and its audio pairs onto the same track, linked', () => {
    const a = actorWithPool()
    const [v] = placed(add(a, [{ track_id: aRoll(a), ...span(1_000_000, 5_000_000), content: { kind: 'video', media_id: VIDEO_WITH_SOUND, src_in_us: 2_000_000 } }]))
    expect(layerOf(a, v.layer_id).params).toMatchObject({ kind: 'VideoClip', src_in_us: 2_000_000, src_out_us: 6_000_000 })
    expect(v.linked).not.toBeNull()
    const audio = layerOf(a, v.linked!.audio_layer_id)
    expect(audio.params).toMatchObject({ kind: 'Audio', role: 'dialogue', src_in_us: 2_000_000, src_out_us: 6_000_000 })
    expect(root(a.snapshot()).tracks[0].layers.map((l) => l.id).sort()).toEqual([v.layer_id, v.linked!.audio_layer_id].sort())
    expect([...root(a.snapshot()).links.find((l) => l.id === v.linked!.link_id)!.members].sort()).toEqual([v.layer_id, v.linked!.audio_layer_id].sort())
  })

  it("video: `audio: 'none'` places the picture alone; `linked` without an audio stream refuses", () => {
    const a = actorWithPool()
    const [v] = placed(add(a, [{ track_id: aRoll(a), ...span(0, 1_000_000), content: { kind: 'video', media_id: VIDEO_WITH_SOUND, src_in_us: 0, audio: 'none' } }]))
    expect(v.linked).toBeNull()
    expect(layerCount(a)).toBe(1)
    expect(refusal(add(a, [{ track_id: bRoll(a), ...span(0, 1_000_000), content: { kind: 'video', media_id: SILENT_VIDEO, src_in_us: 0, audio: 'linked' } }]))).toContain('no audio stream')
    expect(layerCount(a)).toBe(1)
  })

  it('image: an ImageOverlay over the span, with its graphic role', () => {
    const a = actorWithPool()
    const [i] = placed(add(a, [{ track_id: bRoll(a), ...span(0, 3_000_000), content: { kind: 'image', media_id: SILENT_IMAGE, graphic_role: 'logo' } }]))
    expect(layerOf(a, i.layer_id).params).toMatchObject({ kind: 'ImageOverlay', media: SILENT_IMAGE, graphic_role: 'logo' })
    expect(i.linked).toBeNull()
  })

  it('audio: on the music bus by default, an explicit role honoured, a video item taken for its sound alone', () => {
    const a = actorWithPool()
    const [m, s, d] = placed(add(a, [
      { track_id: aRoll(a), ...span(0, 4_000_000), content: { kind: 'audio', media_id: AUDIO, src_in_us: 0 } },
      { track_id: bRoll(a), ...span(0, 4_000_000), content: { kind: 'audio', media_id: AUDIO, src_in_us: 1_000_000, role: 'sfx' } },
      { ...span(0, 2_000_000), content: { kind: 'audio', media_id: VIDEO_WITH_SOUND, src_in_us: 0 } },
    ]))
    expect(layerOf(a, m.layer_id).params).toMatchObject({ kind: 'Audio', media: AUDIO, src_in_us: 0, src_out_us: 4_000_000, role: 'music' })
    expect(layerOf(a, s.layer_id).params).toMatchObject({ role: 'sfx', src_in_us: 1_000_000, src_out_us: 5_000_000 })
    expect(layerOf(a, d.layer_id).params).toMatchObject({ kind: 'Audio', media: VIDEO_WITH_SOUND })
  })

  it('text: centred in the composition it lands in; transform x/y place the anchor, unclamped', () => {
    const a = actorWithPool()
    const [c, off] = placed(add(a, [
      { track_id: aRoll(a), ...span(0, 2_000_000), content: { kind: 'text', content: 'Chapter One' } },
      { track_id: bRoll(a), ...span(0, 2_000_000), transform: { x: -200, y: 900 }, content: { kind: 'text', content: 'off the edge' } },
    ]))
    const pos = (id: string) => (layerOf(a, id).params as unknown as { transform: { position: { x: { value: number }; y: { value: number } } } }).transform.position
    expect(layerOf(a, c.layer_id).params).toMatchObject({ kind: 'Text', content: 'Chapter One' })
    expect([pos(c.layer_id).x.value, pos(c.layer_id).y.value]).toEqual([960, 540])
    expect([pos(off.layer_id).x.value, pos(off.layer_id).y.value]).toEqual([-200, 900])
  })

  it('color: sized to the composition, not to a 1920x1080 default (T13)', () => {
    const a = actorWithPool()
    expect(call(a, 'update_composition', { patch: { width: 1080, height: 1920 } }).ok).toBe(true)
    const [c] = placed(add(a, [color(aRoll(a), 0, 1_000_000)]))
    expect(layerOf(a, c.layer_id).params).toMatchObject({ kind: 'Color', width: 1080, height: 1920 })
  })

  it("motif: the manifest's role, and an end past its content shortened with reason `content`", () => {
    const a = actorWithPool()
    const [m] = placed(add(a, [{ ...span(0, 8_000_000), content: { kind: 'motif', motif_id: 'countdown' } }]))
    expect(layerOf(a, m.layer_id).params).toMatchObject({ kind: 'Motif', motif_id: 'countdown' })
    expect(m.t_end_us).toBe(5_000_000)
    expect(m.adjusted).toEqual([{ field: 't_end_us', requested: 8_000_000, applied: 5_000_000, reason: 'content' }])
    expect(refusal(add(a, [{ ...span(0, 1_000_000), content: { kind: 'motif', motif_id: 'no-such-motif' } }]))).toContain('list_motifs')
    expect(refusal(add(a, [{ ...span(0, 1_000_000), content: { kind: 'motif', motif_id: 'countdown', props: { nope: 1 } } }]))).toContain('invalid props')
  })

  it("group: another instance of a composition, spanning it whole unless t_end_us says less, never past its end", () => {
    const a = actorWithPool()
    const [inner] = placed(add(a, [color(aRoll(a), 0, 2_000_000)]))
    const g = JSON.parse((call(a, 'create_group', { layer_ids: [inner.layer_id] }) as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text) as { composition_id: string }
    const group = { kind: 'group', composition_id: g.composition_id }
    const [part, whole] = placed(add(a, [{ ...span(4_000_000, 5_000_000), content: group }, { t_start_us: 8_000_000, content: group }]))
    expect(layerOf(a, part.layer_id).params).toMatchObject({ kind: 'CompositionRef', src_in_us: 0, src_out_us: 1_000_000 })
    expect([whole.t_start_us, whole.t_end_us]).toEqual([8_000_000, 10_000_000])
    expect(layerOf(a, whole.layer_id).params).toMatchObject({ src_out_us: 2_000_000 })
    expect(refusal(add(a, [{ ...span(12_000_000, 15_000_000), content: { kind: 'group', composition_id: g.composition_id } }]))).toContain('show nothing past its end')
  })
})

describe('add_layers: a spawn, a batch, one entry', () => {
  it('a layer without track_id opens its own fresh track in the same commit (T5)', () => {
    const a = actorWithPool()
    const tracks = trackCount(a)
    const cursor = a.historyStatus().cursor
    const [x, y] = placed(add(a, [color(undefined, 0, 1_000_000), color(undefined, 0, 1_000_000)]))
    expect(trackCount(a)).toBe(tracks + 2)
    expect(x.track_id).not.toBe(y.track_id)
    expect(a.historyStatus().cursor).toBe(cursor + 1)
  })

  it('composition_id is the spawn target, and the cross-check for a named track', () => {
    const a = actorWithPool()
    const [inner] = placed(add(a, [color(aRoll(a), 0, 2_000_000)]))
    const g = JSON.parse((call(a, 'create_group', { layer_ids: [inner.layer_id] }) as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text) as { composition_id: string }
    const [s] = placed(add(a, [color(undefined, 0, 1_000_000)], { composition_id: g.composition_id }))
    expect(a.snapshot().compositions[g.composition_id]!.tracks.some((t) => t.id === s.track_id)).toBe(true)
    expect(refusal(add(a, [color(bRoll(a), 5_000_000, 6_000_000)], { composition_id: g.composition_id }))).toContain('belongs to composition')
    expect(refusal(add(a, [color(undefined, 0, 1_000_000)], { composition_id: NOWHERE }))).toContain(NOWHERE)
  })

  it('a mixed batch — named lanes, a spawn, a pair, a label, a transform — is ONE history entry, undone in one step', () => {
    const a = actorWithPool()
    const tracks = trackCount(a)
    const cursor = a.historyStatus().cursor
    const out = placed(add(a, [
      { track_id: aRoll(a), ...span(0, 4_000_000), label: 'Interview', content: { kind: 'video', media_id: VIDEO_WITH_SOUND, src_in_us: 0 } },
      { track_id: bRoll(a), ...span(0, 2_000_000), content: { kind: 'text', content: 'Title', graphic_role: 'title' } },
      { ...span(1_000_000, 3_000_000), transform: { x: 100, y: 200, scale: 0.5, rotation_deg: 10, opacity: 0.8 }, content: { kind: 'image', media_id: SILENT_IMAGE } },
    ]))
    expect(out).toHaveLength(3)
    expect(layerCount(a)).toBe(4)
    expect(trackCount(a)).toBe(tracks + 1)
    expect(layerOf(a, out[0].layer_id).label).toBe('Interview')
    expect(layerOf(a, out[2].layer_id).params).toMatchObject({
      transform: { scale_x: { value: 0.5 }, scale_y: { value: 0.5 }, rotation_deg: { value: 10 }, position: { x: { value: 100 }, y: { value: 200 } } },
      opacity: { value: 0.8 },
    })
    const status = a.historyStatus()
    expect(status.cursor).toBe(cursor + 1)
    const head = a.historyView(1).ops[0] as { label_key?: string; label_args?: Record<string, number> }
    expect(head.label_key).toBe('history.layer.add_multi')
    expect(head.label_args).toEqual({ count: 4 })
    expect(call(a, 'undo', {}).ok).toBe(true)
    expect(layerCount(a)).toBe(0)
    expect(trackCount(a)).toBe(tracks)
  })

  it('one refusal rolls back the whole batch: no layer, no spawned track, no entry', () => {
    const a = actorWithPool()
    const tracks = trackCount(a)
    const cursor = a.historyStatus().cursor
    const msg = refusal(add(a, [
      color(undefined, 0, 1_000_000),
      color(aRoll(a), 0, 2_000_000),
      color(aRoll(a), 1_000_000, 3_000_000), // collides with the one before it
    ]))
    expect(msg).toContain('layer overlap')
    expect(layerCount(a)).toBe(0)
    expect(trackCount(a)).toBe(tracks)
    expect(a.historyStatus().cursor).toBe(cursor)
  })

  it('reports grid snaps per layer', () => {
    const a = actorWithPool()
    const [c] = placed(add(a, [color(aRoll(a), 350_000, 3_000_000)]))
    expect(c.adjusted).toEqual([{ field: 't_start_us', requested: 350_000, applied: c.t_start_us, reason: 'grid' }])
  })
})

describe('add_layers: the shape is strict', () => {
  it.each([
    ['a field another kind takes', [{ ...span(0, 1_000_000), content: { kind: 'image', media_id: SILENT_IMAGE, src_in_us: 0 } }], 'src_in_us'],
    ['a source out point (derived, never sent)', [{ ...span(0, 1_000_000), content: { kind: 'video', media_id: SILENT_VIDEO, src_in_us: 0, src_out_us: 1_000_000 } }], 'src_out_us'],
    ['a missing end on a non-group kind', [{ t_start_us: 0, content: { kind: 'color', color: BLACK } }], 't_end_us is required'],
    ['an end before the start', [{ ...span(2_000_000, 1_000_000), content: { kind: 'color', color: BLACK } }], 'must be greater'],
    ['a transform on a colour block', [{ ...span(0, 1_000_000), transform: { x: 1 }, content: { kind: 'color', color: BLACK } }], 'no transform'],
    ['a scale on text', [{ ...span(0, 1_000_000), transform: { scale: 2 }, content: { kind: 'text', content: 'T' } }], 'no scale'],
    ['an empty transform', [{ ...span(0, 1_000_000), transform: {}, content: { kind: 'text', content: 'T' } }], 'names no field'],
    ['a null graphic role', [{ ...span(0, 1_000_000), content: { kind: 'text', content: 'T', graphic_role: null } }], 'null is not a role'],
    ['an unknown kind', [{ ...span(0, 1_000_000), content: { kind: 'shape' } }], 'kind must be one of'],
    ['an empty batch', [], 'at least one'],
    ['51 layers', Array.from({ length: 51 }, (_, i) => color(undefined, i * 1_000_000, (i + 1) * 1_000_000)), 'at most 50'],
  ])('refuses %s, committing nothing', (_what, layers, says) => {
    const a = actorWithPool()
    expect(refusal(add(a, layers as unknown[]))).toContain(says)
    expect(layerCount(a)).toBe(0)
  })
})

describe('add_layers media-kind guards', () => {
  const kindRefusal = (content: Record<string, unknown>) => {
    const a = actorWithPool()
    const msg = refusal(add(a, [{ track_id: aRoll(a), ...span(0, 4_000_000), content }]))
    // The failure these guard against is a layer that COMMITS, so the empty
    // timeline is the assertion that matters.
    expect(layerCount(a)).toBe(0)
    return msg
  }
  it('audio-only media as video names kind audio', () => {
    expect(kindRefusal({ kind: 'video', media_id: AUDIO, src_in_us: 0 })).toContain('kind audio')
  })
  it('a subtitle document as video points at the caption importer', () => {
    expect(kindRefusal({ kind: 'video', media_id: SUBTITLE, src_in_us: 0 })).toContain('apply_subtitles')
  })
  it('an Image as video names kind image', () => {
    expect(kindRefusal({ kind: 'video', media_id: SILENT_IMAGE, src_in_us: 0 })).toContain('kind image')
  })
  it('a Video as image names kind video', () => {
    expect(kindRefusal({ kind: 'image', media_id: SILENT_VIDEO })).toContain('kind video')
  })
  it('media with nothing to play as audio names its kind, and which half is missing', () => {
    expect(kindRefusal({ kind: 'audio', media_id: SILENT_IMAGE, src_in_us: 0 })).toContain('Image')
    expect(kindRefusal({ kind: 'audio', media_id: SILENT_VIDEO, src_in_us: 0 })).toContain('no audio stream')
  })
  it('an unknown media id is MediaNotFound before any other rule', () => {
    for (const content of [{ kind: 'video', media_id: NOWHERE, src_in_us: 0 }, { kind: 'audio', media_id: NOWHERE, src_in_us: 0 }, { kind: 'image', media_id: NOWHERE }]) {
      const msg = kindRefusal(content)
      expect(msg).toContain(`media ${NOWHERE} not found`)
      expect(msg).toContain('project://media')
    }
  })
})

describe('add_layers collisions', () => {
  it('a request placed BEFORE an existing clip still names that clip, with options that exist', () => {
    // validate reports the colliding pair earliest-start first, so a request
    // starting before the blocker arrives with the roles swapped: the message
    // would name the caller's own layer — one the discarded draft never
    // committed — and every option it offers would then be LayerNotFound.
    const a = actorWithPool()
    const track = aRoll(a)
    const [existing] = placed(add(a, [{ track_id: track, ...span(3_000_000, 10_000_000), content: { kind: 'video', media_id: SILENT_VIDEO, src_in_us: 0 } }]))
    const r = add(a, [color(track, 0, 5_000_000)])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.message).toContain(existing.layer_id)
    expect(r.error.message).toContain('[0, 5000000)')
    const data = r.error.data as { blocking_layer: string; requested_range_us: [number, number]; options: Array<{ layer_id?: string }> }
    expect(data.blocking_layer).toBe(existing.layer_id)
    expect(data.requested_range_us).toEqual([0, 5_000_000])
    for (const o of data.options) if (o.layer_id !== undefined) expect(o.layer_id).toBe(existing.layer_id)
  })
})

describe('set_track_flags', () => {
  const title = (a: Actor, track: string) => placed(add(a, [{ track_id: track, ...span(0, 2_000_000), content: { kind: 'text', content: 'title' } }]))[0].layer_id

  it('locks a track, which then refuses an edit to the layer on it, and unlocks it again', () => {
    const a = actorWithPool()
    const track = aRoll(a)
    const id = title(a, track)

    expect(call(a, 'set_track_flags', { track_id: track, locked: true }).ok).toBe(true)
    expect(root(a.snapshot()).tracks[0].locked).toBe(true)
    expect(call(a, 'delete_layers', { layer_ids: [id] }).ok).toBe(false)
    expect(layerCount(a)).toBe(1)

    expect(call(a, 'set_track_flags', { track_id: track, locked: false }).ok).toBe(true)
    expect(call(a, 'delete_layers', { layer_ids: [id] }).ok).toBe(true)
    expect(layerCount(a)).toBe(0)
  })

  it('leaves the flag it was not given alone', () => {
    const a = actorWithPool()
    const track = aRoll(a)
    expect(call(a, 'set_track_flags', { track_id: track, enabled: false }).ok).toBe(true)
    expect(root(a.snapshot()).tracks[0]).toMatchObject({ enabled: false, locked: false })
    expect(call(a, 'set_track_flags', { track_id: track, locked: true }).ok).toBe(true)
    expect(root(a.snapshot()).tracks[0]).toMatchObject({ enabled: false, locked: true })
  })

  it('refuses a call that names no flag instead of reporting a successful no-op', () => {
    const a = actorWithPool()
    const r = call(a, 'set_track_flags', { track_id: aRoll(a) })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('at least one')
  })

  it('rejects a non-boolean flag rather than silently dropping it', () => {
    const a = actorWithPool()
    const r = call(a, 'set_track_flags', { track_id: aRoll(a), locked: 'true' })
    expect(r.ok).toBe(false)
    expect(root(a.snapshot()).tracks[0].locked).toBe(false)
  })

  it('is unrecorded: undo walks past it', () => {
    const a = actorWithPool()
    const track = aRoll(a)
    title(a, track)
    expect(call(a, 'set_track_flags', { track_id: track, locked: true }).ok).toBe(true)
    // The one recorded edit here is the text layer, so undo removes THAT and
    // leaves the lock standing — the same contract set_role_flags carries.
    expect(call(a, 'undo', {}).ok).toBe(true)
    expect(layerCount(a)).toBe(0)
    expect(root(a.snapshot()).tracks[0].locked).toBe(true)
  })
})
