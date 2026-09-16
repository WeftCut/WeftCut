// apps/desktop/src/main/state/__tests__/mcp.layer-adds.test.ts
// The three creation/flag tools an agent reaches for on ordinary work, plus the
// refusal that stops the mistake they replace.
//
// Audio-only media, a plain title, and a track's lock were all reachable from
// the UI and from nowhere else: an agent asked to drop a music bed, name a
// title, or edit a locked track had no tool and either failed or — worse for
// `add_video_layer` over an mp3 — got a success report for a clip that neither
// shows nor plays. These pin the placements, the mixing bus a cue lands on, the
// anchor a title is placed by, and the lock's two directions.
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

function call(a: Actor, tool: string, args: Record<string, unknown>) {
  return a.mcpCall(tool, JSON.stringify(args))
}
function aRoll(a: Actor): string { return root(a.snapshot()).tracks[0].id }
function bRoll(a: Actor): string { return root(a.snapshot()).tracks[1].id }

/** The tool's text result is the new layer's id; fail loudly rather than
 *  returning a placeholder a later assertion would silently pass against. */
function addedId(r: ReturnType<Actor['mcpCall']>): string {
  expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
  if (!r.ok) throw new Error('call failed')
  return r.result.content[0].text
}
function layerOf(a: Actor, id: string): Layer {
  for (const t of root(a.snapshot()).tracks) {
    const l = t.layers.find((x) => x.id === id)
    if (l) return l
  }
  throw new Error(`layer ${id} not found`)
}
function layerCount(a: Actor): number {
  return root(a.snapshot()).tracks.reduce((n, t) => n + t.layers.length, 0)
}

const AUDIO_ARGS = { media_id: AUDIO, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 }

describe('add_audio_layer', () => {
  it('places an Audio layer on the named track, on the music bus by default', () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_audio_layer', { ...AUDIO_ARGS, track_id: aRoll(a) }))
    const l = layerOf(a, id)
    expect(l.params).toMatchObject({ kind: 'Audio', media: AUDIO, src_in_us: 0, src_out_us: 4_000_000, role: 'music' })
    expect([l.t_start_us, l.t_end_us]).toEqual([0, 4_000_000])
    expect(root(a.snapshot()).tracks[0].layers.map((x) => x.id)).toEqual([id])
  })

  it("honours an explicit role — the mixing bus is the clip's, not its track's", () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_audio_layer', { ...AUDIO_ARGS, track_id: aRoll(a), role: 'sfx' }))
    expect((layerOf(a, id).params as { role: string }).role).toBe('sfx')
  })

  it('rejects an unknown role at the boundary instead of storing it', () => {
    const a = actorWithPool()
    const r = call(a, 'add_audio_layer', { ...AUDIO_ARGS, track_id: aRoll(a), role: 'narration' })
    expect(r.ok).toBe(false)
    expect(layerCount(a)).toBe(0)
  })

  it('shares a composition with a paired video clip: the cue takes a free audio lane', () => {
    const a = actorWithPool()
    // auto_pair_audio_on_import is on by default, so the video already claimed
    // the A roll's audio lane; the cue goes on the other track's.
    const video = call(a, 'add_video_layer', {
      media_id: VIDEO_WITH_SOUND, src_in_us: 0, src_out_us: 4_000_000,
      t_start_us: 0, t_end_us: 4_000_000, track_id: aRoll(a),
    })
    expect(video.ok).toBe(true)
    const cue = addedId(call(a, 'add_audio_layer', { ...AUDIO_ARGS, track_id: bRoll(a) }))
    expect((layerOf(a, cue).params as { kind: string }).kind).toBe('Audio')
  })

  it("takes a video item's own audio, with no picture", () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_audio_layer', {
      ...AUDIO_ARGS, media_id: VIDEO_WITH_SOUND, track_id: aRoll(a),
    }))
    expect(layerOf(a, id).params).toMatchObject({ kind: 'Audio', media: VIDEO_WITH_SOUND })
  })

  it('refuses media with nothing to play, naming the kind, and commits nothing', () => {
    const a = actorWithPool()
    const r = call(a, 'add_audio_layer', { ...AUDIO_ARGS, media_id: SILENT_IMAGE, track_id: aRoll(a) })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('Image')
    expect(layerCount(a)).toBe(0)
  })

  it('refuses a video that carries no audio stream, saying which half is missing', () => {
    const a = actorWithPool()
    const r = call(a, 'add_audio_layer', { ...AUDIO_ARGS, media_id: SILENT_VIDEO, track_id: aRoll(a) })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('no audio stream')
    expect(layerCount(a)).toBe(0)
  })
})

describe('add_video_layer media-kind guard', () => {
  it('refuses audio-only media and names the tool that places it', () => {
    const a = actorWithPool()
    const r = call(a, 'add_video_layer', {
      media_id: AUDIO, src_in_us: 0, src_out_us: 4_000_000,
      t_start_us: 0, t_end_us: 4_000_000, track_id: aRoll(a),
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('add_audio_layer')
    // The failure mode this guard exists for: a VideoClip over an mp3 used to
    // COMMIT, so the emptiness of the timeline is the assertion that matters.
    expect(layerCount(a)).toBe(0)
  })

  it('refuses a subtitle document and points at the caption importer', () => {
    const a = actorWithPool()
    const r = call(a, 'add_video_layer', {
      media_id: SUBTITLE, src_in_us: 0, src_out_us: 4_000_000,
      t_start_us: 0, t_end_us: 4_000_000, track_id: aRoll(a),
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('apply_subtitles')
    expect(layerCount(a)).toBe(0)
  })
})

describe('add_text_layer', () => {
  it('creates a Text layer centred in the composition it landed in', () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_text_layer', {
      track_id: aRoll(a), t_start_us: 0, t_end_us: 2_000_000, content: 'Chapter One',
    }))
    const params = layerOf(a, id).params as {
      kind: string; content: string; font: { size_px: number }
      transform: { position: { mode: string; x: { value: number }; y: { value: number } } }
    }
    expect(params.kind).toBe('Text')
    expect(params.content).toBe('Chapter One')
    expect(params.font.size_px).toBe(72)
    expect([params.transform.position.x.value, params.transform.position.y.value]).toEqual([960, 540])
  })

  it('places the anchor at an explicit x/y, unclamped by the frame', () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_text_layer', {
      track_id: aRoll(a), t_start_us: 0, t_end_us: 2_000_000, content: 'off the edge', x: -200, y: 900,
    }))
    const pos = (layerOf(a, id).params as { transform: { position: { x: { value: number }; y: { value: number } } } }).transform.position
    expect([pos.x.value, pos.y.value]).toEqual([-200, 900])
  })

  it('refuses half a point rather than guessing the other axis', () => {
    const a = actorWithPool()
    const r = call(a, 'add_text_layer', {
      track_id: aRoll(a), t_start_us: 0, t_end_us: 2_000_000, content: 'half', x: 100,
    })
    expect(r.ok).toBe(false)
    expect(layerCount(a)).toBe(0)
  })
})

describe('set_track_flags', () => {
  it('locks a track, which then refuses an edit to the layer on it, and unlocks it again', () => {
    const a = actorWithPool()
    const track = aRoll(a)
    const id = addedId(call(a, 'add_text_layer', { track_id: track, t_start_us: 0, t_end_us: 2_000_000, content: 'title' }))

    expect(call(a, 'set_track_flags', { track_id: track, locked: true }).ok).toBe(true)
    expect(root(a.snapshot()).tracks[0].locked).toBe(true)
    expect(call(a, 'delete_layer', { layer_id: id }).ok).toBe(false)
    expect(layerCount(a)).toBe(1)

    expect(call(a, 'set_track_flags', { track_id: track, locked: false }).ok).toBe(true)
    expect(call(a, 'delete_layer', { layer_id: id }).ok).toBe(true)
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
    addedId(call(a, 'add_text_layer', { track_id: track, t_start_us: 0, t_end_us: 2_000_000, content: 'title' }))
    expect(call(a, 'set_track_flags', { track_id: track, locked: true }).ok).toBe(true)
    // The one recorded edit here is the text layer, so undo removes THAT and
    // leaves the lock standing — the same contract set_role_flags carries.
    expect(call(a, 'undo', {}).ok).toBe(true)
    expect(layerCount(a)).toBe(0)
    expect(root(a.snapshot()).tracks[0].locked).toBe(true)
  })
})
