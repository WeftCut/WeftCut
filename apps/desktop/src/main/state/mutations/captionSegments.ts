// apps/desktop/src/main/state/mutations/captionSegments.ts
//
// Caption construction: a transcript segment becomes cues that already meet
// the style's caption limits (spec H1-D4 deferred it; the H1 bench showed
// agents breaking 40-odd cues by hand to satisfy the audit). Lines break at
// word boundaries, balanced; a segment too long for its lines or for the
// longest cue splits in time at word boundaries, timed from its words. A
// single word longer than a line stays whole — the audit reports it.
//
// Pure: positions are code units, the same count `check_composition` uses.

import type { StyleCaptionLimits } from '../../../shared/craft'

export interface CaptionLimits {
  max_chars: number
  max_lines: number
  min_cue_us: number
  max_cue_us: number
}

/** The style's limits (`captionLimits`, in seconds) as the builder takes them. */
export function buildLimits(l: StyleCaptionLimits): CaptionLimits {
  return { max_chars: l.max_chars, max_lines: l.max_lines, min_cue_us: Math.round(l.min_cue_s * 1e6), max_cue_us: Math.round(l.max_cue_s * 1e6) }
}

export interface TimedWord { text: string; t_start_us: number; t_end_us: number }
export interface TranscriptSegment { text: string; t_start_us: number; t_end_us: number; words: TimedWord[] }
export interface PlannedCue extends TranscriptSegment {
  /** `text` before its lines were broken. */
  raw: string
  /** The cue's word times were spread over its characters, not taken from
   *  the engine's words (they could not be found in the text, or there
   *  were none). */
  estimated: boolean
}

/** After the last word, a split cue stays up this long into the pause. */
const LINGER_US = 500_000
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}'
// A line may break before any atom: a run without spaces, or one CJK
// character with the punctuation that follows it.
const ATOM = new RegExp(`[${CJK}][^\\s${CJK}\\p{L}\\p{N}]*|[^\\s${CJK}]+`, 'gu')
const ENDS_CLAUSE = /[\p{Po}\p{Pe}\p{Pf}]$/u

interface Span { start: number; end: number }

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim()
const atomsOf = (text: string): Span[] => [...text.matchAll(ATOM)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }))

/** Lines the greedy fill needs: the fewest any break can manage. */
function lineCount(text: string, maxChars: number): number {
  const a = atomsOf(text)
  let lines = a.length ? 1 : 0, from = 0
  for (let j = 1; j < a.length; j++) if (a[j]!.end - a[from]!.start > maxChars) { lines++; from = j }
  return lines
}

/** `text` on the fewest lines of at most `maxChars`, the longest line as
 *  short as it can be, preferring breaks after punctuation. */
export function breakLines(text: string, maxChars: number): string {
  const t = normalize(text), a = atomsOf(t), n = a.length
  if (n < 2 || t.length <= maxChars) return t
  const k = lineCount(t, maxChars)
  const len = (i: number, j: number) => a[j - 1]!.end - a[i]!.start
  const soft = (i: number) => (ENDS_CLAUSE.test(t.slice(a[i - 1]!.start, a[i - 1]!.end)) ? 0 : 1)
  type Best = { max: number; soft: number; from: number }
  // A break inside a clause costs as much as six characters of imbalance.
  const score = (b: Best) => b.max + 6 * b.soft
  // best[m][j]: atoms [0, j) on m lines.
  const best: Array<Array<Best | null>> = [[{ max: 0, soft: 0, from: -1 }, ...Array<null>(n).fill(null)]]
  for (let m = 1; m <= k; m++) {
    const row: Array<Best | null> = Array<Best | null>(n + 1).fill(null)
    for (let j = m; j <= n; j++) {
      for (let i = m - 1; i < j; i++) {
        const prev = best[m - 1]![i]
        if (!prev) continue
        const cand = { max: Math.max(prev.max, len(i, j)), soft: prev.soft + (i > 0 ? soft(i) : 0), from: i }
        if (!row[j] || score(cand) < score(row[j]!)) row[j] = cand
      }
    }
    best.push(row)
  }
  const lines: string[] = []
  for (let m = k, j = n; m > 0; m--) {
    const i = best[m]![j]!.from
    lines.unshift(t.slice(a[i]!.start, a[j - 1]!.end))
    j = i
  }
  return lines.join('\n')
}

interface Located extends Span, TimedWord {}

/** Each word's place in the text, in order; null when a word is missing. */
function locate(text: string, words: TimedWord[], seg: TranscriptSegment): Located[] | null {
  const out: Located[] = []
  let cursor = 0, time = seg.t_start_us
  for (const w of words) {
    const needle = w.text.trim()
    const at = needle ? text.indexOf(needle, cursor) : -1
    if (at < 0) return null
    cursor = at + needle.length
    const start = Math.min(Math.max(w.t_start_us, time), seg.t_end_us)
    time = Math.min(Math.max(w.t_end_us, start), seg.t_end_us)
    out.push({ start: at, end: cursor, text: w.text, t_start_us: start, t_end_us: time })
  }
  return out
}

/** Words spread over the segment by character position. */
function interpolate(text: string, seg: TranscriptSegment): Located[] {
  const dur = seg.t_end_us - seg.t_start_us
  const at = (pos: number) => seg.t_start_us + Math.round((dur * pos) / text.length)
  return atomsOf(text).map((s) => ({ ...s, text: text.slice(s.start, s.end), t_start_us: at(s.start), t_end_us: at(s.end) }))
}

/** One transcript segment as cues within `limits`, in order, not overlapping,
 *  covering the segment's start and end. */
export function planCues(seg: TranscriptSegment, limits: CaptionLimits): PlannedCue[] {
  const whole = normalize(seg.text)
  const fits = (t: string) => lineCount(t, limits.max_chars) <= limits.max_lines
  // Lines the caller broke itself are kept when they are within the limits.
  const given = seg.text.trim().split(/\s*\n\s*/u)
  if (given.length > 1 && given.length <= limits.max_lines && given.every((l) => l.length <= limits.max_chars) && seg.t_end_us - seg.t_start_us <= limits.max_cue_us)
    return [{ ...seg, text: given.join('\n'), raw: whole, estimated: false }]
  if (!whole || (fits(whole) && seg.t_end_us - seg.t_start_us <= limits.max_cue_us))
    return [{ ...seg, text: whole ? breakLines(whole, limits.max_chars) : seg.text, raw: whole, estimated: false }]

  let words = seg.words.length > 1 ? locate(seg.text, seg.words, seg) : null
  const estimated = !words
  words ??= interpolate(seg.text, seg)
  const W = words.length
  if (W < 2) return [{ ...seg, text: breakLines(whole, limits.max_chars), raw: whole, estimated }]

  const capacity = limits.max_chars * limits.max_lines
  const cue = (i: number, j: number) => {
    const text = normalize(seg.text.slice(i === 0 ? 0 : words[i]!.start, j === W ? seg.text.length : words[j]!.start))
    const start = i === 0 ? seg.t_start_us : words[i]!.t_start_us
    const end = j === W ? seg.t_end_us : Math.max(start + 1, Math.min(words[j]!.t_start_us, words[j - 1]!.t_end_us + LINGER_US))
    return { text, start, end }
  }
  // Fewest cues first, then cues that end a clause, are not too short to
  // read, and fill their lines evenly.
  const best: Array<{ cost: number; from: number }> = [{ cost: 0, from: -1 }]
  for (let j = 1; j <= W; j++) {
    best[j] = { cost: Infinity, from: j - 1 }
    for (let i = j - 1; i >= 0; i--) {
      const c = cue(i, j), dur = c.end - c.start
      if (j - i > 1 && (c.text.length > capacity || dur > limits.max_cue_us)) break
      if (j - i > 1 && !fits(c.text)) continue
      const cost = best[i]!.cost + 1000
        + (dur < limits.min_cue_us ? 200 : 0)
        + (j < W && !ENDS_CLAUSE.test(c.text) ? 30 : 0)
        + 100 * (1 - Math.min(1, c.text.length / capacity)) ** 2
      if (cost < best[j]!.cost) best[j] = { cost, from: i }
    }
  }
  const bounds: number[] = []
  for (let j = W; j > 0; j = best[j]!.from) bounds.unshift(j)
  const out: PlannedCue[] = []
  for (let k = 0, i = 0; k < bounds.length; i = bounds[k++]!) {
    const j = bounds[k]!, c = cue(i, j)
    out.push({ text: breakLines(c.text, limits.max_chars), raw: c.text, t_start_us: c.start, t_end_us: c.end, estimated,
      words: words.slice(i, j).map(({ text, t_start_us, t_end_us }) => ({ text, t_start_us, t_end_us })) })
  }
  return out
}

const SENTENCE_END = /[.?!…。？！][\p{Pe}\p{Pf}"']*$/u
const CJK_EDGE = new RegExp(`[${CJK}]`, 'u')

/** Two cues' texts as one: a space between, unless either side is CJK. */
function join(a: string, b: string): string {
  return a + (CJK_EDGE.test(a.slice(-1)) || CJK_EDGE.test(b[0] ?? '') ? '' : ' ') + b
}

/** Cues of one transcript, in time order, with those too short to read
 *  settled. A short cue joins the neighbour it reads with (the next when the
 *  previous ends a sentence, else the previous) when the two nearly touch and
 *  still fit the limits. One that cannot join stays up into the pause before
 *  the next cue, never past its start; the last cue has nothing to bound it
 *  and is left alone. */
export function settleShortCues(cues: PlannedCue[], limits: CaptionLimits): PlannedCue[] {
  const out = [...cues]
  const short = (c: PlannedCue) => c.t_end_us - c.t_start_us < limits.min_cue_us
  const merged = (a: PlannedCue, b: PlannedCue): PlannedCue | null => {
    const text = join(a.raw, b.raw)
    if (b.t_start_us - a.t_end_us > LINGER_US || b.t_end_us - a.t_start_us > limits.max_cue_us || lineCount(text, limits.max_chars) > limits.max_lines) return null
    return { text: breakLines(text, limits.max_chars), raw: text, t_start_us: a.t_start_us, t_end_us: b.t_end_us, words: [...a.words, ...b.words], estimated: a.estimated || b.estimated }
  }
  for (let k = 0; k < out.length;) {
    const c = out[k]!
    if (!short(c)) { k++; continue }
    const prev = out[k - 1], next = out[k + 1]
    const order = prev && !SENTENCE_END.test(prev.raw) ? ['prev', 'next'] : ['next', 'prev']
    let done = false
    for (const side of order) {
      const m = side === 'prev' ? (prev ? merged(prev, c) : null) : (next ? merged(c, next) : null)
      if (!m) continue
      if (side === 'prev') { out.splice(k - 1, 2, m); k-- } else out.splice(k, 2, m)
      done = true
      break
    }
    if (!done) k++
  }
  for (let k = 0; k + 1 < out.length; k++) {
    const c = out[k]!
    if (short(c)) c.t_end_us = Math.max(c.t_end_us, Math.min(c.t_start_us + limits.min_cue_us, out[k + 1]!.t_start_us))
  }
  return out
}
