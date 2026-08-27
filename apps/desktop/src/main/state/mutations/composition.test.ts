// src/main/state/mutations/composition.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams } from '../model'
import { applyFitComposition } from './composition'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('applyFitComposition', () => {
  it('unpins and refits duration to the layer high-water mark (shrink)', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [color('a', 0, 2_000_000)]
    root(p).duration_pinned = true; root(p).duration_us = 9_000_000
    applyFitComposition(p)
    expect(root(p).duration_pinned).toBe(false)
    expect(root(p).duration_us).toBe(2_000_000)
  })
  it('refits to 0 when there are no layers', () => {
    const p = blankProject(seededGen(), 't'); root(p).duration_pinned = true; root(p).duration_us = 5_000_000
    applyFitComposition(p)
    expect(root(p).duration_us).toBe(0)
  })
})

describe('applyFitComposition per composition', () => {
  it('composition_id refits ONE composition (a pinned root stays pinned); unknown id → CompositionNotFound', () => {
    const { p, groupId } = groupedProject()
    root(p).duration_pinned = true; root(p).duration_us = 9_000_000
    group(p, groupId).duration_pinned = true; group(p, groupId).duration_us = 5_000_000
    applyFitComposition(p, groupId)
    expect([group(p, groupId).duration_pinned, group(p, groupId).duration_us]).toEqual([false, 1_000_000])
    expect([root(p).duration_pinned, root(p).duration_us]).toEqual([true, 9_000_000])
    try { applyFitComposition(p, 'ghost'); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('CompositionNotFound') }
  })
})
