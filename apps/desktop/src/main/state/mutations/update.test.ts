// src/main/state/mutations/update.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applySetLayersEnabled, applyUpdateLayer } from './update'
import { isCommandFailure } from '../errors'
import { root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function one(): Project { const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [color('a', 0, 1_000_000)]; return p }
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyUpdateLayer', () => {
  it('applies only the provided fields (label/times/flags)', () => {
    const p = one()
    applyUpdateLayer(p, 'a', { label: 'hi', t_end_us: 2_000_000, enabled: false })
    const l = root(p).tracks[0].layers[0]
    expect(l.label).toBe('hi'); expect(l.t_end_us).toBe(2_000_000); expect(l.enabled).toBe(false)
    expect(l.t_start_us).toBe(0); expect(l.locked).toBe(false) // untouched
  })
  it('treats null/absent patch fields as "do not touch"', () => {
    const p = one()
    applyUpdateLayer(p, 'a', { label: null, t_start_us: null })
    const l = root(p).tracks[0].layers[0]
    expect(l.label).toBeNull(); expect(l.t_start_us).toBe(0) // unchanged
  })
  it('does NOT autofit composition.duration_us on a t_end change', () => {
    const p = one(); root(p).duration_us = 1_000_000; root(p).duration_pinned = false
    applyUpdateLayer(p, 'a', { t_end_us: 5_000_000 })
    expect(root(p).duration_us).toBe(1_000_000) // unchanged — update_layer never autofits
  })
  it('throws LayerNotFound for a missing layer', () => {
    expectCmd(() => applyUpdateLayer(one(), 'ghost', { enabled: false }), 'LayerNotFound')
  })
  it('throws TrackLocked when the layer is on a locked track (ungated by corpus)', () => {
    const p = one(); root(p).tracks[0].locked = true
    expectCmd(() => applyUpdateLayer(p, 'a', { t_end_us: 2_000_000 }), 'TrackLocked')
  })
})

// applySetLayersEnabled — the link's `enabled` fan-out, at the op level: it
// toggles exactly the set it is handed (the caller resolved the members).
describe('applySetLayersEnabled', () => {
  function two(): Project {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [color('a', 0, 1_000_000)]
    root(p).tracks[1].layers = [color('b', 0, 1_000_000)]
    return p
  }
  const enabledOf = (p: Project) => root(p).tracks.flatMap((t) => t.layers).map((l) => [l.id, l.enabled])

  it('toggles every named layer, and only those', () => {
    const p = two(); root(p).tracks[0].layers.push(color('c', 2_000_000, 3_000_000))
    applySetLayersEnabled(p, ['a', 'b'], false)
    expect(enabledOf(p)).toEqual([['a', false], ['c', true], ['b', false]])
    applySetLayersEnabled(p, ['a', 'b'], true)
    expect(enabledOf(p)).toEqual([['a', true], ['c', true], ['b', true]])
  })
  // The eye is visibility, not content: the layer lock guards edits to what the
  // layer IS, and a hidden locked clip is still that clip.
  it('is not blocked by a layer`s own locked flag', () => {
    const p = two(); root(p).tracks[0].layers[0].locked = true
    applySetLayersEnabled(p, ['a', 'b'], false)
    expect(enabledOf(p)).toEqual([['a', false], ['b', false]])
  })
  // `b` is checked before anything is written, so `a` — first in the set and on
  // a free lane — must come out untouched too.
  it('refuses the WHOLE set when one member sits on a locked track', () => {
    const p = two(); root(p).tracks[1].locked = true
    const before = structuredClone(p)
    expectCmd(() => applySetLayersEnabled(p, ['a', 'b'], false), 'TrackLocked')
    expect(p).toEqual(before)
  })
  it('throws LayerNotFound for an unknown id, touching nothing', () => {
    const p = two()
    const before = structuredClone(p)
    expectCmd(() => applySetLayersEnabled(p, ['a', 'ghost'], false), 'LayerNotFound')
    expect(p).toEqual(before)
  })
})
