import { describe, expect, it } from 'vitest'
import { MAX_EXCLUDED_FONT_LENGTH, excludedFontsProblem, normalizeExcludedFonts } from './excludedFonts'
import { seededGen } from './ids'
import { blankProject } from './model'
import { isValidationFailure } from './errors'
import { validate } from './validate'

const atCap = 'f'.repeat(MAX_EXCLUDED_FONT_LENGTH)
const overCap = `${atCap}f`

/** One broken entry per rule, each in a list that is otherwise valid. */
const BROKEN: [string, unknown, ReturnType<typeof excludedFontsProblem>][] = [
  ['not a list', 'Inter', { index: null, reason: 'NotList' }],
  ['a number', ['Inter', 7], { index: 1, reason: 'NotString' }],
  ['a blank name', ['Inter', '  '], { index: 1, reason: 'Empty' }],
  ['a padded name', ['Inter', ' Lora'], { index: 1, reason: 'Untrimmed' }],
  ['a name over the cap', ['Inter', overCap], { index: 1, reason: 'TooLong' }],
  ['a family twice in other case', ['Inter', 'INTER'], { index: 1, reason: 'Duplicate' }],
]

describe('excludedFontsProblem', () => {
  it('accepts trimmed, distinct names up to the cap', () => {
    expect(excludedFontsProblem([])).toBeNull()
    expect(excludedFontsProblem(['Inter', 'Noto Sans CJK SC', atCap])).toBeNull()
  })

  it.each(BROKEN)('names the entry that breaks a rule: %s', (_, list, problem) => {
    expect(excludedFontsProblem(list)).toEqual(problem)
  })

  it('counts the cap in characters, not UTF-16 units', () => {
    expect(excludedFontsProblem(['𝐀'.repeat(MAX_EXCLUDED_FONT_LENGTH)])).toBeNull()
  })
})

describe('normalizeExcludedFonts', () => {
  it('yields a list excludedFontsProblem accepts from every broken one', () => {
    for (const [, list] of BROKEN) expect(excludedFontsProblem(normalizeExcludedFonts(list)), JSON.stringify(list)).toBeNull()
  })

  it('trims, drops what no family can be, and keeps the first spelling of a family', () => {
    expect(normalizeExcludedFonts([' Inter ', 7, '', overCap, 'inter', 'Lora', null])).toEqual(['Inter', 'Lora'])
  })

  it('leaves a valid list as it is', () => {
    const list = ['Inter', 'Noto Sans CJK SC']
    expect(normalizeExcludedFonts(list)).toEqual(list)
  })
})

describe('validate', () => {
  it.each(BROKEN)('refuses settings.excluded_fonts holding %s', (_, list, problem) => {
    const p = blankProject(seededGen(), 't')
    ;(p.settings as { excluded_fonts: unknown }).excluded_fonts = list
    try {
      validate(p)
      throw new Error('validate passed')
    } catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'InvalidExcludedFonts', ...problem })
    }
  })

  it('passes a project that excludes families', () => {
    const p = blankProject(seededGen(), 't')
    p.settings.excluded_fonts = ['Inter', 'Lora']
    expect(() => validate(p)).not.toThrow()
  })
})
