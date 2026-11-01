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
import { captionLimits } from '../../../shared/craft'

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
    expect(actor.command('correct_caption_text', { project_id: projectId, composition_id: compositionId, layer_ids: null })).toMatchObject({ ok: true, value: { changed: 1 } })
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

// Whisper-style English captions against the corrected transcript (issue 22).
const SCRIPT = 'Hi everyone, my name is Lane Rasberry and I am the president of Wikimedia New York City and we meet at LaGuardia Community College every month.\n' +
  'Every year Wikimedia hosts an edit-a-thon there, and then we all edit together.'
const CUES = [
  'Hi everyone, my name is Laine Raspberry and I',
  'am the president of with the media in\nNew York City and we meet',
  'at LaGuardia Community\nCollege every month.',
  'Every year Wicked Media hosts an edit-a-thon there,',
  'and then, you know, we all edit together.',
]
function english() {
  const ids = seededGen(), p = blankProject(ids, 'correction'), c = rootComposition(p)
  // Exact word times, 2 s a cue, spread over its words.
  const transcript: TranscriptPayload = { word_timing: 'exact', segments: CUES.map((text, n) => {
    const words = text.split(/\s+/), step = 2_000_000 / words.length
    return { text, t_start_us: n * 2_000_000, t_end_us: (n + 1) * 2_000_000,
      words: words.map((w, i) => ({ text: w, t_start_us: n * 2_000_000 + Math.round(i * step), t_end_us: n * 2_000_000 + Math.round((i + 1) * step) })) }
  }) }
  applyTranscripts(p, ids, [transcript], c.id)
  const captions = () => c.tracks.filter(t => t.role === 'Caption').flatMap(t => t.layers)
  const text = (l: ReturnType<typeof captions>[number]) => l.params.kind === 'Text' ? l.params.content : ''
  return { ids, p, c, captions, text }
}
const MAX_CHARS = captionLimits(null).max_chars

describe('English captions against a corrected transcript', () => {
  it('text only: takes the script words, keeps every cue and its timing, wraps changed cues to the line limit', () => {
    const { p, c, ids, captions, text } = english()
    const before = captions().map(l => ({ id: l.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us, text: text(l) }))
    const out = applyTextCorrection(p, ids, c.id, null, undefined, { kind: 'text_only', script: SCRIPT }, MAX_CHARS)
    expect(captions().map(l => ({ id: l.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us }))).toEqual(before.map(({ text: _, ...b }) => b))
    const after = captions().map(text)
    expect(after[0]!.replace(/\n/g, ' ')).toBe('Hi everyone, my name is Lane Rasberry and I')
    expect(after[1]!.replace(/\n/g, ' ')).toBe('am the president of Wikimedia New York City and we meet')
    expect(after[3]!.replace(/\n/g, ' ')).toBe('Every year Wikimedia hosts an edit-a-thon there,')
    // Nothing to fix: byte for byte, its line break included.
    expect(after[2]).toBe(CUES[2])
    // The ad lib the script lacks survives.
    expect(after[4]).toBe(CUES[4])
    for (const [i, t] of after.entries()) if (t !== CUES[i]) for (const line of t.split('\n')) expect(line.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(out.changed).toBe(3)
    expect(out.changes.map(x => x.layer_id)).toEqual([before[0]!.id, before[1]!.id, before[3]!.id])
    // Substituted words count as aligned; only the ad lib does not.
    expect(out.match_ratio).toBeGreaterThan(0.95)
    expect(applyTextCorrection(p, ids, c.id, null, undefined, { kind: 'text_only', script: SCRIPT }, MAX_CHARS).changed).toBe(0)
  })
  it('text only without a line limit keeps a changed cue\'s line breaks where they were', () => {
    const { p, c, ids, captions, text } = english()
    applyTextCorrection(p, ids, c.id, null, undefined, { kind: 'text_only', script: SCRIPT })
    expect(captions().map(text).slice(1, 3)).toEqual(['am the president of Wikimedia\nNew York City and we meet', CUES[2]])
  })
  it('never substitutes numbers or negations, nor inserts skipped words', () => {
    const { p, c, ids, captions, text } = english()
    const script = 'We have thirty volunteers who help us. We have 30 editors who help us. Anyone can now edit the pages here. Then we all edit articles together.'
    const cues = ['We have twenty volunteers who help us.', 'We have 20 editors who help us.', 'Anyone can not edit the pages here.', 'Then we all edit together.']
    applyAddCaptionTrack(p, ids, cues.map((t, i) => ({ start_us: 20_000_000 + i * 2_000_000, end_us: 22_000_000 + i * 2_000_000, text: t })), c.width, c.height, null, c.id)
    const added = captions().slice(CUES.length)
    applyTextCorrection(p, ids, c.id, added.map(l => l.id), undefined, { kind: 'text_only', script }, MAX_CHARS)
    expect(captions().slice(CUES.length).map(text)).toEqual(cues)
  })
  it('manuscript mode substitutes too, without empty or overlapping cues', () => {
    const { p, c, ids, captions, text } = english()
    p.settings.correction_script = SCRIPT
    applyTextCorrection(p, ids, c.id, null, undefined, { kind: 'manuscript' }, MAX_CHARS)
    const after = captions(), joined = after.map(text).join(' ').replace(/\s+/g, ' ')
    expect(joined).toContain('my name is Lane Rasberry and I am the president of Wikimedia New York City')
    expect(joined).toContain('Every year Wikimedia hosts')
    expect(joined).toContain('you know')
    expect(joined).not.toMatch(/Laine|Raspberry|with the media|Wicked/)
    expect(after[0]!.t_start_us).toBe(0)
    expect(after.at(-1)!.t_end_us).toBe(CUES.length * 2_000_000)
    for (const [i, l] of after.entries()) {
      expect(text(l).trim()).not.toBe('')
      expect(l.t_end_us).toBeGreaterThan(l.t_start_us)
      if (i) expect(l.t_start_us).toBeGreaterThanOrEqual(after[i - 1]!.t_end_us)
      for (const line of text(l).split('\n')) expect(line.length).toBeLessThanOrEqual(MAX_CHARS)
      const meta = readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])
      if (/Wikimedia|Rasberry/.test(text(l))) expect(meta?.provenance).toBe('interpolated_from_cue')
    }
    expect(applyTextCorrection(p, ids, c.id, null, undefined, { kind: 'manuscript' }, MAX_CHARS).changed).toBe(0)
  })

  describe('text only: a neighbouring cue anchors a fix', () => {
    function cues(texts: string[]) {
      const { p, c, ids, captions, text } = english()
      applyAddCaptionTrack(p, ids, texts.map((t, i) => ({ start_us: 30_000_000 + i * 2_000_000, end_us: 32_000_000 + i * 2_000_000, text: t })), c.width, c.height, null, c.id)
      const added = captions().slice(CUES.length)
      const timing = added.map(l => [l.id, l.t_start_us, l.t_end_us])
      const run = (script: string) => applyTextCorrection(p, ids, c.id, added.map(l => l.id), undefined, { kind: 'text_only', script }, MAX_CHARS)
      const after = () => captions().slice(CUES.length)
      return { run, texts: () => after().map(text), timing: () => after().map(l => [l.id, l.t_start_us, l.t_end_us]), before: timing }
    }
    it('fixes a run at the start of a cue anchored by the previous cue', () => {
      const t = cues(['Hi everyone, my name is', 'Laine Raspberry and I am here.'])
      const script = 'Hi everyone, my name is Lane Rasberry and I am here.'
      expect(t.run(script).changed).toBe(1)
      expect(t.texts()).toEqual(['Hi everyone, my name is', 'Lane Rasberry and I am here.'])
      expect(t.timing()).toEqual(t.before)
      expect(t.run(script).changed).toBe(0)
    })
    it('fixes a run at the end of a cue anchored by the next cue', () => {
      const t = cues(['Hi everyone, my name is Laine Raspberry', 'and I am the president.'])
      const script = 'Hi everyone, my name is Lane Rasberry, and I am the president.'
      expect(t.run(script).changed).toBe(1)
      expect(t.texts()).toEqual(['Hi everyone, my name is Lane Rasberry,', 'and I am the president.'])
      expect(t.timing()).toEqual(t.before)
      expect(t.run(script).changed).toBe(0)
    })
    it('abstains on a run that spans two cues, leaving both byte-identical', () => {
      const texts = ['Then we met Laine', 'Raspberry was there with us.']
      const t = cues(texts)
      expect(t.run('Then we met Lane Rasberry was there with us.').changed).toBe(0)
      expect(t.texts()).toEqual(texts)
      expect(t.timing()).toEqual(t.before)
    })
  })
})
