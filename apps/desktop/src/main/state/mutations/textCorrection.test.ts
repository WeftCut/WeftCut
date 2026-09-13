import { describe, expect, it } from 'vitest'
import { blankProject, rootComposition } from '../model'
import { seededGen } from '../ids'
import { createActor } from '../actor'
import { serializeProject, parseProject } from '../serialize'
import { applyAddCaptionTrack } from './captions'
import { applyTranscripts, applyTextCorrection, sourceSignature } from './textCorrection'
import { applyAddLayer } from './add'
import { audioParams } from './media'
import { CAPTION_TIMING_KEY, readCaptionTiming, type TranscriptPayload } from '../../../shared/captionTiming'

function fixture(text = '今天介绍自动剪缉功能它可以节省时间', exact = true) {
  const ids = seededGen(), p = blankProject(ids, 'correction'), c = rootComposition(p)
  const transcript: TranscriptPayload = { word_timing: exact ? 'exact' : 'interpolated_from_cue', segments: [{ text, t_start_us: 0, t_end_us: [...text].length * 200_000,
    words: [...text].map((s, i) => ({ text: s, t_start_us: i * 200_000, t_end_us: (i + 1) * 200_000 })) }] }
  applyTranscripts(p, ids, [transcript], c.id)
  p.settings.correction_script = '今天介绍自动剪辑功能。它可以节省时间。'
  const captions = () => c.tracks.filter(t => t.role === 'Caption').flatMap(t => t.layers)
  return { ids, p, c, captions, transcript }
}

describe('text correction through project state', () => {
  it('persists transcript word timing and splits on manuscript punctuation', () => {
    const { p, c, ids, captions } = fixture()
    expect(captions()[0]!.metadata[CAPTION_TIMING_KEY]).toMatchObject({ provenance: 'exact', text: '今天介绍自动剪缉功能它可以节省时间' })
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(1)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。', '它可以节省时间。'])
    expect(captions()[0]!.t_end_us).toBe(2_000_000)
    expect(captions()[1]!.t_start_us).toBe(2_000_000)
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('only changes text with interpolated word times', () => {
    const { p, c, ids, captions } = fixture(undefined, false)
    const end = captions()[0]!.t_end_us
    applyTextCorrection(p, ids, c.id, null)
    expect(captions()).toHaveLength(1)
    expect(captions()[0]!.t_end_us).toBe(end)
    expect(captions()[0]!.params).toMatchObject({ content: '今天介绍自动剪辑功能。它可以节省时间。' })
  })
  it('supports imported captions with no word metadata', () => {
    const { p, c, ids, captions } = fixture(undefined, false)
    delete captions()[0]!.metadata[CAPTION_TIMING_KEY]
    applyTextCorrection(p, ids, c.id, null)
    expect(captions()).toHaveLength(1)
    expect(captions()[0]!.params).toMatchObject({ content: '今天介绍自动剪辑功能。它可以节省时间。' })
  })
  it('inherits static appearance and preserves animation boundaries', () => {
    const a = fixture(), l = a.captions()[0]!
    if (l.params.kind === 'Text') { l.params.font.size_px = 88; l.params.intro = 'Typewriter' }
    const end = l.t_end_us
    applyTextCorrection(a.p, a.ids, a.c.id, null)
    expect(a.captions()).toHaveLength(1)
    expect(l.params).toMatchObject({ intro: 'Typewriter', font: { size_px: 88 } })
    expect(l.t_end_us).toBe(end)
    const b = fixture()
    const bp = b.captions()[0]!.params
    if (bp.kind === 'Text') bp.font.size_px = 88
    applyTextCorrection(b.p, b.ids, b.c.id, null)
    expect(b.captions().every(x => x.params.kind === 'Text' && x.params.font.size_px === 88)).toBe(true)
  })
  it('only touches explicitly selected captions', () => {
    const { p, c, ids, captions } = fixture(undefined, false)
    applyAddCaptionTrack(p, ids, [{ start_us: 10_000_000, end_us: 12_000_000, text: '今天介绍自动剪缉功能' }], c.width, c.height, null, c.id)
    const second = captions()[1]!
    applyTextCorrection(p, ids, c.id, [second.id])
    expect(captions()[0]!.params).toMatchObject({ content: '今天介绍自动剪缉功能它可以节省时间' })
    expect(second.params).toMatchObject({ content: '今天介绍自动剪辑功能。' })
  })
  it('corrects repeated imported cues independently and remains stable', () => {
    const { p, c, ids, captions } = fixture('今天介绍自动剪缉功能', false)
    applyAddCaptionTrack(p, ids, [{ start_us: 2_000_000, end_us: 4_000_000, text: '今天介绍自动剪缉功能' }], c.width, c.height, null, c.id)
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。', '今天介绍自动剪辑功能。'])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('uses context across imported cue boundaries without moving words or times', () => {
    const { p, c, ids, captions } = fixture('今天介绍自动剪', false)
    applyAddCaptionTrack(p, ids, [{ start_us: 1_400_000, end_us: 3_000_000, text: '缉功能' }], c.width, c.height, null, c.id)
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪', '辑功能。'])
    expect(captions()[1]!.t_start_us).toBe(1_400_000)
  })
  it('refuses locked targets atomically', () => {
    const { p, c, ids, captions } = fixture()
    captions()[0]!.locked = true
    const before = JSON.stringify(p)
    expect(() => applyTextCorrection(p, ids, c.id, null)).toThrow('InvalidArgument')
    expect(JSON.stringify(p)).toBe(before)
  })
  it('invalidates word timing after a manual text edit or trim', () => {
    for (const edit of ['text', 'trim']) {
      const { p, c, ids, captions } = fixture()
      if (edit === 'trim') captions()[0]!.t_end_us += 200_000
      else { const params = captions()[0]!.params; if (params.kind === 'Text') params.content = '今天介绍自动剪缉功能它可以节省时间哦' }
      applyTextCorrection(p, ids, c.id, null)
      expect(captions()).toHaveLength(1)
    }
  })
  it('keeps relative word times valid after moving a caption', () => {
    const { p, c, ids, captions } = fixture()
    captions()[0]!.t_start_us += 10_000_000; captions()[0]!.t_end_us += 10_000_000
    applyTextCorrection(p, ids, c.id, null)
    expect(captions()).toHaveLength(2)
    expect(captions()[1]!.t_start_us).toBe(12_000_000)
  })
  it('preserves boundaries when the source changes or the caption is linked', () => {
    for (const change of ['source', 'link']) {
      const { p, c, ids, captions } = fixture()
      const track = c.tracks.find(t => t.role !== 'Caption')!
      const sourceId = applyAddLayer(p, ids, track.id, audioParams('media', 0, 4_000_000), 0, 4_000_000)
      const source = track.layers.find(l => l.id === sourceId)!
      readCaptionTiming(captions()[0]!.metadata[CAPTION_TIMING_KEY])!.source = { id: sourceId, signature: sourceSignature(source) }
      if (change === 'source') { source.t_start_us += 200_000; source.t_end_us += 200_000 }
      else c.links.push({ id: ids(), members: [sourceId, captions()[0]!.id].sort() })
      const end = captions()[0]!.t_end_us
      applyTextCorrection(p, ids, c.id, null)
      expect(captions()).toHaveLength(1)
      expect(captions()[0]!.t_end_us).toBe(end)
      expect(captions()[0]!.params).toMatchObject({ content: '今天介绍自动剪辑功能。它可以节省时间。' })
    }
  })
  it('refuses transcript ingestion if the source moved during transcription', () => {
    const { p, c, ids, transcript } = fixture()
    const track = c.tracks.find(t => t.role !== 'Caption')!
    const sourceId = applyAddLayer(p, ids, track.id, audioParams('media', 0, 4_000_000), 0, 4_000_000)
    const source = track.layers.find(l => l.id === sourceId)!
    transcript.source = { id: sourceId, signature: sourceSignature(source), project_id: p.project_id, composition_id: c.id }
    source.t_start_us += 200_000; source.t_end_us += 200_000
    const before = JSON.stringify(p)
    expect(() => applyTranscripts(p, ids, [transcript], c.id)).toThrow('InvalidArgument')
    expect(JSON.stringify(p)).toBe(before)
  })
  it('uses current text, stores the manuscript independently of undo, and records one correction', () => {
    const { p, ids } = fixture()
    const actor = createActor({ initial: p, idGen: ids })
    const projectId = p.project_id, compositionId = p.root_id
    const script = '今天介绍自动剪辑功能。它可以节省时间。'
    expect(actor.command('set_correction_script', { project_id: projectId, text: script }).ok).toBe(true)
    const before = actor.snapshot(), count = actor.historyStatus().len
    expect(actor.command('correct_caption_text', { project_id: projectId, composition_id: compositionId, layer_ids: null })).toEqual({ ok: true, value: { changed: 1 } })
    expect(actor.historyStatus().len).toBe(count + 1)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().compositions).toEqual(before.compositions)
    expect(actor.snapshot().settings.correction_script).toBe(script)
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    const corrected = actor.snapshot()
    actor.command('correct_caption_text', { project_id: projectId, composition_id: compositionId, layer_ids: null })
    expect(actor.historyStatus().len).toBe(count + 1)
    const loaded = parseProject(serializeProject(corrected))
    expect(loaded.settings.correction_script).toBe(script)
    expect(rootComposition(loaded).tracks).toEqual(rootComposition(corrected).tracks)
  })
  it('rejects queued edits meant for another project', () => {
    const { p, ids } = fixture(), actor = createActor({ initial: p, idGen: ids })
    expect(actor.command('set_correction_script', { project_id: 'old', text: 'wrong' }).ok).toBe(false)
    expect(actor.command('correct_caption_text', { project_id: 'old', composition_id: p.root_id, layer_ids: null }).ok).toBe(false)
  })
  it('rejects stale input snapshots without changing captions or history', () => {
    for (const change of ['text', 'time', 'script', 'scope']) {
      const { p, c, ids, captions } = fixture()
      const expected = { script: p.settings.correction_script!, captions: captions().map(l => ({ id: l.id,
        text: l.params.kind === 'Text' ? l.params.content : '', t_start_us: l.t_start_us, t_end_us: l.t_end_us })) }
      const l = captions()[0]!
      if (change === 'text' && l.params.kind === 'Text') l.params.content += '哦'
      if (change === 'time') l.t_end_us += 200_000
      if (change === 'script') p.settings.correction_script += '新的文稿。'
      if (change === 'scope') applyAddCaptionTrack(p, ids, [{ start_us: 10_000_000, end_us: 12_000_000, text: '新的字幕' }], c.width, c.height, null, c.id)
      const actor = createActor({ initial: p, idGen: ids }), before = actor.snapshot(), history = actor.historyStatus()
      expect(actor.command('correct_caption_text', { project_id: p.project_id, composition_id: c.id, layer_ids: null, expected }).ok).toBe(false)
      expect(actor.snapshot()).toEqual(before)
      expect(actor.historyStatus()).toEqual(history)
    }
  })
  it('does not merge different styles', () => {
    const { p, c, ids, captions } = fixture('今天介绍自动剪缉功能')
    applyAddCaptionTrack(p, ids, [{ start_us: 2_000_000, end_us: 4_000_000, text: '它可以节省时间' }], c.width, c.height, null, c.id)
    const second = captions()[1]!
    if (second.params.kind === 'Text') second.params.font.size_px = 80
    applyTextCorrection(p, ids, c.id, null)
    expect(captions()).toHaveLength(2)
    expect(second.params).toMatchObject({ font: { size_px: 80 } })
  })
})
