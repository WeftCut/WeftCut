import { describe, it, expect } from 'vitest'
import { formatSrt, formatVtt } from './subtitleFormat'

const CUES = [
  { start_us: 1_000_000, end_us: 2_500_000, text: 'Hello world' },
  { start_us: 3_661_000_400, end_us: 3_662_000_000, text: 'Two\nlines' },
]

describe('subtitle writers', () => {
  it('SRT: numbered cues, comma millisecond stamps, rounded to the millisecond', () => {
    expect(formatSrt(CUES)).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n01:01:01,000 --> 01:01:02,000\nTwo\nlines\n')
    expect(formatSrt([])).toBe('')
  })
  it('WebVTT: header, dot stamps, no numbers', () => {
    expect(formatVtt(CUES)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world\n\n01:01:01.000 --> 01:01:02.000\nTwo\nlines\n')
    expect(formatVtt([])).toBe('WEBVTT\n\n')
  })
})
