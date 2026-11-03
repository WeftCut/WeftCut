import { describe, expect, it } from 'vitest'
import { alignedShare, createTextCorrector } from './textCorrection'

const correct = (text: string, script: string) => createTextCorrector(script)(text).text
describe('reference text correction', () => {
  it('corrects a contextual near-homophone in a synthetic sentence', () => {
    expect(correct('新的标识应该吃什么颜色？', '新的标识应该是什么颜色？')).toBe('新的标识应该是什么颜色？')
  })
  it('corrects a numeral-shaped homophone in a name', () => {
    expect(correct('欢迎来到课堂，我叫五老师', '欢迎来到课堂，我叫吴老师')).toBe('欢迎来到课堂，我叫吴老师')
  })
  it('corrects a synthetic repeated opening against a partial manuscript', () => {
    const script = '新的标识应该是什么颜色？\nHi欢迎来到课堂，我叫吴老师\n下面演示折纸步骤\nPaperBot展示了折纸过程'
    const text = '新的标识应该吃什么颜色？新的标识应该吃什么颜色？好的,欢迎来到课堂，我叫五老师 下面演示折纸步骤 PaperBot展示了折纸过程'
    const expected = '新的标识应该是什么颜色？新的标识应该是什么颜色？好的,欢迎来到课堂，我叫吴老师 下面演示折纸步骤 PaperBot展示了折纸过程'
    expect(correct(text, script)).toBe(expected)
    expect(correct(expected, script)).toBe(expected)
  })
  it('uses exact context across arbitrary cue line breaks', () => {
    expect(correct('欢迎来到课堂，我叫\n五老师', '欢迎来到课堂，我叫吴老师')).toBe('欢迎来到课堂，我叫吴老师')
  })
  it.each([
    ['吃什么？', '是什么？'],
    ['我是一', '我是椅'],
    ['售价是一元整。', '售价是衣元整。'],
    ['请找第四号窗口。', '请找第是号窗口。'],
    ['售价是四百元整。', '售价是是百元整。'],
    ['今天有一位师傅。', '今天有衣位师傅。'],
    ['这个产品不支持退款。', '这个产品布支持退款。'],
    ['这个产品布支持退款。', '这个产品不支持退款。'],
    ['欢迎来到课堂，我叫吴老师', '欢迎来到课堂，我叫五老师'],
    ['新的标识应该吃什么颜色？', '新的标识应该是什么颜色？新的标识应该次什么颜色？'],
    ['欢迎来到课堂，我叫五老师。', '欢迎来到课堂，我叫吴老师。欢迎来到课堂，我叫伍老师。'],
  ])('preserves weak, protected or ambiguous input: %s', (text, script) => {
    expect(correct(text, script)).toBe(text)
  })
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

describe('misheard Latin words between exact anchors', () => {
  const script = 'Hi everyone, my name is Lane Rasberry and I am the president of Wikimedia New York City.\nEvery year I joined Wikimedia events as a volunteer.'
  it.each([
    ['my name is Laine Raspberry and I am', 'my name is Lane Rasberry and I am'],
    ['the president of with the media in New York City', 'the president of Wikimedia New York City.'],
    ['the president of Wicked Media New York City', 'the president of Wikimedia New York City.'],
    ['every year I joined with the media events as a', 'Every year I joined Wikimedia events as a'],
  ])('takes the script words for a run of 1-4 words: %s', (text, expected) => {
    expect(correct(text, script)).toBe(expected)
  })
  it('substitutes the same run when no sentence ends inside it', () => {
    expect(correct('then we met Laine Raspberry was there with us', 'Then we met Lane Rasberry was there with us.')).toBe('Then we met Lane Rasberry was there with us.')
  })
  it('counts the substituted words as aligned', () => {
    expect(alignedShare(createTextCorrector(script), 'my name is Laine Raspberry and I am')).toBe(1)
  })
  it('is stable when applied again', () => {
    const fix = createTextCorrector(script)
    const once = fix('the president of with the media in New York City').text
    expect(fix(once).text).toBe(once)
  })
  it('keeps an ad lib the script lacks', () => {
    expect(correct('and then, you know, we all edit together', 'And then we all edit together.')).toBe('And then, you know, we all edit together.')
  })
  it('never inserts words the speaker skipped', () => {
    expect(correct('and then we all edit together', 'And then we all edit articles together.')).toBe('And then we all edit together.')
  })
  it.each([
    ['we have twenty volunteers who help us', 'We have thirty volunteers who help us.'],
    ['we have 20 volunteers who help us', 'We have 30 volunteers who help us.'],
    ['we have the twenty volunteers who help us', 'We have thirty volunteers who help us.'],
    ['anyone can not edit the pages here', 'Anyone can now edit the pages here.'],
    ['anyone can now edit the pages here', 'Anyone can not edit the pages here.'],
    ["anyone can't edit the pages here", 'Anyone can edit the pages here.'],
  ])('never substitutes a number or a negation: %s', (text, script) => {
    expect(correct(text, script).toLowerCase()).toBe(text.toLowerCase() + '.')
  })
  it.each([
    // One anchor word on a side is not enough.
    ['of Wicked Media New York', 'the president of Wikimedia New York City'],
    // The run crosses a sentence end.
    ['then we met Laine. Raspberry was there with us', 'Then we met Lane. Rasberry was there with us.'],
    // More than four words.
    ['the president of a b c d e New York City', 'The president of Wikimedia New York City.'],
    // The same anchors enclose different words elsewhere in the script.
    ['we met Laine Rasbery at the park', 'We met Lane Rasberry at the park and later we met Lane Raspberry at the park again.'],
  ])('abstains on weak or ambiguous evidence: %s', (text, script) => {
    expect(correct(text, script).toLowerCase().replace(/[.,]/g, '')).toBe(text.toLowerCase().replace(/[.,]/g, ''))
  })
  it('leaves Han text to its own rules', () => {
    expect(correct('这个功能非常好用。', '这个功能十分方便。')).toBe('这个功能非常好用。')
  })
})
