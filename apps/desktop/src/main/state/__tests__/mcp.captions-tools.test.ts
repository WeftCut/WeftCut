// apps/desktop/src/main/state/__tests__/mcp.captions-tools.test.ts
// The caption primitives over the MCP surface: export as SRT/VTT, merge cues,
// restyle a subset.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type TextParams } from '../model'
import { root } from './fixtures/project'

const call = (a: ActorHandle, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const body = <T,>(r: ReturnType<ActorHandle['mcpCall']>): T => { if (!r.ok) throw new Error(r.error.message); return JSON.parse(r.result.content[0].text) as T }

/** A project with three cues on one caption lane via apply_transcripts. */
function captioned() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'caps'), idGen: gen, clock: () => '<TS>' })
  const segs = [[1_000_000, 2_000_000, 'One'], [2_000_000, 3_000_000, 'Two'], [4_000_000, 5_000_000, 'Three']] as const
  const r = body<{ caption_track_id: string }>(call(a, 'apply_transcripts', { transcripts: [{ word_timing: 'none', segments: segs.map(([s, e, t]) => ({ text: t, t_start_us: s, t_end_us: e, words: [] })) }] }))
  const track = root(a.snapshot()).tracks.find((t) => t.id === r.caption_track_id)!
  const ids = [...track.layers].sort((x, y) => x.t_start_us - y.t_start_us).map((l) => l.id)
  return { a, trackId: track.id, ids }
}
const layer = (a: ActorHandle, id: string) => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)

describe('export_captions', () => {
  it('writes the lane as SRT in time order and records nothing', () => {
    const { a } = captioned()
    const len = a.historyStatus().len
    const out = body<{ format: string; cues: number; body: string }>(call(a, 'export_captions', { format: 'srt' }))
    expect(out.cues).toBe(3)
    expect(out.body).toBe('1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:02,000 --> 00:00:03,000\nTwo\n\n3\n00:00:04,000 --> 00:00:05,000\nThree\n')
    expect(a.historyStatus().len).toBe(len)
    const vtt = body<{ body: string }>(call(a, 'export_captions', { format: 'vtt' }))
    expect(vtt.body.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne')).toBe(true)
  })

  it('takes one lane by track_id and refuses a lane that is not a caption track', () => {
    const { a, trackId } = captioned()
    expect(body<{ cues: number }>(call(a, 'export_captions', { format: 'srt', track_id: trackId })).cues).toBe(3)
    const r = call(a, 'export_captions', { format: 'srt', track_id: root(a.snapshot()).tracks[0].id })
    expect(!r.ok && r.error.message).toContain('not a caption track')
    const fmt = call(a, 'export_captions', { format: 'ass' })
    expect(fmt.ok).toBe(false)
  })
})

describe('merge_captions', () => {
  it('folds cues into the earliest — union span, joined text, style kept — and deletes the rest, undoably', () => {
    const { a, ids } = captioned()
    const [one, two] = ids
    const len = a.historyStatus().len
    const rec = body<{ layer_id: string; t_start_us: number; t_end_us: number; content: string; merged: number; removed: string[] }>(call(a, 'merge_captions', { layer_ids: [two, one] }))
    expect(rec).toMatchObject({ layer_id: one, t_start_us: 1_000_000, t_end_us: 3_000_000, content: 'One\nTwo', merged: 2, removed: [two] })
    expect(layer(a, two)).toBeUndefined()
    expect((layer(a, one)!.params as TextParams).content).toBe('One\nTwo')
    expect(a.historyStatus().len).toBe(len + 1)
    a.dispatch('undo', {})
    expect(layer(a, two)).toBeDefined()
  })

  it('spans a gap, and refuses fewer than two, a non-caption, and a union over another cue of the lane', () => {
    const { a, ids } = captioned()
    const [one, two, three] = ids
    const over = call(a, 'merge_captions', { layer_ids: [one, three] }) // Two sits between
    expect(!over.ok && over.error.message).toContain('collides')
    expect(call(a, 'merge_captions', { layer_ids: [one] }).ok).toBe(false)
    const title = body<{ layer_id: string }>(call(a, 'add_text_layer', { track_id: root(a.snapshot()).tracks[1].id, content: 'T', t_start_us: 0, t_end_us: 500_000 }))
    const mixed = call(a, 'merge_captions', { layer_ids: [one, title.layer_id] })
    expect(!mixed.ok && mixed.error.message).toContain('not a caption')
    // Two then Three: a one-second gap, spanned.
    const rec = body<{ t_start_us: number; t_end_us: number }>(call(a, 'merge_captions', { layer_ids: [two, three] }))
    expect([rec.t_start_us, rec.t_end_us]).toEqual([2_000_000, 5_000_000])
  })
})

describe('restyle_captions { layer_ids }', () => {
  it('restyles only the named captions, and refuses a title through the caption door', () => {
    const { a, ids } = captioned()
    const [one, two] = ids
    const r = body<{ captions: number; restyled: number }>(call(a, 'restyle_captions', { font_size_px: 99, layer_ids: [one] }))
    expect(r).toEqual({ captions: 3, restyled: 1 })
    expect((layer(a, one)!.params as TextParams).font.size_px).toBe(99)
    expect((layer(a, two)!.params as TextParams).font.size_px).not.toBe(99)
    const title = body<{ layer_id: string }>(call(a, 'add_text_layer', { track_id: root(a.snapshot()).tracks[1].id, content: 'T', t_start_us: 0, t_end_us: 500_000 }))
    const bad = call(a, 'restyle_captions', { font_size_px: 12, layer_ids: [title.layer_id] })
    expect(!bad.ok && bad.error.message).toContain('update_layer_params')
  })

  it('a patch naming no style is refused, and `restyled` counts the captions it wrote', () => {
    const { a, ids } = captioned()
    const bare = call(a, 'restyle_captions', {})
    expect(bare.ok).toBe(false)
    if (bare.ok) throw new Error('expected a refusal')
    expect(bare.error.message).toContain('font_family')
    // A repeated id is one caption, and the count says so rather than echoing
    // the request.
    const out = body<{ restyled: number }>(call(a, 'restyle_captions', { layer_ids: [ids[0], ids[0]], font_size_px: 40 }))
    expect(out.restyled).toBe(1)
    expect(body<{ restyled: number }>(call(a, 'restyle_captions', { font_size_px: 44 })).restyled).toBe(3)
  })

  it('an empty layer_ids is refused — never success for nothing done', () => {
    const { a } = captioned()
    const r = call(a, 'restyle_captions', { font_size_px: 12, layer_ids: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.error.code).toBe('invalid_params'); expect(r.error.message).toContain('omit it') }
  })
})
