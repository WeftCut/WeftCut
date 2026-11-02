import type { Composition, Layer, Project, TextParams, Track } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { scopeComposition, locateLayer, cloneLayer } from './helpers'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { alignedShare, createTextCorrector, type CorrectedText, type CorrectionPiece } from '../../../shared/textCorrection'
import { CAPTION_TIMING_KEY, readCaptionTiming, type CaptionTiming, type CaptionWord, type TranscriptPayload } from '../../../shared/captionTiming'
import { applyAddCaptionTrack, type Cue } from './captions'
import type { TextCorrectionExpectation } from '../../../shared/textCorrectionRequest'
import { breakLines, settleShortCues, planCues, type CaptionLimits, type PlannedCue } from './captionSegments'

export function sourceSignature(layer: Layer): string {
  return JSON.stringify([layer.t_start_us, layer.t_end_us, layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio'
    ? [layer.params.media, layer.params.src_in_us, layer.params.src_out_us, [layer.params.time_map, layer.params.source_phase]] : layer.params.kind])
}

/** Transcript ingestion writes timing metadata in the SAME undo transaction as
 * the captions. The old subtitle import path remains valid without metadata.
 * With `limits` (the style's), each segment is built into cues that meet them
 * (`planCues`); without, segments land as transcribed. */
export function applyTranscripts(p: Project, ids: IdGen, transcripts: TranscriptPayload[], compositionId: string, sourceIds: string[] = [], style?: (t: TextParams) => TextParams, limits?: CaptionLimits): string {
  const c = scopeComposition(p, compositionId)
  if (!Array.isArray(transcripts) || transcripts.length > 1000) throw invalid('transcripts')
  const cues: Cue[] = []
  const grid = gridForLayerKind('Text', c.fps)
  for (const [n, t] of transcripts.entries()) {
    if (!t || !Array.isArray(t.segments) || !['exact', 'interpolated_from_cue', 'none'].includes(t.word_timing)) throw invalid('transcripts')
    const source = (t.source?.id ?? sourceIds[n]) ? locateLayer(p, (t.source?.id ?? sourceIds[n])!)?.layer : undefined
    if (t.source && (t.source.project_id !== p.project_id || t.source.composition_id !== c.id || !source || sourceSignature(source) !== t.source.signature)) throw new CommandFailure({ error: 'InvalidArgument', field: 'transcripts', detail: 'The transcribed clip has changed; transcribe it again before applying captions' })
    let planned: PlannedCue[] = []
    for (const s of t.segments) {
      if (!s || typeof s.text !== 'string' || !Number.isSafeInteger(s.t_start_us) || !Number.isSafeInteger(s.t_end_us) || s.t_start_us < 0 || s.t_end_us <= s.t_start_us || !Array.isArray(s.words)) throw invalid('transcripts')
      planned.push(...(limits ? planCues(s, limits) : [{ ...s, raw: s.text, estimated: false }]))
    }
    if (limits) planned = settleShortCues(planned.sort((a, b) => a.t_start_us - b.t_start_us), limits)
    for (const s of planned) {
      const start = snapOnGrid(s.t_start_us, grid), end = snapOnGrid(s.t_end_us, grid)
      if (end <= start) continue
      // Words spread over a split cue's characters are an estimate; a
      // transcript that came without words keeps none.
      const provenance = t.word_timing === 'none' ? 'none' : s.estimated ? 'interpolated_from_cue' : t.word_timing
      const timing: CaptionTiming = { version: 1, text: s.text, duration_us: end - start, provenance,
        words: provenance === 'none' && s.estimated ? [] : s.words.map(w => ({ text: w.text, start_us: Math.max(0, w.t_start_us - start), end_us: Math.max(0, w.t_end_us - start) })),
        ...(source ? { source: { id: source.id, signature: sourceSignature(source) } } : {}) }
      cues.push({ text: s.text, start_us: start, end_us: end, metadata: readCaptionTiming(timing) ? { [CAPTION_TIMING_KEY]: timing } : undefined })
    }
  }
  return applyAddCaptionTrack(p, ids, cues, c.width, c.height, null, c.id, style)
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
  referenceSentence?: number; breakAfter?: boolean; cue: number; estimated: boolean; substituted?: boolean
}

/** A cue's own line break stays where it was: the corrector spaces matched
 *  words as the script does, and the script's line breaks never enter a cue.
 *  `source[from, to)` is what `text` replaces; `separators` are the joins
 *  between cues in it, which are not the cue's. */
function keepBreaks(text: string, source: string, from: number, to: number, separators?: ReadonlySet<number>): string {
  if (text.includes('\n')) return text
  for (let k = source.indexOf('\n', from); k >= 0 && k < to; k = source.indexOf('\n', k + 1)) {
    if (!separators?.has(k)) return text.replace(/\s*$/u, '\n')
  }
  return text
}

const flat = (s: string) => s.replace(/\s+/gu, ' ').trim()
const EAST_ASIAN = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef'
// A line break between East Asian characters joins them without a space.
const EAST_ASIAN_BREAK = new RegExp(`(?<=[${EAST_ASIAN}])\\s*\\n\\s*(?=[${EAST_ASIAN}])`, 'gu')

/** A cue's text after correction. Only spacing changed: the cue as it was,
 *  byte for byte. Changed: re-wrapped at the style's line length, or with
 *  its own line breaks where they were when no length is known. */
function settleText(before: string, after: string, maxChars?: number): string {
  if (flat(after) === flat(before)) return before
  return maxChars && maxChars > 0 ? breakLines(after.replace(EAST_ASIAN_BREAK, ''), maxChars) : after
}

/** `source[from, to)` with the corrector's pieces that start in it applied.
 *  A piece running past `to` applies only when what it covers there is
 *  punctuation or space: words never move between cues. */
function applyPieces(source: string, pieces: CorrectionPiece[], from: number, to: number): string {
  let text = source.slice(from, to)
  for (const piece of [...pieces].reverse()) {
    if (piece.start < from || piece.start >= to) continue
    // The end may include the separator newline; only punctuation/whitespace
    // can be clipped from it without moving semantic content across cues.
    if (piece.end > to && /[\p{L}\p{N}]/u.test(source.slice(to, piece.end))) continue
    const end = Math.min(piece.end, to)
    const replacement = keepBreaks(piece.end > to ? piece.text.trimEnd() : piece.text, source, piece.start, end)
    text = text.slice(0, piece.start - from) + replacement + text.slice(end - from)
  }
  return text
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
      previous.estimated ||= hits.some(w => w.estimated) || !!piece.substituted
      previous.substituted ||= piece.substituted
    } else out.push({ text: piece.text, start_us: startUs, end_us: last.end_us,
      // A substituted run spans the cue words it replaced; its words are not
      // the engine's.
      cue: first.cue, estimated: hits.some(w => w.estimated) || startUs !== first.start_us || !!piece.substituted,
      referenceSentence: piece.referenceSentence, breakAfter: piece.breakAfter, substituted: piece.substituted })
  }
  if (out.length && result.pieces[0]!.start > 0) out[0]!.text = result.text.slice(0, result.pieces[0]!.start) + out[0]!.text
  return out
}

function resegment(p: Project, c: Composition, track: Track, group: Layer[], ids: IdGen, correct: ReturnType<typeof createTextCorrector>, maxChars?: number): number {
  const spans: TextSpan[] = [], originals: string[] = [], separators = new Set<number>()
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
    spans.push(...ws); separators.add(text.length + l.params.content.length); text += l.params.content + '\n'
  }
  const result = correct(text.trimEnd())
  result.pieces = result.pieces.map(piece => {
    const local = independent.get(piece.start)
    // Only a piece over the same words: a run substituted on one side alone
    // would drop or repeat the words the other side covers.
    const own = local?.referenceSentence !== undefined && local.tokens === piece.tokens && (piece.referenceSentence === undefined || piece.breakAfter && local.breakAfter)
      ? { ...local, end: piece.end } : piece
    return { ...own, text: keepBreaks(own.text, text, own.start, own.end, separators) }
  })
  const fallback = () => correctIndividually(group, correct, maxChars)
  const words = timedPieces(result, spans)
  if (!words?.length) return fallback()
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
    if (end <= start || start < first.t_start_us || end > last.t_end_us || (replacements.length && start < replacements[replacements.length - 1]!.t_end_us)) return fallback()
    const built = ws.map(w => w.text).join('').trim()
    if (!built) return fallback()
    const content = settleText(originals[i] ?? '', built, maxChars)
    const template = group[a.cue]!
    const replacement = cloneLayer(template)
    replacement.id = group[i]?.id ?? ids()
    replacement.t_start_us = start; replacement.t_end_us = end
    if (replacement.params.kind === 'Text') replacement.params.content = content
    const meta: CaptionTiming = { version: 1, text: content, duration_us: end - start, provenance: ws.some(w => w.estimated) ? 'interpolated_from_cue' : 'exact',
      words: ws.flatMap(w => timedWords(w, start)) }
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

/** A timed piece as the cue's words, relative to `start`. A substituted run's
 *  words share its time by length, so each is found in the text again. */
function timedWords(w: TimedPiece, start: number): CaptionWord[] {
  const text = w.text.trim(), parts = w.substituted ? text.split(/\s+/u) : [text]
  if (parts.length < 2) return [{ text, start_us: Math.max(0, w.start_us - start), end_us: Math.max(0, w.end_us - start) }]
  const total = parts.reduce((n, s) => n + s.length, 0), duration = w.end_us - w.start_us
  let at = 0
  return parts.map(s => {
    const from = w.start_us + Math.round(duration * at / total)
    at += s.length
    return { text: s, start_us: Math.max(0, from - start), end_us: Math.max(0, w.start_us + Math.round(duration * at / total) - start) }
  })
}

function correctIndividually(layers: Layer[], correct: ReturnType<typeof createTextCorrector>, maxChars?: number): number {
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
    let text = applyPieces(combined, result.pieces, range.start, range.end)
    // A repeated take may be outside the group alignment's best local path.
    // Reacquire each cue independently as well, retaining the contextual fixes
    // above for words that straddled the old ASR cue boundary. Substituted
    // runs are the group's alone: the cue without its neighbours has less
    // context, and must neither redo nor add one.
    const own = correct(text).pieces.filter(piece => !piece.substituted)
    text = settleText(l.params.content, applyPieces(text, own, 0, text.length), maxChars)
    if (text !== l.params.content) {
      l.params.content = text
      // Stale text mapping is intentionally not relabelled as engine timing.
      delete l.metadata[CAPTION_TIMING_KEY]
      changed++
    }
  }
  return changed
}

/** The least share of caption words that must align to an agent's script
 *  (`correct_caption_text { script }`) before anything is corrected: below it
 *  the script is not the transcript of these captions (R1b: spelling notes
 *  passed as the script merged cues and added stray text). */
export const CORRECTION_MIN_MATCH = 0.5
/** Most `before` / `after` pairs an answer lists; `changed` counts them all. */
export const CORRECTION_CHANGES_LISTED = 20

/** How a correction run reads its manuscript and what it may change. The Text
 *  correction dialog corrects against the project's manuscript and may
 *  re-segment by word timing; an agent passes its script and changes text
 *  only — cue boundaries and timing stay exactly as they are. */
export type CorrectionMode =
  | { kind: 'manuscript' }
  | { kind: 'text_only'; script: string }

export interface CorrectionResult {
  changed: number
  match_ratio: number
  changes: Array<{ layer_id: string; before: string; after: string }>
}

/** `maxChars` is the caption style's line length: a cue whose text changed is
 *  re-wrapped to it. Without it, a changed cue keeps its line breaks where
 *  they were. A cue whose text did not change is left as it was. */
export function applyTextCorrection(p: Project, ids: IdGen, compositionId: string, layerIds: string[] | null, expected?: TextCorrectionExpectation, mode: CorrectionMode = { kind: 'manuscript' }, maxChars?: number): CorrectionResult {
  const c = scopeComposition(p, compositionId)
  const script = mode.kind === 'text_only' ? mode.script : p.settings.correction_script ?? ''
  if (!script.trim()) throw invalid(mode.kind === 'text_only' ? 'script' : 'correction_script')
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
  const before = new Map(targets.map(({ l }) => [l.id, l.params.kind === 'Text' ? l.params.content : '']))
  const matchRatio = alignedShare(correct, targets.map(({ l }) => before.get(l.id)!).join('\n'))
  if (mode.kind === 'text_only') {
    if (matchRatio < CORRECTION_MIN_MATCH) throw new CommandFailure({ error: 'InvalidArgument', field: 'script', detail: `Only ${Math.round(matchRatio * 100)}% of the caption words align to the script (at least ${CORRECTION_MIN_MATCH * 100}% needed). Pass the full verbatim transcript of what is said in these captions, not notes or a glossary; nothing was changed` })
    // Text only: each cue is corrected in place, never split, merged or retimed.
    // A track's targets are aligned together, in time order, so a neighbouring
    // cue's words can anchor a fix; each cue still takes only its own edits.
    let changed = 0
    for (const track of c.tracks) {
      const group = targets.filter(x => x.t === track).map(x => x.l).sort((a, b) => a.t_start_us - b.t_start_us)
      if (group.length) changed += correctIndividually(group, correct, maxChars)
    }
    return { changed, match_ratio: roundRatio(matchRatio), changes: listChanges(c, before) }
  }
  let changed = 0
  for (const track of c.tracks) {
    const original = [...track.layers]
    for (let i = 0; i < original.length;) {
      const first = original[i++]!
      if (!selected.has(first.id)) continue
      if (!canResegment(c, first)) {
        changed += correctIndividually([first], correct, maxChars); continue
      }
      const group = [first], style = styleKey(first), source = JSON.stringify(timingFor(p, first)?.source)
      while (i < original.length) {
        const next = original[i]!, last = group[group.length - 1]!, nt = timingFor(p, next)
        if (!selected.has(next.id) || !canResegment(c, next) || styleKey(next) !== style || JSON.stringify(nt?.source) !== source || next.t_start_us < last.t_end_us) break
        group.push(next); i++
      }
      changed += resegment(p, c, track, group, ids, correct, maxChars)
    }
  }
  return { changed, match_ratio: roundRatio(matchRatio), changes: listChanges(c, before) }
}

const roundRatio = (r: number): number => Math.round(r * 100) / 100

/** The captions whose text a run changed, in track then time order, capped at
 *  `CORRECTION_CHANGES_LISTED`. A re-segmented cue that kept its id is listed
 *  by it; one that went away is not (`changed` still counts it). */
function listChanges(c: Composition, before: ReadonlyMap<string, string>): CorrectionResult['changes'] {
  const out: CorrectionResult['changes'] = []
  for (const t of c.tracks) for (const l of t.layers) {
    const was = before.get(l.id)
    if (was === undefined || l.params.kind !== 'Text' || l.params.content === was) continue
    if (out.length < CORRECTION_CHANGES_LISTED) out.push({ layer_id: l.id, before: was, after: l.params.content })
  }
  return out
}
