import { describe, expect, it } from 'vitest'
import { createTextCorrector } from './textCorrection'

const correct = (text: string, script: string) => createTextCorrector(script)(text).text
describe('reference text correction', () => {
  it('corrects contextual Chinese homophones and punctuation', () => {
    expect(correct('今天我们介绍自动剪缉功能它可以节省时间', '今天我们介绍自动剪辑功能。它可以节省时间。')).toBe('今天我们介绍自动剪辑功能。它可以节省时间。')
  })
  it('finds a partial recording inside a longer manuscript', () => {
    expect(correct('今天我们介绍自动剪缉功能', '欢迎收看节目。今天我们介绍自动剪辑功能。感谢观看。')).toBe('今天我们介绍自动剪辑功能。')
  })
  it('preserves real numeric conflicts', () => {
    expect(correct('售价四百九十九元。', '售价三百九十九元。')).toBe('售价四百九十九元。')
  })
  it('does not guess the place value of colloquial Chinese numbers', () => {
    expect(correct('今天的价格是一百二元。', '今天的价格是102元。')).toBe('今天的价格是一百二元。')
    expect(correct('今天的价格是一千二元。', '今天的价格是1002元。')).toBe('今天的价格是一千二元。')
    expect(correct('今天的价格是一百零二元。', '今天的价格是102元。')).toBe('今天的价格是102元。')
  })
  it('preserves negations on either side', () => {
    expect(correct('这个产品不支持退款。', '这个产品支持退款。')).toBe('这个产品不支持退款。')
    expect(correct('这个产品支持退款。', '这个产品不支持退款。')).toBe('这个产品支持退款。')
  })
  it('normalizes equivalent numeric representations without changing values', () => {
    expect(correct('今天的价格是三百九十九元', '今天的价格是399元。')).toBe('今天的价格是399元。')
    expect(correct('今天提高了百分之二十', '今天提高了20%。')).toBe('今天提高了20%。')
  })
  it('leaves unrelated input alone', () => {
    expect(correct('明天下雨记得带伞。', '这个视频介绍字幕剪辑功能。')).toBe('明天下雨记得带伞。')
  })
  it('does not insert an omitted manuscript sentence and reacquires after it', () => {
    const result = correct('今天介绍导入功能。接下来介绍自动剪缉功能。', '今天介绍导入功能。我们还支持多种视频格式。接下来介绍自动剪辑功能。')
    expect(result).toBe('今天介绍导入功能。接下来介绍自动剪辑功能。')
  })
  it('preserves ad libs and repeated speech', () => {
    const result = correct('今天介绍导入功能。嗯这个比较简单。接下来介绍自动剪缉功能。', '今天介绍导入功能。接下来介绍自动剪辑功能。')
    expect(result).toContain('嗯这个比较简单。')
    expect(result).toContain('自动剪辑功能。')
    const repeated = '今天介绍导入功能。今天介绍导入功能。'
    expect(correct(repeated, '今天介绍导入功能。')).toBe(repeated)
  })
  it('keeps actual paraphrases rather than rewriting to the script', () => {
    expect(correct('这个功能非常好用。', '这个功能十分方便。')).toBe('这个功能非常好用。')
  })
  it('preserves pure punctuation and empty input', () => {
    expect(correct('', '文稿')).toBe('')
    expect(correct('……', '文稿')).toBe('……')
  })
  it('normalizes English spelling case and punctuation', () => {
    expect(correct('welcome to weftcut today', 'Welcome to WeftCut today.')).toBe('Welcome to WeftCut today.')
  })
  it('is stable when applied again', () => {
    const fix = createTextCorrector('今天介绍自动剪辑功能。价格是399元。')
    const once = fix('今天介绍自动剪缉功能价格是三百九十九元').text
    expect(fix(once).text).toBe(once)
  })
  it('finds late text without quadratic full-manuscript alignment', () => {
    const script = '这是一段无关的开场白。'.repeat(1000) + '今天我们介绍自动剪辑功能。'
    expect(correct('今天我们介绍自动剪缉功能', script)).toBe('今天我们介绍自动剪辑功能。')
  })
  it('recovers correction after an entire missing manuscript section', () => {
    const script = '首先介绍音频降噪功能。' + '这段录音没有读出的长篇介绍。'.repeat(100) + '最后我们介绍自动剪辑功能。'
    expect(correct('首先介绍音频降躁功能。最后我们介绍自动剪缉功能。', script)).toBe('首先介绍音频降噪功能。最后我们介绍自动剪辑功能。')
  })
  it('abstains when repeated phonetic contexts support different spellings', () => {
    const script = '我们今天要介绍权利保护。我们今天要介绍权力保护。'
    expect(correct('我们今天要介绍全力保护。', script)).toBe('我们今天要介绍全力保护。')
  })
})
