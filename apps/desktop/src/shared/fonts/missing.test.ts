import { describe, expect, it } from 'vitest'
import { GENERIC_FONT_FAMILIES } from './resolve'
import { missingLeaves } from './missing'

const here = (...families: string[]) => (leaf: string) => families.includes(leaf)

describe('missingLeaves', () => {
  it('names every leaf before the first that resolves, and that leaf as the fallback', () => {
    expect(missingLeaves(['Gone', 'Also Gone', 'Present', 'Later Gone'], here('Present')))
      .toEqual({ missing: ['Gone', 'Also Gone'], fallback: 'Present' })
  })

  it('never names a leaf after the first that resolves', () => {
    expect(missingLeaves(['Present', 'Gone'], here('Present'))).toEqual({ missing: [], fallback: 'Present' })
  })

  it('stops at a bundled leaf, which is never missing', () => {
    expect(missingLeaves(['Gone', 'Liberation Sans', 'Later Gone'], here()))
      .toEqual({ missing: ['Gone'], fallback: 'Liberation Sans' })
  })

  it('never names a generic family, and stops at one', () => {
    for (const generic of GENERIC_FONT_FAMILIES) {
      expect(missingLeaves([generic, 'Gone'], here())).toEqual({ missing: [], fallback: generic })
    }
    expect(missingLeaves(['Gone', 'Sans-Serif'], here())).toEqual({ missing: ['Gone'], fallback: 'Sans-Serif' })
  })

  it('has no fallback when no leaf draws, and names a repeated leaf once', () => {
    expect(missingLeaves(['Gone', 'gone', 'Other'], here())).toEqual({ missing: ['Gone', 'Other'], fallback: null })
  })
})
