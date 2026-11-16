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
    expect(changeStats({ unreviewed: [change('a', 'added')] }).map(s => [s.class, s.count]))
      .toEqual([['added', 1], ['removed', 0], ['modified', 0]])
  })

  it('gives each figure of a line its own key', () => {
    const keys = changeStats({ unreviewed: [] }).map(changeStatKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
