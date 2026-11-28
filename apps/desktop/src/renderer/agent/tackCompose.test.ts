import { beforeEach, describe, expect, it, vi } from 'vitest'

const playhead = vi.hoisted(() => ({ us: 0 }))
vi.mock('../state/playheadProjection', () => ({ focusedPlayheadUs: () => playhead.us }))

import { newTackPlace } from './tackCompose'
import { useProjectStore } from '../state/projectStore'
import { useRangeStore } from '../state/rangeStore'
import { ROOT_ID, summaryFixture } from '../testing/summaryFixture'

const S = 1_000_000

describe('where a new tack goes', () => {
  beforeEach(() => {
    useProjectStore.setState({ summary: summaryFixture({ root: { duration_us: 20 * S } }) })
    useRangeStore.setState({ inUs: null, outUs: null })
    playhead.us = 5 * S + 10_000
  })

  it('covers the marked range when both its ends are marked', () => {
    useRangeStore.setState({ inUs: 2 * S, outUs: 4 * S })
    expect(newTackPlace()).toEqual({ compositionId: ROOT_ID, tUs: 2 * S, endTUs: 4 * S })
  })

  it('falls back to the frame under the playhead with one mark or none', () => {
    const atPlayhead = { compositionId: ROOT_ID, tUs: 5 * S, endTUs: null }
    expect(newTackPlace()).toEqual(atPlayhead)
    useRangeStore.setState({ inUs: 2 * S, outUs: null })
    expect(newTackPlace()).toEqual(atPlayhead)
    useRangeStore.setState({ inUs: null, outUs: 9 * S })
    expect(newTackPlace()).toEqual(atPlayhead)
  })
})
