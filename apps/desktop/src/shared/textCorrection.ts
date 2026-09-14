import { pinyin } from 'pinyin-pro'
import { CORRECTION_SCRIPT_MAX } from './textCorrectionRequest'

export interface CorrectionPiece {
  start: number; end: number; text: string
  /** Matched manuscript sentence, independent of the ASR's punctuation. */
  referenceSentence?: number
  breakAfter?: boolean
}
export interface CorrectedText { text: string; pieces: CorrectionPiece[] }
interface Token { start: number; end: number; raw: string; key: string; sound: string; protected: boolean }

const HAN = /^\p{Script=Han}$/u
const NUM = /^[\d０-９零〇一二两三四五六七八九十百千万亿点.％%]+$/u
const NEGATIVE = new Set(['不', '没', '无', '未', '非', '别', '勿', '莫', '否', 'not', 'no', 'never', 'without'])
const INITIAL_CONFUSIONS = [['z', 'zh'], ['c', 'ch'], ['s', 'sh'], ['ch', 'sh'], ['l', 'n'], ['f', 'h']]
const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function numberKey(raw: string): string {
  const s = raw.normalize('NFKC')
  if (/^\d+(?:\.\d+)?%?$/.test(s)) return `#${s.replace(/^0+(?=\d)/, '')}`
  if (/^[零〇一二两三四五六七八九]+$/.test(s)) return `#${[...s].map(c => digits[c]).join('').replace(/^0+(?=\d)/, '')}`
  // Colloquial trailing digits (一百二 / 一千二) have ambiguous place value.
  // Only expand explicit, descending units; uncertainty keeps the raw spelling.
  if (/^(?:[一二两三四五六七八九]千)?(?:[零〇]?[一二两三四五六七八九]百)?(?:[零〇]?[一二两三四五六七八九]?十)?(?:[零〇]?[一二两三四五六七八九])?$/.test(s) && !/[百千][一二两三四五六七八九]$/.test(s)) {
    let sum = 0, n = 0
    for (const c of s) {
      if (c in digits) n = digits[c]!
      else { sum += (n || 1) * ({ 十: 10, 百: 100, 千: 1000 }[c] ?? 0); n = 0 }
    }
    return `#${sum + n}`
  }
  return `#${s}`
}

function tokenize(text: string): Token[] {
  // Offsets always address the original UTF-16 string, even after normalization.
  const tokens: Token[] = []
  const re = /百分之[零〇一二两三四五六七八九十百千万亿点\d]+|[\d０-９]+(?:[.．][\d０-９]+)?[%％]?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二三四五六七八九]+)?|[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)*|[\p{L}\p{N}]/gu
  for (const m of text.matchAll(re)) {
    const raw = m[0], numeric = NUM.test(raw) || raw.startsWith('百分之')
    const key = numeric ? (raw.startsWith('百分之') ? `${numberKey(raw.slice(3))}%` : numberKey(raw)) : raw.normalize('NFKC').toLowerCase()
    tokens.push({ start: m.index, end: m.index + raw.length, raw, key,
      sound: HAN.test(raw) ? pinyin(raw, { toneType: 'none', type: 'array' }).join('') : key,
      protected: numeric || NEGATIVE.has(key) })
  }
  return tokens
}

function equivalent(a: Token, b: Token): boolean { return a.key === b.key }
function phonetic(a: Token, b: Token): boolean {
  return !a.protected && !b.protected && HAN.test(a.raw) && HAN.test(b.raw) && a.sound === b.sound
}

/** Weaker evidence than a homophone: never sufficient without exact flanks.
 * A Chinese numeral can be an ASR spelling of a name/word, but a numeric
 * manuscript token is never a target of this fallback. */
function confusable(a: Token, b: Token): boolean {
  if (b.protected || !HAN.test(a.raw) || !HAN.test(b.raw)) return false
  if (a.protected) return NUM.test(a.raw) && a.sound === b.sound
  const x = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw]?)(.+)$/.exec(a.sound)
  const y = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw]?)(.+)$/.exec(b.sound)
  if (!x || !y || x[2] !== y[2]) return false
  return INITIAL_CONFUSIONS.some(pair => pair.includes(x[1]!) && pair.includes(y[1]!))
}

function numericContext(tokens: Token[], i: number): boolean {
  // Keep quantities, ordinals and values intact even when a lexical reference
  // happens to sound like the number (一元 / 衣元, 四号 / 是号).
  const before = tokens[i - 1], after = tokens[i + 1]
  return !!(before && (NUM.test(before.raw) || /[第初]/u.test(before.raw)) ||
    after && (NUM.test(after.raw) || /^(?:[年月日天时分秒元块角毛折成个位名人只条件台套本张次遍岁号章节页米厘毫公克斤吨升度倍万亿]|percent|dollars?)$/iu.test(after.raw)))
}

interface Alignment { score: number; pairs: Map<number, number> }
/** Local sequence alignment: neither side is obliged to consume the other.
 * Gaps preserve omissions/additions instead of shifting the remainder. */
function align(a: Token[], b: Token[], offset: number): Alignment {
  const stride = b.length + 1, trace = new Uint8Array((a.length + 1) * stride)
  let prev = new Float32Array(stride), best = 0, bi = 0, bj = 0
  for (let i = 1; i <= a.length; i++) {
    const row = new Float32Array(stride)
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1]!, y = b[j - 1]!
      const diag = prev[j - 1]! + (equivalent(x, y) ? 3 : phonetic(x, y) ? 1.5 : confusable(x, y) ? -0.5 : -3)
      const up = prev[j]! - 1.2, left = row[j - 1]! - 1.2
      const v = Math.max(0, diag, up, left)
      row[j] = v
      trace[i * stride + j] = v === 0 ? 0 : v === diag ? 1 : v === up ? 2 : 3
      if (v > best) { best = v; bi = i; bj = j }
    }
    prev = row
  }
  const pairs = new Map<number, number>()
  while (bi > 0 && bj > 0) {
    const d = trace[bi * stride + bj]
    if (!d) break
    if (d === 1) { pairs.set(bi - 1, bj - 1 + offset); bi--; bj-- }
    else if (d === 2) bi--
    else bj--
  }
  return { score: best, pairs }
}

/** A prepared manuscript is reused across cues/runs on one track. No audio or
 * provider is called. Repeated candidates that imply different edits abstain. */
export function createTextCorrector(script: string): (text: string) => CorrectedText {
  if (script.length > CORRECTION_SCRIPT_MAX) throw new Error('Reference text is too long')
  const ref = tokenize(script)
  const referenceBreaks = ref.map((t, i) => i === ref.length - 1 || /[\r\n。！？.!?]/u.test(script.slice(t.end, ref[i + 1]?.start ?? script.length)))
  let sentence = 0
  const referenceSentences = ref.map((_, i) => { const id = sentence; if (referenceBreaks[i]) sentence++; return id })
  const index = new Map<string, number[]>()
  const contextSpellings = new Map<string, Set<string>>()
  const flankSpellings = new Map<string, Set<string>>()
  const contextKey = (i: number) => ref.slice(Math.max(0, i - 2), i + 3).map(t => t.sound).join('|')
  const flankKey = (i: number) => [-2, -1, 1, 2].map(d => ref[i + d]?.key ?? '').join('|')
  for (let i = 0; i < ref.length; i++) {
    const key = contextKey(i), spellings = contextSpellings.get(key) ?? new Set<string>()
    spellings.add(ref.slice(Math.max(0, i - 2), i + 3).map(t => t.key).join('|'))
    contextSpellings.set(key, spellings)
    const flank = flankKey(i), alternatives = flankSpellings.get(flank) ?? new Set<string>()
    alternatives.add(ref[i]!.key)
    flankSpellings.set(flank, alternatives)
  }
  for (let i = 0; i + 1 < ref.length; i++) {
    const key = `${ref[i]!.sound}|${ref[i + 1]!.sound}`
    const entries = index.get(key) ?? []
    // Common phrases carry no useful location evidence; don't scan unbounded lists.
    if (entries.length < 256) entries.push(i)
    index.set(key, entries)
  }
  const correct = (text: string): CorrectedText => {
    // Existing sentence punctuation gives independent recovery points after
    // whole omitted sections and retakes. Newlines alone are NOT boundaries:
    // they may be the ASR's arbitrary cue split in the middle of a word.
    const sentences = [...text.matchAll(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$|[。！？!?]+/gu)]
    if (sentences.length > 1) {
      const parts = sentences.map(s => ({ offset: s.index, result: correct(s[0]) }))
      return { text: parts.map(p => p.result.text).join(''), pieces: parts.flatMap(p => p.result.pieces.map(x => ({ ...x, start: x.start + p.offset, end: x.end + p.offset }))) }
    }
    const all = tokenize(text)
    const pieces: CorrectionPiece[] = []
    for (let base = 0; base < all.length; base += 240) {
      const tokens = all.slice(base, base + 240)
      const votes = new Map<number, number>()
      for (let i = 0; i + 1 < tokens.length; i++) {
        const hits = index.get(`${tokens[i]!.sound}|${tokens[i + 1]!.sound}`) ?? []
        if (hits.length >= 256) continue
        for (const j of hits) {
          const bucket = Math.floor((j - i) / 24)
          votes.set(bucket, (votes.get(bucket) ?? 0) + 1)
        }
      }
      const starts = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 6).map(([k]) => Math.max(0, k * 24 - 48))
      if (ref.length <= 600) starts.push(0)
      const candidates = [...new Set(starts)].map(start => align(tokens, ref.slice(start, start + Math.max(600, tokens.length * 2 + 96)), start)).sort((a, b) => b.score - a.score)
      const best = candidates[0]
      const usable = best && best.score >= Math.max(6, tokens.length * 1.2)
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!, next = all[base + i + 1]
        const end = next?.start ?? text.length
        let replacement = text.slice(tok.start, end)
        let referenceSentence: number | undefined, breakAfter: boolean | undefined
        const j = usable ? best.pairs.get(i) : undefined
        if (j !== undefined) {
          const r = ref[j]!
          // An anchor must have several exact neighbours before it can correct a
          // homophone. Numeric and negation conflicts are never substitutions.
          let support = 0
          for (let k = Math.max(0, i - 4); k < Math.min(tokens.length, i + 5); k++) {
            const q = best.pairs.get(k)
            if (q !== undefined && equivalent(tokens[k]!, ref[q]!)) support++
          }
          const agrees = candidates.filter(c => c.score >= best.score - 1.5).every(c => {
            const q = c.pairs.get(i)
            return q !== undefined && ref[q]!.raw === r.raw && script.slice(ref[q]!.end, ref[q + 1]?.start ?? script.length) === script.slice(r.end, ref[j + 1]?.start ?? script.length)
          })
          // Near sounds and numeral-shaped words need two consecutive exact
          // tokens on BOTH sides, with no alignment gaps or sentence boundary.
          const exactFlanks = [-2, -1, 1, 2].every(d => {
            const a = tokens[i + d], b = ref[j + d]
            return a && b && best.pairs.get(i + d) === j + d && equivalent(a, b)
          }) && !/[。！？!?]/u.test(text.slice(tokens[i - 2]?.start ?? tok.start, tokens[i + 2]?.end ?? tok.end)) &&
            !/[。！？!?\n]/u.test(script.slice(ref[j - 2]?.start ?? r.start, ref[j + 2]?.end ?? r.end))
          const contextual = confusable(tok, r) && exactFlanks && flankSpellings.get(flankKey(j))!.size === 1 &&
            (!tok.protected || !numericContext(tokens, i))
          if (agrees && (equivalent(tok, r) || contextual || (support >= 3 && phonetic(tok, r) && contextSpellings.get(contextKey(j))!.size === 1))) {
            referenceSentence = referenceSentences[j]
            breakAfter = referenceBreaks[j]
            const tail = text.slice(tok.end, end)
            const refTail = script.slice(r.end, ref[j + 1]?.start ?? script.length)
            const nextPair = best.pairs.get(i + 1)
            // Inside a sentence, don't borrow punctuation across unmatched
            // words. An authored sentence end also applies before an ad lib.
            const canPunctuate = nextPair === j + 1 || !next || referenceBreaks[j]
            const punctuation = refTail.replace(/\s*\n\s*/g, ' ').slice(0, 16)
            // A manuscript line break must not add another trailing space on
            // every correction of a sentence/cue ending at this token.
            replacement = r.raw + (canPunctuate ? (next ? punctuation : punctuation.trimEnd()) : tail)
          }
        }
        pieces.push({ start: tok.start, end, text: replacement, referenceSentence, breakAfter })
      }
    }
    return { text: text.slice(0, all[0]?.start ?? text.length) + pieces.map(p => p.text).join(''), pieces }
  }
  return correct
}
