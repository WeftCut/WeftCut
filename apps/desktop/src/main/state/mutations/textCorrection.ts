import type { Composition, Layer, Project, Track } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { scopeComposition, locateLayer, cloneLayer } from './helpers'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { createTextCorrector, type CorrectedText } from '../../../shared/textCorrection'
import { CAPTION_TIMING_KEY, readCaptionTiming, type CaptionTiming, type CaptionWord, type TranscriptPayload } from '../../../shared/captionTiming'
import { applyAddCaptionTrack, type Cue } from './captions'
import type { TextCorrectionExpectation } from '../../../shared/textCorrectionRequest'

export function sourceSignature(layer: Layer): string {
  return JSON.stringify([layer.t_start_us, layer.t_end_us, layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio'
    ? [layer.params.media, layer.params.src_in_us, layer.params.src_out_us, layer.params.kind === 'VideoClip' ? layer.params.speed : 1] : layer.params.kind])
}

/** Transcript ingestion writes timing metadata in the SAME undo transaction as
 * the captions. The old subtitle import path remains valid without metadata. */
export function applyTranscripts(p: Project, ids: IdGen, transcripts: TranscriptPayload[], compositionId: string, sourceIds: string[] = []): string {
  const c = scopeComposition(p, compositionId)
  if (!Array.isArray(transcripts) || transcripts.length > 1000) throw invalid('transcripts')
  const cues: Cue[] = []
  for (const [n, t] of transcripts.entries()) {
    if (!t || !Array.isArray(t.segments) || !['exact', 'interpolated_from_cue', 'none'].includes(t.word_timing)) throw invalid('transcripts')
    const source = (t.source?.id ?? sourceIds[n]) ? locateLayer(p, (t.source?.id ?? sourceIds[n])!)?.layer : undefined
    if (t.source && (t.source.project_id !== p.project_id || t.source.composition_id !== c.id || !source || sourceSignature(source) !== t.source.signature)) throw new CommandFailure({ error: 'InvalidArgument', field: 'transcripts', detail: 'The transcribed clip has changed; transcribe it again before applying captions' })
    for (const s of t.segments) {
      if (!s || typeof s.text !== 'string' || !Number.isSafeInteger(s.t_start_us) || !Number.isSafeInteger(s.t_end_us) || s.t_start_us < 0 || s.t_end_us <= s.t_start_us || !Array.isArray(s.words)) throw invalid('transcripts')
      const grid = gridForLayerKind('Text', c.fps)
      const start = snapOnGrid(s.t_start_us, grid), end = snapOnGrid(s.t_end_us, grid)
      if (end <= start) continue
      const timing: CaptionTiming = { version: 1, text: s.text, duration_us: end - start, provenance: t.word_timing,
        words: s.words.map(w => ({ text: w.text, start_us: Math.max(0, w.t_start_us - start), end_us: Math.max(0, w.t_end_us - start) })),
        ...(source ? { source: { id: source.id, signature: sourceSignature(source) } } : {}) }
      cues.push({ text: s.text, start_us: start, end_us: end, metadata: readCaptionTiming(timing) ? { [CAPTION_TIMING_KEY]: timing } : undefined })
    }
  }
  return applyAddCaptionTrack(p, ids, cues, c.width, c.height, null, c.id)
}

function invalid(field: string): CommandFailure { return new CommandFailure({ error: 'InvalidArgument', field, detail: `Invalid ${field}` }) }
function animated(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if ('mode' in value && (value.mode === 'Keyframed' || value.mode === 'Path')) return true
  return Object.values(value).some(animated)
}
function styleKey(l: Layer): string {
  if (l.params.kind !== 'Text') return ''
  const { content: _, ...style } = l.params
  const { [CAPTION_TIMING_KEY]: __, ...metadata } = l.metadata
  return JSON.stringify([style, l.effects, metadata, l.label, l.enabled])
}
function timingFor(p: Project, l: Layer): CaptionTiming | null {
  const m = readCaptionTiming(l.metadata[CAPTION_TIMING_KEY])
  if (!m || l.params.kind !== 'Text' || m.text !== l.params.content || m.duration_us !== l.t_end_us - l.t_start_us || m.provenance === 'none' || !m.words.length || m.words.some(w => w.end_us <= w.start_us || w.start_us >= m.duration_us)) return null
  if (m.source) {
    const source = locateLayer(p, m.source.id)?.layer
    if (!source || sourceSignature(source) !== m.source.signature) return null
  }
  return m
}

function canResegment(c: Composition, l: Layer): boolean {
  return l.params.kind === 'Text' && !l.params.intro && !l.params.outro && !animated(l.params) && !animated(l.effects) &&
    !c.links.some(x => x.members.includes(l.id)) && !c.transitions.some(x => x.from_layer === l.id || x.to_layer === l.id) && !c.markers.some(x => x.anchor?.layer === l.id)
}

interface TextSpan { start: number; end: number; start_us: number; end_us: number; cue: number; estimated: boolean }
function wordSpans(text: string, words: CaptionWord[], offset: number, startUs: number, cue: number, estimated: boolean): TextSpan[] | null {
  let cursor = 0
  const result: TextSpan[] = []
  for (const w of words) {
    const at = text.indexOf(w.text.trim(), cursor)
    if (at < 0 || /[\p{L}\p{N}]/u.test(text.slice(cursor, at))) return null
    cursor = at + w.text.trim().length
    result.push({ start: offset + at, end: offset + cursor, start_us: startUs + w.start_us, end_us: startUs + w.end_us, cue, estimated })
  }
  return /[\p{L}\p{N}]/u.test(text.slice(cursor)) ? null : result
}

interface TimedPiece extends CaptionWord {
  referenceSentence?: number; breakAfter?: boolean; cue: number; estimated: boolean
}

/** Keep engine word times where possible. A manuscript break inside an engine
 * word uses its character coverage to estimate a cut, recorded as interpolated. */
function timedPieces(result: CorrectedText, spans: TextSpan[]): TimedPiece[] | null {
  const out: TimedPiece[] = []
  let cursor = 0
  for (const piece of result.pieces) {
    while (cursor < spans.length && spans[cursor]!.end <= piece.start) cursor++
    let end = cursor
    while (end < spans.length && spans[end]!.start < piece.end) end++
    const hits = spans.slice(cursor, end)
    if (!hits.length) return null
    const first = hits[0]!, last = hits[hits.length - 1]!
    const previous = out[out.length - 1]
    const separates = previous?.breakAfter || (previous?.referenceSentence !== undefined && piece.referenceSentence !== undefined && previous.referenceSentence !== piece.referenceSentence)
    let startUs = first.start_us
    if (previous && first.start_us < previous.end_us && separates) {
      const at = Math.max(first.start, Math.min(first.end, piece.start))
      startUs = Math.round(first.start_us + (first.end_us - first.start_us) * (at - first.start) / (first.end - first.start))
      previous.end_us = startUs; previous.estimated = true
    }
    if (previous && first.start_us < previous.end_us && !separates) {
      previous.text += piece.text; previous.end_us = Math.max(previous.end_us, last.end_us)
      previous.breakAfter = piece.breakAfter
      previous.referenceSentence = piece.referenceSentence ?? previous.referenceSentence
      previous.estimated ||= hits.some(w => w.estimated)
    } else out.push({ text: piece.text, start_us: startUs, end_us: last.end_us,
      cue: first.cue, estimated: hits.some(w => w.estimated) || startUs !== first.start_us,
      referenceSentence: piece.referenceSentence, breakAfter: piece.breakAfter })
  }
  if (out.length && result.pieces[0]!.start > 0) out[0]!.text = result.text.slice(0, result.pieces[0]!.start) + out[0]!.text
  return out
}

function resegment(p: Project, c: Composition, track: Track, group: Layer[], ids: IdGen, correct: ReturnType<typeof createTextCorrector>): number {
  const spans: TextSpan[] = [], originals: string[] = []
  const independent = new Map<number, CorrectedText['pieces'][number]>()
  let text = ''
  for (const [cue, l] of group.entries()) {
    if (l.params.kind !== 'Text') return 0
    originals.push(l.params.content)
    // Retakes may lie outside the best alignment of a whole group. Reacquire
    // each cue, retaining group context for words straddling old cue boundaries.
    for (const piece of correct(l.params.content).pieces) independent.set(text.length + piece.start,
      { ...piece, start: text.length + piece.start, end: text.length + piece.end })
    const m = timingFor(p, l)
    let ws = m && wordSpans(l.params.content, m.words, text.length, l.t_start_us, cue, m.provenance !== 'exact')
    if (!ws) {
      const chars = [...l.params.content], duration = l.t_end_us - l.t_start_us
      let offset = text.length
      ws = chars.map((ch, i) => {
        const span = { start: offset, end: offset + ch.length,
          start_us: l.t_start_us + Math.round(duration * i / chars.length),
          end_us: l.t_start_us + Math.round(duration * (i + 1) / chars.length), cue, estimated: true }
        offset += ch.length; return span
      })
    }
    spans.push(...ws); text += l.params.content + '\n'
  }
  const result = correct(text.trimEnd())
  result.pieces = result.pieces.map(piece => {
    const local = independent.get(piece.start)
    return local?.referenceSentence !== undefined && (piece.referenceSentence === undefined || piece.breakAfter && local.breakAfter)
      ? { ...local, end: piece.end } : piece
  })
  const words = timedPieces(result, spans)
  if (!words?.length) return correctIndividually(group, correct)
  const chunks: TimedPiece[][] = []
  let chunk: TimedPiece[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!, next = words[i + 1]
    chunk.push(word)
    const matched = word.referenceSentence !== undefined && next?.referenceSentence !== undefined
    if (!next || word.breakAfter || (matched ? word.referenceSentence !== next.referenceSentence : word.cue !== next.cue)) {
      chunks.push(chunk); chunk = []
    }
  }
  const first = group[0]!, last = group[group.length - 1]!, grid = gridForLayerKind('Text', c.fps)
  const replacements: Layer[] = []
  for (let i = 0; i < chunks.length; i++) {
    const ws = chunks[i]!, a = ws[0]!, b = ws[ws.length - 1]!
    const start = i === 0 ? first.t_start_us : snapOnGrid(a.start_us, grid)
    const end = i === chunks.length - 1 ? last.t_end_us : snapOnGrid(Math.min(b.end_us, chunks[i + 1]![0]!.start_us), grid)
    if (end <= start || start < first.t_start_us || end > last.t_end_us || (replacements.length && start < replacements[replacements.length - 1]!.t_end_us)) return correctIndividually(group, correct)
    const content = ws.map(w => w.text).join('').trim()
    if (!content) return correctIndividually(group, correct)
    const template = group[a.cue]!
    const replacement = cloneLayer(template)
    replacement.id = group[i]?.id ?? ids()
    replacement.t_start_us = start; replacement.t_end_us = end
    if (replacement.params.kind === 'Text') replacement.params.content = content
    const meta: CaptionTiming = { version: 1, text: content, duration_us: end - start, provenance: ws.some(w => w.estimated) ? 'interpolated_from_cue' : 'exact',
      words: ws.map(w => ({ text: w.text.trim(), start_us: Math.max(0, w.start_us - start), end_us: Math.max(0, w.end_us - start) })) }
    // Groups only combine timing from the same source; keep its invalidation guard.
    const source = timingFor(p, first)?.source
    if (source) meta.source = source
    replacement.metadata[CAPTION_TIMING_KEY] = meta
    replacements.push(replacement)
  }
  if (replacements.length === group.length && replacements.every((l, i) => l.t_start_us === group[i]!.t_start_us && l.t_end_us === group[i]!.t_end_us && l.params.kind === 'Text' && l.params.content === originals[i])) return 0
  const at = track.layers.findIndex(l => l.id === first.id)
  track.layers.splice(at, group.length, ...replacements)
  return group.length
}

function correctIndividually(layers: Layer[], correct: ReturnType<typeof createTextCorrector>): number {
  // Matching may cross old cue boundaries even when the timestamps cannot.
  // Apply only edits wholly owned by one cue; never move words between cues.
  let combined = ''
  const ranges = layers.map(l => {
    const text = l.params.kind === 'Text' ? l.params.content : ''
    const range = { start: combined.length, end: combined.length + text.length, text }
    combined += text + '\n'
    return range
  })
  const result = correct(combined.trimEnd())
  let changed = 0
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!, range = ranges[i]!
    if (l.params.kind !== 'Text') continue
    let text = range.text
    for (const piece of [...result.pieces].reverse()) {
      if (piece.start < range.start || piece.start >= range.end) continue
      // The end may include the separator newline; only punctuation/whitespace
      // can be clipped from it without moving semantic content across cues.
      if (piece.end > range.end && /[\p{L}\p{N}]/u.test(combined.slice(range.end, piece.end))) continue
      const replacement = piece.end > range.end ? piece.text.trimEnd() : piece.text
      text = text.slice(0, piece.start - range.start) + replacement + text.slice(Math.min(piece.end, range.end) - range.start)
    }
    // A repeated take may be outside the group alignment's best local path.
    // Reacquire each cue independently as well, retaining the contextual fixes
    // above for words that straddled the old ASR cue boundary.
    text = correct(text).text
    if (text !== l.params.content) {
      l.params.content = text
      // Stale text mapping is intentionally not relabelled as engine timing.
      delete l.metadata[CAPTION_TIMING_KEY]
      changed++
    }
  }
  return changed
}

export function applyTextCorrection(p: Project, ids: IdGen, compositionId: string, layerIds: string[] | null, expected?: TextCorrectionExpectation): { changed: number } {
  const c = scopeComposition(p, compositionId), script = p.settings.correction_script ?? ''
  if (!script.trim()) throw invalid('correction_script')
  if (layerIds !== null && (!Array.isArray(layerIds) || !layerIds.length || layerIds.some(id => typeof id !== 'string'))) throw invalid('layer_ids')
  const wanted = layerIds === null ? null : new Set(layerIds)
  const targets = c.tracks.flatMap(t => t.role === 'Caption' ? t.layers.filter(l => l.params.kind === 'Text' && (!wanted || wanted.has(l.id))).map(l => ({ t, l })) : [])
  if (wanted && targets.length !== wanted.size) throw invalid('layer_ids')
  // UI captures these before awaiting queued manuscript saves. Refuse stale
  // results before any mutation, including a changed scope for "all captions".
  if (expected !== undefined) {
    if (!expected || !Array.isArray(expected.captions)) throw invalid('expected')
    const snapshot = new Map(expected.captions.map(l => [l.id, l]))
    if (script !== expected.script || snapshot.size !== targets.length || expected.captions.length !== targets.length || targets.some(({ l }) => {
      const old = snapshot.get(l.id)
      return !old || l.params.kind !== 'Text' || old.text !== l.params.content || old.t_start_us !== l.t_start_us || old.t_end_us !== l.t_end_us
    })) throw new CommandFailure({ error: 'InvalidArgument', field: 'expected', detail: 'The captions or reference text have changed; apply correction again' })
  }
  // Refuse whole if any target is locked: the advertised count stays truthful.
  if (targets.some(({ t, l }) => t.locked || l.locked)) throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: 'Unlock the selected captions before correcting text' })
  const selected = new Set(targets.map(x => x.l.id)), correct = createTextCorrector(script)
  let changed = 0
  for (const track of c.tracks) {
    const original = [...track.layers]
    for (let i = 0; i < original.length;) {
      const first = original[i++]!
      if (!selected.has(first.id)) continue
      if (!canResegment(c, first)) {
        changed += correctIndividually([first], correct); continue
      }
      const group = [first], style = styleKey(first), source = JSON.stringify(timingFor(p, first)?.source)
      while (i < original.length) {
        const next = original[i]!, last = group[group.length - 1]!, nt = timingFor(p, next)
        if (!selected.has(next.id) || !canResegment(c, next) || styleKey(next) !== style || JSON.stringify(nt?.source) !== source || next.t_start_us < last.t_end_us) break
        group.push(next); i++
      }
      changed += resegment(p, c, track, group, ids, correct)
    }
  }
  return { changed }
}
