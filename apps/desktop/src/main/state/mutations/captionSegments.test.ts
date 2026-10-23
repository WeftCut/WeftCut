import { describe, it, expect } from 'vitest'
import { breakLines, planCues, settleShortCues, type CaptionLimits, type TranscriptSegment } from './captionSegments'

const LIMITS: CaptionLimits = { max_chars: 42, max_lines: 2, min_cue_us: 1_200_000, max_cue_us: 6_000_000 }

/** A segment whose words each take `per` µs, back to back from `at`. */
function spoken(text: string, at = 0, per = 300_000): TranscriptSegment {
  const words = text.split(' ').map((w, i) => ({ text: w, t_start_us: at + i * per, t_end_us: at + (i + 1) * per }))
  return { text, t_start_us: at, t_end_us: at + words.length * per, words }
}
const lines = (t: string) => t.split('\n')

describe('breakLines', () => {
  it('keeps a line that fits', () => {
    expect(breakLines('  Short and  sweet ', 42)).toBe('Short and sweet')
  })

  it('breaks on the fewest lines, balanced, at a word boundary', () => {
    const out = breakLines('the quick brown fox jumps over the lazy dog and keeps on running', 42)
    expect(lines(out)).toHaveLength(2)
    expect(Math.max(...lines(out).map((l) => l.length))).toBeLessThanOrEqual(42)
    expect(Math.abs(lines(out)[0]!.length - lines(out)[1]!.length)).toBeLessThanOrEqual(8)
    expect(out.replace('\n', ' ')).toBe('the quick brown fox jumps over the lazy dog and keeps on running')
  })

  it('prefers a break after punctuation when it costs little balance', () => {
    expect(breakLines('So that was the plan, and then we changed everything', 42)).toBe('So that was the plan,\nand then we changed everything')
  })

  it('breaks CJK text between characters', () => {
    const text = '先准备一张彩纸放在桌面上然后沿着中线慢慢对折并且用手指压平边缘接着打开纸张检查折痕'
    const out = breakLines(text, 20)
    expect(lines(out).every((l) => l.length <= 20)).toBe(true)
    expect(out.replace(/\n/g, '')).toBe(text)
  })

  it('leaves a word longer than a line whole', () => {
    expect(breakLines('see https://example.com/a/very/long/path/that/never/ends', 20)).toBe('see\nhttps://example.com/a/very/long/path/that/never/ends')
  })
})

describe('planCues', () => {
  it('keeps a segment that fits as one cue, with its lines broken', () => {
    const seg = spoken('one two three four five six seven eight nine ten eleven twelve')
    const [cue, ...rest] = planCues(seg, LIMITS)
    expect(rest).toEqual([])
    expect(cue).toMatchObject({ t_start_us: seg.t_start_us, t_end_us: seg.t_end_us, estimated: false, words: seg.words })
    expect(lines(cue!.text)).toHaveLength(2)
  })

  it('keeps lines the caller broke when they fit', () => {
    const seg = { text: 'Ann Matsuuchi\nLibrarian, LaGuardia', t_start_us: 0, t_end_us: 3_000_000, words: [] }
    expect(planCues(seg, LIMITS)[0]!.text).toBe('Ann Matsuuchi\nLibrarian, LaGuardia')
  })

  it('splits a segment too long for two lines at word boundaries, timed from its words', () => {
    const text = 'Wikipedia is a project that anyone can edit, and the librarians at our college run edit-a-thons'
    const seg = spoken(text, 10_000_000)
    const cues = planCues(seg, LIMITS)
    expect(cues.length).toBe(2)
    for (const c of cues) {
      expect(lines(c.text).length).toBeLessThanOrEqual(2)
      expect(Math.max(...lines(c.text).map((l) => l.length))).toBeLessThanOrEqual(42)
      expect(c.estimated).toBe(false)
      expect(c.t_start_us).toBe(c.words[0]!.t_start_us)
    }
    expect(cues[0]!.t_start_us).toBe(seg.t_start_us)
    expect(cues.at(-1)!.t_end_us).toBe(seg.t_end_us)
    expect(cues[0]!.t_end_us).toBeLessThanOrEqual(cues[1]!.t_start_us)
    expect(cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe(text)
    expect(cues.flatMap((c) => c.words)).toEqual(seg.words)
    // The split falls after the comma, where the clause ends.
    expect(cues[0]!.text.replace(/\n/g, ' ')).toBe('Wikipedia is a project that anyone can edit,')
  })

  it('splits a segment longer than the longest cue even when its text fits', () => {
    const seg = spoken('slow words spoken with long gaps between', 0, 1_500_000)
    const cues = planCues(seg, LIMITS)
    expect(cues.length).toBeGreaterThan(1)
    for (const c of cues) expect(c.t_end_us - c.t_start_us).toBeLessThanOrEqual(LIMITS.max_cue_us)
  })

  it('holds a cue into the pause after its last word, never past the next word', () => {
    const seg = spoken('a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg hh ii jj', 0, 200_000)
    seg.words[20]!.t_start_us += 5_000_000 // a long pause before the 21st word
    for (let i = 20; i < seg.words.length; i++) { if (i > 20) seg.words[i]!.t_start_us += 5_000_000; seg.words[i]!.t_end_us += 5_000_000 }
    seg.t_end_us += 5_000_000
    const cues = planCues(seg, LIMITS)
    for (let k = 0; k + 1 < cues.length; k++) expect(cues[k]!.t_end_us).toBeLessThanOrEqual(cues[k + 1]!.t_start_us)
  })

  it('spreads time over the characters when the words are missing, and says so', () => {
    const text = 'This cue came from a subtitle file with no word timing at all, and it runs far too long for two lines'
    const cues = planCues({ text, t_start_us: 0, t_end_us: 8_000_000, words: [] }, LIMITS)
    expect(cues.length).toBe(2)
    expect(cues.every((c) => c.estimated)).toBe(true)
    expect(cues[0]!.t_start_us).toBe(0)
    expect(cues[1]!.t_end_us).toBe(8_000_000)
    expect(cues[0]!.t_end_us).toBeGreaterThan(2_000_000)
  })

  it('splits CJK transcripts with per-character words', () => {
    const text = '今天我们来介绍一下自动剪辑功能它可以帮助你在很短的时间里完成粗剪然后再根据需要慢慢调整节奏和字幕最后导出成片分享给朋友们看看效果怎么样'
    const seg: TranscriptSegment = { text, t_start_us: 0, t_end_us: [...text].length * 150_000,
      words: [...text].map((ch, i) => ({ text: ch, t_start_us: i * 150_000, t_end_us: (i + 1) * 150_000 })) }
    const cues = planCues(seg, { ...LIMITS, max_chars: 16 })
    expect(cues.map((c) => c.text.replace(/\n/g, '')).join('')).toBe(text)
    for (const c of cues) {
      expect(lines(c.text).every((l) => l.length <= 16)).toBe(true)
      expect(c.t_end_us - c.t_start_us).toBeLessThanOrEqual(LIMITS.max_cue_us)
    }
  })
})

describe('settleShortCues', () => {
  const cue = (text: string, t_start_us: number, t_end_us: number) => ({ text, raw: text, t_start_us, t_end_us, words: [], estimated: false })
  const spans = (cues: ReturnType<typeof settleShortCues>) => cues.map((c) => [c.text, c.t_start_us, c.t_end_us])

  it('joins a short cue to the one it reads with', () => {
    // Mid-sentence: back to the previous cue.
    expect(spans(settleShortCues([cue('who is one of the originators', 0, 1_270_000), cue('as well.', 1_270_000, 2_270_000), cue('And of course,', 2_300_000, 4_000_000)], LIMITS)))
      .toEqual([['who is one of the originators as well.', 0, 2_270_000], ['And of course,', 2_300_000, 4_000_000]])
    // After a full stop: forward to the next.
    expect(spans(settleShortCues([cue('That was it.', 0, 2_000_000), cue('So,', 2_000_000, 2_400_000), cue('what next?', 2_400_000, 4_000_000)], LIMITS)))
      .toEqual([['That was it.', 0, 2_000_000], ['So, what next?', 2_000_000, 4_000_000]])
  })

  it('joins CJK cues without a space', () => {
    expect(settleShortCues([cue('今天介绍自动剪辑', 0, 2_000_000), cue('功能', 2_000_000, 2_500_000)], LIMITS)[0]!.text).toBe('今天介绍自动剪辑功能')
  })

  it('holds a short cue it cannot join into the gap, up to the next cue', () => {
    const settled = settleShortCues([
      cue('Yes.', 0, 400_000),
      cue('A long answer that fills both lines of the caption on its own, nearly all the way', 900_000, 5_000_000),
      cue('Ok.', 9_000_000, 9_300_000),
    ], LIMITS)
    expect(settled.map((c) => [c.t_start_us, c.t_end_us])).toEqual([[0, 900_000], [900_000, 5_000_000], [9_000_000, 9_300_000]])
  })
})
