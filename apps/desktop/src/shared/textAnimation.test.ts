import { describe, expect, it } from 'vitest'
import { TEXT_ANIM_US, textAnimationAt } from './textAnimation'

const S = 1_000_000

describe('textAnimationAt', () => {
  it('is the identity with no presets, and holds full strength between entrance and exit', () => {
    expect(textAnimationAt(null, null, 0, 4 * S, 72, 5)).toEqual({ opacity: 1, dy: 0, visibleChars: null })
    expect(textAnimationAt('FadeIn', 'FadeOut', 2 * S, 4 * S, 72, 5)).toEqual({ opacity: 1, dy: 0, visibleChars: null })
  })

  it('fades in from nothing at the head and out to nothing at the tail', () => {
    expect(textAnimationAt('FadeIn', 'FadeOut', 0, 4 * S, 72, 5).opacity).toBe(0)
    expect(textAnimationAt('FadeIn', 'FadeOut', TEXT_ANIM_US, 4 * S, 72, 5).opacity).toBe(1)
    expect(textAnimationAt('FadeIn', 'FadeOut', 4 * S, 4 * S, 72, 5).opacity).toBe(0)
    const mid = textAnimationAt('FadeIn', null, TEXT_ANIM_US / 2, 4 * S, 72, 5).opacity
    expect(mid).toBeGreaterThan(0.5)
    expect(mid).toBeLessThan(1)
  })

  it('slides up into place from half the font size below, and up and away on exit', () => {
    expect(textAnimationAt('SlideUp', null, 0, 4 * S, 80, 5)).toMatchObject({ dy: 40, opacity: 0 })
    expect(textAnimationAt('SlideUp', null, TEXT_ANIM_US, 4 * S, 80, 5).dy).toBe(0)
    expect(textAnimationAt(null, 'SlideUp', 4 * S, 4 * S, 80, 5).dy).toBe(-40)
    expect(textAnimationAt('SlideDown', 'SlideDown', 0, 4 * S, 80, 5).dy).toBe(-40)
  })

  it('compresses into a third of a short layer', () => {
    expect(textAnimationAt('FadeIn', null, 300_000, 900_000, 72, 5).opacity).toBe(1)
  })

  it('types a character every 40 ms, over at most half the layer', () => {
    expect(textAnimationAt('Typewriter', null, 0, 4 * S, 72, 10).visibleChars).toBe(0)
    expect(textAnimationAt('Typewriter', null, 200_000, 4 * S, 72, 10).visibleChars).toBe(5)
    expect(textAnimationAt('Typewriter', null, 400_000, 4 * S, 72, 10).visibleChars).toBeNull()
    expect(textAnimationAt('Typewriter', null, 500_000, 2 * S, 72, 100).visibleChars).toBe(50)
  })
})
