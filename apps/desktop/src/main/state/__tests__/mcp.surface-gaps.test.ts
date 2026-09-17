// apps/desktop/src/main/state/__tests__/mcp.surface-gaps.test.ts
// The second batch of UI-only operations given an MCP tool: the plural delete,
// lifting audio to its own lane, the project's editing preferences, the two
// caption tools that carry WORD timing, and the two history moves that are
// neither undo nor a checkpoint restore.
//
// Each had a production channel and no tool, so an agent hit a wall the app
// does not have. What is pinned here is what a caller cannot see from the
// signature: which refusals are whole-batch, which writes record, and which of
// the preferences actually changes behaviour downstream.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Project, type Track } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { root } from './fixtures/project'

const AUDIO = '00000000-0000-0000-0000-0000000000b1'
const VIDEO_WITH_SOUND = '00000000-0000-0000-0000-0000000000b2'

function actorWithPool() {
  const gen = seededGen()
  const p: Project = blankProject(gen, 'surface-gaps')
  p.media_pool[AUDIO] = mediaItemTemplate(AUDIO, 'Audio', 20_000_000)
  p.media_pool[VIDEO_WITH_SOUND] = mediaItemTemplate(VIDEO_WITH_SOUND, 'Video', 20_000_000, true)
  return createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
}

type Actor = ReturnType<typeof actorWithPool>

function call(a: Actor, tool: string, args: Record<string, unknown> = {}) {
  return a.mcpCall(tool, JSON.stringify(args))
}
function aRoll(a: Actor): string { return root(a.snapshot()).tracks[0].id }
function bRoll(a: Actor): string { return root(a.snapshot()).tracks[1].id }
function text(r: ReturnType<Actor['mcpCall']>): string {
  expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
  if (!r.ok) throw new Error('call failed')
  return r.result.content[0].text
}
function json<T>(r: ReturnType<Actor['mcpCall']>): T {
  return JSON.parse(text(r)) as T
}
function errorOf(r: ReturnType<Actor['mcpCall']>): string {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected a refusal')
  return r.error.message
}
function tracks(a: Actor): Track[] { return root(a.snapshot()).tracks }
function layerCount(a: Actor): number {
  return tracks(a).reduce((n, t) => n + t.layers.length, 0)
}
/** Three colour clips end to end on the A roll, ids in timeline order. */
function threeClips(a: Actor): string[] {
  const track = aRoll(a)
  return [0, 1, 2].map((i) => text(call(a, 'add_color_layer', {
    track_id: track, t_start_us: i * 1_000_000, t_end_us: (i + 1) * 1_000_000,
    color: { r: 1, g: 2, b: 3, a: 255 },
  })))
}

describe('delete_layers', () => {
  it('removes the whole set as one edit that one undo puts back', () => {
    const a = actorWithPool()
    const [first, , third] = threeClips(a)
    expect(call(a, 'delete_layers', { layer_ids: [first, third] }).ok).toBe(true)
    expect(layerCount(a)).toBe(1)
    expect(call(a, 'undo').ok).toBe(true)
    expect(layerCount(a)).toBe(3)
  })

  it('refuses the whole batch when a member sits on a locked track, deleting no part of it', () => {
    const a = actorWithPool()
    const [first, second] = threeClips(a)
    const onB = text(call(a, 'add_color_layer', { track_id: bRoll(a), t_start_us: 0, t_end_us: 1_000_000, color: { r: 9, g: 9, b: 9, a: 255 } }))
    expect(call(a, 'set_track_flags', { track_id: bRoll(a), locked: true }).ok).toBe(true)
    expect(call(a, 'delete_layers', { layer_ids: [first, second, onB] }).ok).toBe(false)
    expect(layerCount(a)).toBe(4)
  })

  it("does not consult a layer's own lock — that gates the pointer, not the model", () => {
    const a = actorWithPool()
    const [first, second] = threeClips(a)
    expect(call(a, 'update_layer', { layer_id: second, patch: { locked: true } }).ok).toBe(true)
    // The lift's long-standing contract, pinned here
    // so the plural tool's description stays honest about which lock stops it.
    expect(call(a, 'delete_layers', { layer_ids: [first, second] }).ok).toBe(true)
    expect(layerCount(a)).toBe(1)
  })

  it('records nothing for an empty set', () => {
    const a = actorWithPool()
    threeClips(a)
    const before = a.historyStatus().len
    expect(call(a, 'delete_layers', { layer_ids: [] }).ok).toBe(true)
    expect(a.historyStatus().len).toBe(before)
  })
})

describe('separate_audio_to_new_track', () => {
  /** A paired A/V clip on the A roll: video + linked dialogue audio, one track. */
  function pairedClip(a: Actor): { video: string; audio: string } {
    const r = json<{ video_layer_id: string; audio_layer_id: string; link_id: string }>(call(a, 'add_video_layer', {
      media_id: VIDEO_WITH_SOUND, src_in_us: 0, src_out_us: 4_000_000,
      t_start_us: 0, t_end_us: 4_000_000, track_id: aRoll(a),
    }))
    return { video: r.video_layer_id, audio: r.audio_layer_id }
  }

  it('moves the layer to a brand-new track and returns that track id', () => {
    const a = actorWithPool()
    const { audio } = pairedClip(a)
    const before = tracks(a).length
    const newTrack = text(call(a, 'separate_audio_to_new_track', { layer_id: audio }))
    expect(tracks(a).length).toBe(before + 1)
    const lane = tracks(a).find((t) => t.id === newTrack)
    expect(lane?.layers.map((l) => l.id)).toEqual([audio])
    // The layer moved; it was not re-created, so downstream ids still resolve.
    expect(layerCount(a)).toBe(2)
  })

  it('keeps the A/V link alive — the lift is a lane change, not an unlink', () => {
    const a = actorWithPool()
    const { video, audio } = pairedClip(a)
    text(call(a, 'separate_audio_to_new_track', { layer_id: audio }))
    const links = root(a.snapshot()).links
    expect(links.length).toBe(1)
    expect([...links[0].members].sort()).toEqual([video, audio].sort())
  })

  it('refuses a layer that is not Audio', () => {
    const a = actorWithPool()
    const { video } = pairedClip(a)
    expect(call(a, 'separate_audio_to_new_track', { layer_id: video }).ok).toBe(false)
  })
})

describe('set_project_settings', () => {
  it('turning auto_pair_audio_on_import off actually stops the pairing', () => {
    const a = actorWithPool()
    const paired = call(a, 'add_video_layer', {
      media_id: VIDEO_WITH_SOUND, src_in_us: 0, src_out_us: 4_000_000,
      t_start_us: 0, t_end_us: 4_000_000, track_id: aRoll(a),
    })
    // Default-on: the call returns the triple, and two layers landed.
    expect(text(paired)).toContain('audio_layer_id')
    expect(layerCount(a)).toBe(2)

    expect(call(a, 'set_project_settings', { patch: { auto_pair_audio_on_import: false } }).ok).toBe(true)
    expect(a.snapshot().settings.auto_pair_audio_on_import).toBe(false)
    const solo = call(a, 'add_video_layer', {
      media_id: VIDEO_WITH_SOUND, src_in_us: 0, src_out_us: 4_000_000,
      t_start_us: 0, t_end_us: 4_000_000, track_id: bRoll(a),
    })
    // Now a bare layer id, and exactly one more layer on the timeline.
    expect(text(solo)).not.toContain('audio_layer_id')
    expect(layerCount(a)).toBe(3)
  })

  it('is unrecorded: undo walks past it', () => {
    const a = actorWithPool()
    threeClips(a)
    expect(call(a, 'set_project_settings', { patch: { prefer_proxies: true } }).ok).toBe(true)
    expect(call(a, 'undo').ok).toBe(true)
    expect(layerCount(a)).toBe(2)
    expect(a.snapshot().settings.prefer_proxies).toBe(true)
  })

  it('refuses an unknown key rather than dropping it', () => {
    const a = actorWithPool()
    // A REAL field of the stored settings that this tool does not write — the
    // exact case a silent pass-through would report success for.
    expect(errorOf(call(a, 'set_project_settings', { patch: { history_capacity: 10 } }))).toContain('history_capacity')
    expect(a.snapshot().settings.history_capacity).toBe(200)
  })

  it('refuses an empty patch', () => {
    const a = actorWithPool()
    expect(errorOf(call(a, 'set_project_settings', { patch: {} }))).toContain('names no setting')
  })

  it('refuses a review tuple that violates its own bound, storing neither half', () => {
    const a = actorWithPool()
    // 2 * pad_us >= min_pause_us would leave every pause with nothing to cut.
    expect(call(a, 'set_project_settings', { patch: {
      pause_review: { threshold_amp: 0.02, min_pause_us: 100_000, pad_us: 60_000 },
    } }).ok).toBe(false)
    expect(a.snapshot().settings.pause_review).toBe(null)
  })

  it('clears a stored tuning with null', () => {
    const a = actorWithPool()
    expect(call(a, 'set_project_settings', { patch: { shot_review: { sensitivity: 0.5, min_shot_us: 400_000 } } }).ok).toBe(true)
    expect(a.snapshot().settings.shot_review).toEqual({ sensitivity: 0.5, min_shot_us: 400_000 })
    expect(call(a, 'set_project_settings', { patch: { shot_review: null } }).ok).toBe(true)
    expect(a.snapshot().settings.shot_review).toBe(null)
  })

  it('removes a proxy exception with a null value', () => {
    const a = actorWithPool()
    expect(call(a, 'set_project_settings', { patch: { proxy_override: { media_id: AUDIO, value: true } } }).ok).toBe(true)
    expect(a.snapshot().settings.proxy_overrides[AUDIO]).toBe(true)
    expect(call(a, 'set_project_settings', { patch: { proxy_override: { media_id: AUDIO, value: null } } }).ok).toBe(true)
    expect(AUDIO in a.snapshot().settings.proxy_overrides).toBe(false)
  })
})

describe('captions with word timing', () => {
  const TRANSCRIPT = {
    word_timing: 'exact',
    segments: [
      { text: 'hello there', t_start_us: 0, t_end_us: 1_000_000, words: [
        { text: 'hello', t_start_us: 0, t_end_us: 500_000 },
        { text: 'there', t_start_us: 500_000, t_end_us: 1_000_000 },
      ] },
      { text: 'second cue', t_start_us: 1_000_000, t_end_us: 2_000_000, words: [
        { text: 'second', t_start_us: 1_000_000, t_end_us: 1_500_000 },
        { text: 'cue', t_start_us: 1_500_000, t_end_us: 2_000_000 },
      ] },
    ],
  }
  function captionLayers(a: Actor) {
    return tracks(a).filter((t) => t.role === 'Caption').flatMap((t) => t.layers)
  }

  it('apply_transcripts lands one caption per segment and keeps the word offsets', () => {
    const a = actorWithPool()
    const trackId = text(call(a, 'apply_transcripts', { transcripts: [TRANSCRIPT] }))
    expect(tracks(a).find((t) => t.id === trackId)?.role).toBe('Caption')
    const cues = captionLayers(a)
    expect(cues.map((l) => (l.params as { content: string }).content)).toEqual(['hello there', 'second cue'])
    // The point of this tool over apply_subtitles: an SRT has nowhere to put these.
    const timing = cues[0].metadata['weftcut.caption_timing'] as { words: Array<{ text: string }> }
    expect(timing.words.map((w) => w.text)).toEqual(['hello', 'there'])
  })

  it('correct_caption_text refuses while the reference text is blank, and corrects once it is set', () => {
    const a = actorWithPool()
    text(call(a, 'apply_transcripts', { transcripts: [TRANSCRIPT] }))
    expect(errorOf(call(a, 'correct_caption_text', {}))).toContain('correction_script')

    expect(call(a, 'set_project_settings', { patch: { correction_script: 'Hello there. Second cue.' } }).ok).toBe(true)
    const r = json<{ changed: number }>(call(a, 'correct_caption_text', {}))
    expect(r.changed).toBeGreaterThan(0)
    expect(captionLayers(a).map((l) => (l.params as { content: string }).content).join(' ')).toContain('Hello there')
  })

  it('restyle_captions patches every caption and leaves a non-caption Text layer alone', () => {
    const a = actorWithPool()
    text(call(a, 'apply_transcripts', { transcripts: [TRANSCRIPT] }))
    const title = text(call(a, 'add_text_layer', { track_id: aRoll(a), t_start_us: 0, t_end_us: 1_000_000, content: 'Title' }))

    expect(call(a, 'restyle_captions', { font_size_px: 40, outline_width: 3 }).ok).toBe(true)
    for (const cue of captionLayers(a)) {
      const p = cue.params as { font: { size_px: number }; outline: { width: number } | null }
      expect(p.font.size_px).toBe(40)
      expect(p.outline?.width).toBe(3)
    }
    const titleLayer = tracks(a).flatMap((t) => t.layers).find((l) => l.id === title)!
    expect((titleLayer.params as { font: { size_px: number } }).font.size_px).toBe(72)
  })

  it('restyle_captions with outline_width 0 removes the outline', () => {
    const a = actorWithPool()
    text(call(a, 'apply_transcripts', { transcripts: [TRANSCRIPT] }))
    expect(call(a, 'restyle_captions', { outline_width: 2 }).ok).toBe(true)
    expect(call(a, 'restyle_captions', { outline_width: 0 }).ok).toBe(true)
    for (const cue of captionLayers(a)) expect((cue.params as { outline: unknown }).outline).toBe(null)
  })
})

describe('jump_to', () => {
  it('moves the cursor to a named index and back', () => {
    const a = actorWithPool()
    threeClips(a)
    const top = a.historyStatus().cursor
    expect(call(a, 'jump_to', { index: 0 }).ok).toBe(true)
    expect(a.historyStatus().cursor).toBe(0)
    expect(layerCount(a)).toBe(0)
    expect(call(a, 'jump_to', { index: top }).ok).toBe(true)
    expect(layerCount(a)).toBe(3)
  })

  it('refuses an index outside the live stack, naming the bounds', () => {
    const a = actorWithPool()
    threeClips(a)
    expect(errorOf(call(a, 'jump_to', { index: 99 }))).toContain('outside')
    expect(layerCount(a)).toBe(3)
  })

  it('is a revert path, so set_history_lock blocks it with the lock reason', () => {
    const a = actorWithPool()
    threeClips(a)
    expect(call(a, 'set_history_lock', { locked: true, reason: 'mid-batch' }).ok).toBe(true)
    expect(call(a, 'jump_to', { index: 0 }).ok).toBe(false)
    expect(layerCount(a)).toBe(3)
    expect(call(a, 'set_history_lock', { locked: false }).ok).toBe(true)
    expect(call(a, 'jump_to', { index: 0 }).ok).toBe(true)
  })
})

describe('delete_checkpoint', () => {
  it('drops the restore point and leaves the edits it marked in place', () => {
    const a = actorWithPool()
    threeClips(a)
    const id = text(call(a, 'create_checkpoint', { label: 'after three' }))
    expect(json<unknown[]>(call(a, 'list_checkpoints')).length).toBe(1)
    expect(call(a, 'delete_checkpoint', { checkpoint_id: id }).ok).toBe(true)
    expect(json<unknown[]>(call(a, 'list_checkpoints'))).toEqual([])
    expect(layerCount(a)).toBe(3)
  })

  it('refuses an id no checkpoint holds', () => {
    const a = actorWithPool()
    expect(call(a, 'delete_checkpoint', { checkpoint_id: '00000000-0000-7000-8000-00000000dead' }).ok).toBe(false)
  })

  it('is NOT blocked by set_history_lock — forgetting a restore point reverts nothing', () => {
    const a = actorWithPool()
    threeClips(a)
    const id = text(call(a, 'create_checkpoint', { label: 'pinned' }))
    expect(call(a, 'set_history_lock', { locked: true, reason: 'mid-batch' }).ok).toBe(true)
    expect(call(a, 'restore_checkpoint', { checkpoint_id: id }).ok).toBe(false)
    expect(call(a, 'delete_checkpoint', { checkpoint_id: id }).ok).toBe(true)
  })
})

describe('dry_run over the new creation ops', () => {
  it('rehearses a text and an audio layer without committing either', () => {
    const a = actorWithPool()
    const r = json<{ results: Array<{ index: number; status: string }> }>(call(a, 'dry_run', { operations: [
      { kind: 'add_text_layer', track_id: aRoll(a), t_start_us: 0, t_end_us: 1_000_000, content: 'Title' },
      { kind: 'add_audio_layer', track_id: bRoll(a), media_id: AUDIO, src_in_us: 0, src_out_us: 1_000_000, t_start_us: 0, t_end_us: 1_000_000, role: 'sfx' },
    ] }))
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok'])
    expect(layerCount(a)).toBe(0)
  })

  it('predicts the overlap a real add would hit', () => {
    const a = actorWithPool()
    threeClips(a)
    const r = json<{ results: Array<{ status: string }>; halted_at: number | null }>(call(a, 'dry_run', { operations: [
      { kind: 'add_text_layer', track_id: aRoll(a), t_start_us: 0, t_end_us: 1_000_000, content: 'collides' },
    ] }))
    expect(r.results[0].status).toBe('error')
    expect(layerCount(a)).toBe(3)
  })

  it('refuses the batch when add_video_layer names audio-only media', () => {
    const a = actorWithPool()
    expect(errorOf(call(a, 'dry_run', { operations: [
      { kind: 'add_video_layer', track_id: aRoll(a), media_id: AUDIO, src_in_us: 0, src_out_us: 1_000_000, t_start_us: 0, t_end_us: 1_000_000 },
    ] }))).toContain('add_audio_layer')
  })
})
