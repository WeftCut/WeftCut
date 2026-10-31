import { describe, expect, it } from 'vitest'
import { stalledEncoderLimitMs } from './exportE2EStall'

describe('stalledEncoderLimitMs', () => {
  it('reads a positive millisecond count and nothing else', () => {
    expect(stalledEncoderLimitMs('2000')).toBe(2000)
    for (const value of [undefined, '', '0', '-5', '1.5', '2s', '99999999']) expect(stalledEncoderLimitMs(value)).toBeNull()
  })
})
