// apps/desktop/src/main/state/__tests__/mcp.captions-tools.test.ts
// The caption primitives over the MCP surface: export as SRT/VTT, merge cues,
// apply transcripts, correct their text against a script.
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

  it('a range (start_export\'s) clips cues to it and shifts them to 0, so the SRT lines up with a range export', () => {
    const { a } = captioned()
    // 1.5 s – 4.5 s at 30 fps: One and Three are clipped, Two kept whole.
    const out = body<{ cues: number; body: string; range: unknown }>(call(a, 'export_captions', { format: 'srt', range: { t_start_us: 1_500_000, t_end_us: 4_500_000 } }))
    expect(out.range).toEqual({ t_start_us: 1_500_000, t_end_us: 4_500_000 })
    expect(out.cues).toBe(3)
    expect(out.body).toBe('1\n00:00:00,000 --> 00:00:00,500\nOne\n\n2\n00:00:00,500 --> 00:00:01,500\nTwo\n\n3\n00:00:02,500 --> 00:00:03,000\nThree\n')
    // Cues outside the range are dropped; the range snaps to the frame grid.
    const inner = body<{ cues: number; body: string; range: unknown }>(call(a, 'export_captions', { format: 'srt', range: { t_start_us: 2_000_010, t_end_us: 3_000_000 } }))
    expect(inner).toMatchObject({ cues: 1, range: { t_start_us: 2_000_000, t_end_us: 3_000_000 } })
    expect(inner.body).toBe('1\n00:00:00,000 --> 00:00:01,000\nTwo\n')
    expect(body<{ range?: unknown }>(call(a, 'export_captions', { format: 'srt' }))).not.toHaveProperty('range')
  })

  it('refuses a malformed range and arguments it does not take, naming range', () => {
    const { a } = captioned()
    for (const args of [
      { format: 'srt', range: { t_start_us: 3_000_000, t_end_us: 1_000_000 } },
      { format: 'srt', range: { t_start_us: 0 } },
      { format: 'srt', range: { start_us: 0, end_us: 1_000_000 } },
      { format: 'srt', range: { t_start_us: 0, t_end_us: 10 } },
    ]) {
      const r = call(a, 'export_captions', args)
      expect(r.ok, JSON.stringify(args)).toBe(false)
      expect(!r.ok && r.error.code).toBe('invalid_params')
    }
    const flat = call(a, 'export_captions', { format: 'srt', t_start_us: 0, t_end_us: 1_000_000 })
    expect(!flat.ok && flat.error.message).toContain('range { t_start_us, t_end_us }')
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
    const title = body<{ layers: Array<{ layer_id: string }> }>(call(a, 'add_layers', { layers: [{ track_id: root(a.snapshot()).tracks[1].id, t_start_us: 0, t_end_us: 500_000, content: { kind: 'text', content: 'T' } }] })).layers[0]!
    const mixed = call(a, 'merge_captions', { layer_ids: [one, title.layer_id] })
    expect(!mixed.ok && mixed.error.message).toContain('not a caption')
    // Two then Three: a one-second gap, spanned.
    const rec = body<{ t_start_us: number; t_end_us: number }>(call(a, 'merge_captions', { layer_ids: [two, three] }))
    expect([rec.t_start_us, rec.t_end_us]).toEqual([2_000_000, 5_000_000])
  })
})

describe('the caption family over MCP (ticket 14)', () => {
  it('has no restyle_captions: a caption look is a token edit plus restyle_to_taste', () => {
    const { a } = captioned()
    const r = call(a, 'restyle_captions', { font_size_px: 40 })
    expect(!r.ok && r.error.code).toBe('not_found')
  })

  it('apply_transcripts answers the cue ids in time order', () => {
    const { a, ids } = captioned()
    const gen = seededGen()
    const b = createActor({ initial: blankProject(gen, 'caps'), idGen: gen, clock: () => '<TS>' })
    const out = body<{ caption_track_id: string; cue_layer_ids: string[] }>(call(b, 'apply_transcripts', { transcripts: [{ word_timing: 'none', segments: [
      { text: 'Late', t_start_us: 3_000_000, t_end_us: 4_000_000, words: [] }, { text: 'Early', t_start_us: 1_000_000, t_end_us: 2_000_000, words: [] }] }] }))
    expect(out.cue_layer_ids.map((id) => (layer(b, id)!.params as TextParams).content)).toEqual(['Early', 'Late'])
    expect(ids).toHaveLength(3)
    expect(Object.keys(body<Record<string, unknown>>(call(a, 'apply_transcripts', { transcripts: [] }))).sort()).toEqual(['caption_track_id', 'cue_layer_ids'])
  })

  it('apply_transcripts refuses a transcript whose source clip changed, and the old source_layer_ids', () => {
    const { a } = captioned()
    const clip = body<{ layers: Array<{ layer_id: string }> }>(call(a, 'add_layers', { layers: [{ track_id: root(a.snapshot()).tracks[1].id, t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'color', color: { r: 0, g: 0, b: 0, a: 255 } } }] })).layers[0]!
    const seg = { text: 'Hi', t_start_us: 0, t_end_us: 1_000_000, words: [] }
    const stale = call(a, 'apply_transcripts', { transcripts: [{ source: { layer_id: clip.layer_id, signature: '[0,1]' }, word_timing: 'none', segments: [seg] }] })
    expect(!stale.ok && stale.error.message).toContain('transcribe it again')
    const old = call(a, 'apply_transcripts', { transcripts: [{ word_timing: 'none', segments: [seg] }], source_layer_ids: [clip.layer_id] })
    expect(!old.ok && old.error.message).toContain('`source`')
  })
})

describe('correct_caption_text { script }', () => {
  function spoken() {
    const gen = seededGen()
    const a = createActor({ initial: blankProject(gen, 'caps'), idGen: gen, clock: () => '<TS>' })
    const segs = [[0, 1_000_000, 'hello wicked media'], [1_000_000, 2_000_000, 'we make videos'], [2_000_000, 3_000_000, 'every day']] as const
    const { cue_layer_ids: ids } = body<{ cue_layer_ids: string[] }>(call(a, 'apply_transcripts', { transcripts: [{ word_timing: 'none', segments: segs.map(([s, e, t]) => ({ text: t, t_start_us: s, t_end_us: e, words: [] })) }] }))
    return { a, ids }
  }
  const spans = (a: ActorHandle, ids: string[]) => ids.map((id) => { const l = layer(a, id)!; return [l.t_start_us, l.t_end_us, (l.params as TextParams).content] })

  it('corrects text in place, keeps every cue and its timing, and lists the changes', () => {
    const { a, ids } = spoken()
    const before = spans(a, ids)
    const len = a.historyStatus().len
    const out = body<{ changed: number; match_ratio: number; changes: Array<{ layer_id: string; before: string; after: string }> }>(
      call(a, 'correct_caption_text', { script: 'Hello Wicked Media.\nWe make videos every day.' }))
    expect(out.changed).toBe(out.changes.length)
    expect(out.changes[0]).toEqual({ layer_id: ids[0], before: 'hello wicked media', after: expect.stringContaining('Wicked Media') })
    expect(out.match_ratio).toBeGreaterThanOrEqual(0.5)
    const after = spans(a, ids)
    expect(after.map(([s, e]) => [s, e])).toEqual(before.map(([s, e]) => [s, e]))
    expect(root(a.snapshot()).tracks.flatMap((t) => t.layers).filter((l) => l.params.kind === 'Text')).toHaveLength(3)
    expect(a.historyStatus().len).toBe(len + 1)
    // The script never lands in the project settings.
    expect(a.snapshot().settings.correction_script ?? '').toBe('')
  })

  it('refuses notes passed as the script, changing nothing', () => {
    const { a, ids } = spoken()
    const before = spans(a, ids)
    const r = call(a, 'correct_caption_text', { script: 'Spelling: Wicked Media (company).' })
    expect(!r.ok && r.error.message).toContain('full verbatim transcript')
    expect(spans(a, ids)).toEqual(before)
  })

  it('takes the script as an argument only', () => {
    const { a } = spoken()
    expect(call(a, 'correct_caption_text', {}).ok).toBe(false)
    const set = call(a, 'set_project_settings', { patch: { correction_script: 'x' } })
    expect(!set.ok && set.error.message).toContain('correct_caption_text { script }')
  })
})
