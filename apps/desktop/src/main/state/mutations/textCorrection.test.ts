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
  it('splits captions at manuscript line breaks, including CRLF and blank lines', () => {
    const { p, c, ids, captions } = fixture('先准备彩纸然后对折最后压平')
    p.settings.correction_script = '先准备彩纸\r\n\r\n然后对折\n最后压平'
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['先准备彩纸', '然后对折', '最后压平'])
    expect(captions().map(l => [l.t_start_us, l.t_end_us])).toEqual([[0, 1_000_000], [1_000_000, 1_800_000], [1_800_000, 2_600_000]])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('joins ASR sentences when the manuscript has no break there', () => {
    const { p, c, ids, captions } = fixture('先准备彩纸。然后对折。')
    p.settings.correction_script = '先准备彩纸然后对折。'
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['先准备彩纸然后对折。'])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('does not invent length-based breaks inside a manuscript sentence', () => {
    const text = '先准备一张彩纸放在桌面上然后沿着中线慢慢对折并且用手指压平边缘接着打开纸张检查折痕是否整齐最后把两侧分别向中心折叠直到全部步骤完成后展示折纸作品。'
    const { p, c, ids, captions } = fixture(text)
    p.settings.correction_script = text
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual([text])
  })
  it('estimates an authored break inside an engine word and remains stable after reopening', () => {
    const text = '先准备彩纸然后对折最后压平'
    const { p, c, ids, captions } = fixture(text)
    const meta = readCaptionTiming(captions()[0]!.metadata[CAPTION_TIMING_KEY])!
    meta.words = [{ text, start_us: 0, end_us: 2_600_000 }]
    p.settings.correction_script = '先准备彩纸\n然后对折\n最后压平'
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['先准备彩纸', '然后对折', '最后压平'])
    expect(captions().map(l => [l.t_start_us, l.t_end_us])).toEqual([[0, 1_000_000], [1_000_000, 1_800_000], [1_800_000, 2_600_000]])
    expect(captions().every(l => readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])?.provenance === 'interpolated_from_cue')).toBe(true)
    const loaded = parseProject(serializeProject(p))
    expect(applyTextCorrection(loaded, ids, c.id, null).changed).toBe(0)
  })
  it('estimates timing when engine words have zero duration', () => {
    const { p, c, ids, captions } = fixture('先准备彩纸然后对折')
    p.settings.correction_script = '先准备彩纸\n然后对折'
    readCaptionTiming(captions()[0]!.metadata[CAPTION_TIMING_KEY])!.words.forEach(w => { w.start_us = 0; w.end_us = 0 })
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['先准备彩纸', '然后对折'])
    expect(captions().map(l => [l.t_start_us, l.t_end_us])).toEqual([[0, 1_000_000], [1_000_000, 1_800_000]])
    expect(captions().every(l => readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])?.provenance === 'interpolated_from_cue')).toBe(true)
  })
  it('joins manuscript fragments across a pause without changing unrelated cues', () => {
    const { p, c, ids, captions } = fixture('先准备彩纸', false)
    delete captions()[0]!.metadata[CAPTION_TIMING_KEY]
    p.settings.correction_script = '先准备彩纸然后对折。'
    applyAddCaptionTrack(p, ids, [
      { start_us: 3_000_000, end_us: 4_000_000, text: '然后对折。' },
      { start_us: 7_000_000, end_us: 9_000_000, text: '窗外的小鸟正在唱歌。' },
    ], c.width, c.height, null, c.id)
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['先准备彩纸然后对折。', '窗外的小鸟正在唱歌。'])
    expect(captions().map(l => [l.t_start_us, l.t_end_us])).toEqual([[0, 4_000_000], [7_000_000, 9_000_000]])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('corrects near sounds and numeral-shaped names through the caption command', () => {
    const { p, c, ids, captions } = fixture('新的标识应该吃什么颜色？', false)
    p.settings.correction_script = '新的标识应该是什么颜色？\nHi欢迎来到课堂，我叫吴老师\n下面演示折纸步骤\nPaperBot展示了折纸过程'
    applyAddCaptionTrack(p, ids, [
      { start_us: 4_000_000, end_us: 7_000_000, text: '新的标识应该吃什么颜色？' },
      { start_us: 8_000_000, end_us: 14_000_000, text: '好的,欢迎来到课堂，我叫五老师 下面演示折纸步骤 PaperBot展示了折纸过程' },
    ], c.width, c.height, null, c.id)
    const times = captions().map(l => [l.t_start_us, l.t_end_us])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(3)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual([
      '新的标识应该是什么颜色？', '新的标识应该是什么颜色？',
      '好的,欢迎来到课堂，我叫吴老师', '下面演示折纸步骤', 'PaperBot展示了折纸过程',
    ])
    expect(captions().slice(0, 2).map(l => [l.t_start_us, l.t_end_us])).toEqual(times.slice(0, 2))
    expect(captions()[2]!.t_start_us).toBe(times[2]![0])
    expect(captions().at(-1)!.t_end_us).toBe(times[2]![1])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('persists transcript word timing and splits on manuscript punctuation', () => {
    const { p, c, ids, captions } = fixture()
    expect(captions()[0]!.metadata[CAPTION_TIMING_KEY]).toMatchObject({ provenance: 'exact', text: '今天介绍自动剪缉功能它可以节省时间' })
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(1)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。', '它可以节省时间。'])
    expect(captions()[0]!.t_end_us).toBe(2_000_000)
    expect(captions()[1]!.t_start_us).toBe(2_000_000)
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('splits with interpolated word times and records their provenance', () => {
    const { p, c, ids, captions } = fixture(undefined, false)
    const end = captions()[0]!.t_end_us
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。', '它可以节省时间。'])
    expect(captions().at(-1)!.t_end_us).toBe(end)
    expect(captions().every(l => readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])?.provenance === 'interpolated_from_cue')).toBe(true)
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('supports imported captions with no word metadata', () => {
    const { p, c, ids, captions } = fixture(undefined, false)
    delete captions()[0]!.metadata[CAPTION_TIMING_KEY]
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。', '它可以节省时间。'])
    expect(captions().map(l => [l.t_start_us, l.t_end_us])).toEqual([[0, 2_000_000], [2_000_000, 3_400_000]])
    expect(captions().every(l => readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])?.provenance === 'interpolated_from_cue')).toBe(true)
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
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
    expect(captions().find(l => l.id === second.id)!.params).toMatchObject({ content: '今天介绍自动剪辑功能。' })
  })
  it('corrects repeated imported cues independently and remains stable', () => {
    const { p, c, ids, captions } = fixture('今天介绍自动剪缉功能', false)
    applyAddCaptionTrack(p, ids, [{ start_us: 2_000_000, end_us: 4_000_000, text: '今天介绍自动剪缉功能' }], c.width, c.height, null, c.id)
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。', '今天介绍自动剪辑功能。'])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('joins imported cue fragments into the manuscript sentence', () => {
    const { p, c, ids, captions } = fixture('今天介绍自动剪', false)
    applyAddCaptionTrack(p, ids, [{ start_us: 1_400_000, end_us: 3_000_000, text: '缉功能' }], c.width, c.height, null, c.id)
    applyTextCorrection(p, ids, c.id, null)
    expect(captions().map(l => l.params.kind === 'Text' && l.params.content)).toEqual(['今天介绍自动剪辑功能。'])
    expect(captions().map(l => [l.t_start_us, l.t_end_us])).toEqual([[0, 3_000_000]])
    expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
  })
  it('refuses locked targets atomically', () => {
    const { p, c, ids, captions } = fixture()
    captions()[0]!.locked = true
    const before = JSON.stringify(p)
    expect(() => applyTextCorrection(p, ids, c.id, null)).toThrow('InvalidArgument')
    expect(JSON.stringify(p)).toBe(before)
  })
  it('estimates new timing after a manual text edit or trim', () => {
    for (const edit of ['text', 'trim']) {
      const { p, c, ids, captions } = fixture()
      if (edit === 'trim') captions()[0]!.t_end_us += 200_000
      else { const params = captions()[0]!.params; if (params.kind === 'Text') params.content = '今天介绍自动剪缉功能它可以节省时间哦' }
      applyTextCorrection(p, ids, c.id, null)
      expect(captions().length).toBeGreaterThanOrEqual(2)
      expect(captions().every(l => readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])?.provenance === 'interpolated_from_cue')).toBe(true)
      expect(captions().map(l => l.params.kind === 'Text' ? l.params.content : '').join('')).toBe('今天介绍自动剪辑功能。它可以节省时间。' + (edit === 'text' ? '哦' : ''))
      expect(applyTextCorrection(p, ids, c.id, null).changed).toBe(0)
    }
  })
  it('keeps relative word times valid after moving a caption', () => {
    const { p, c, ids, captions } = fixture()
    captions()[0]!.t_start_us += 10_000_000; captions()[0]!.t_end_us += 10_000_000
    applyTextCorrection(p, ids, c.id, null)
    expect(captions()).toHaveLength(2)
    expect(captions()[1]!.t_start_us).toBe(12_000_000)
  })
  it('estimates when the source changes but preserves linked caption boundaries', () => {
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
      expect(captions()).toHaveLength(change === 'link' ? 1 : 2)
      expect(captions().at(-1)!.t_end_us).toBe(end)
      expect(captions().map(l => l.params.kind === 'Text' ? l.params.content : '').join('')).toBe('今天介绍自动剪辑功能。它可以节省时间。')
      if (change === 'source') expect(captions().every(l => readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])?.provenance === 'interpolated_from_cue')).toBe(true)
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
