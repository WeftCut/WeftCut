import { describe, expect, it } from 'vitest'
import type { Change, ChangeClass } from '../../shared/review'
import { changeStatKey, changeStats } from './changeStats'

const change = (id: string, cls: ChangeClass): Change => ({ id: `Layer:${id}`, class: cls, details: [], composition_id: 'root', ranges: [] })

describe('changeStats', () => {
  it('counts the unreviewed changes of each class, in diff-stat order', () => {
    const stats = changeStats({ unreviewed: [change('a', 'modified'), change('b', 'added'), change('c', 'removed'), change('d', 'modified')] })
    expect(stats).toEqual([
      { kind: 'class', class: 'added', count: 1 },
      { kind: 'class', class: 'removed', count: 1 },
      { kind: 'class', class: 'modified', count: 2 },
    ])
  })

  it('keeps every class figure at zero, so the line has one shape', () => {
    expect(changeStats({ unreviewed: [change('a', 'added')] }).map(s => s.kind === 'class' ? [s.class, s.count] : s.kind))
      .toEqual([['added', 1], ['removed', 0], ['modified', 0]])
  })

  it('follows the class figures with what there is to watch: the ranges to review and how long they run', () => {
    const range = (s: number, e: number, source: 'review' | 'user' = 'review', composition_id = 'root') => ({
      composition_id, class: 'modified' as const, t_start_us: s, t_end_us: e, before_start_us: s, before_end_us: e, source, change_ids: [],
    })
    // A cut point counts and adds no time; the user's own ranges are not to review.
    const stats = changeStats({ unreviewed: [change('a', 'modified')], ranges: [range(0, 2_000_000), range(5_000_000, 5_000_000), range(6_000_000, 9_000_000, 'user')], filmId: 'root' })
    expect(stats.at(-1)).toEqual({ kind: 'ranges', count: 2, durationUs: 2_000_000 })
    expect(changeStats({ unreviewed: [change('a', 'modified')], ranges: [range(0, 1, 'user')], filmId: 'root' }).some(s => s.kind === 'ranges')).toBe(false)
  })

  it('counts the film\'s ranges once: a Group\'s own ranges are already where the film plays them', () => {
    const range = (composition_id: string, s: number, e: number) => ({
      composition_id, class: 'modified' as const, t_start_us: s, t_end_us: e, before_start_us: s, before_end_us: e, source: 'review' as const, change_ids: [],
    })
    // A change inside a Group is a range of the Group's composition and the
    // root's range where the Group clip plays it: one stretch of the film.
    const stats = changeStats({ unreviewed: [change('a', 'modified')], ranges: [range('group', 0, 2_000_000), range('root', 40_000_000, 42_000_000)], filmId: 'root' })
    expect(stats.at(-1)).toEqual({ kind: 'ranges', count: 1, durationUs: 2_000_000 })
  })

  it('gives each figure of a line its own key', () => {
    const keys = changeStats({ unreviewed: [] }).map(changeStatKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
