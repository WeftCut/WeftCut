import { describe, it, expect } from 'vitest'
import { checkAllInvariants, invNoUnauthorizedOverlap, invLinksWellFormed, invMarkersWellFormed, invTransitionsWellFormed, InvariantError } from './invariants'
import type { WireComposition, WireProject, WireTransition } from './harness'

const ROOT: WireComposition = {
  id: 'root', duration_us: 1000, duration_pinned: false, fps: { num: 30, den: 1 }, width: 1920, height: 1080,
  tracks: [{ id: 'tA', layers: [{ id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } }] }],
  markers: [], links: [], transitions: [],
}
/** One-composition wire project whose root is `ROOT` patched by `over`. */
const wp = (over: Partial<WireComposition>): WireProject => ({ root_id: 'root', compositions: { root: { ...ROOT, ...over } } })
const base = wp({})

describe('structural invariants', () => {
  it('accepts a well-formed project', () => expect(() => checkAllInvariants(base)).not.toThrow())

  it('rejects unauthorized same-class overlap', () => {
    const bad: WireProject = wp({ tracks: [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 500, t_end_us: 1500, params: { kind: 'Color' } },
    ] }], duration_us: 1500 })
    expect(() => invNoUnauthorizedOverlap(bad)).toThrow(InvariantError)
  })

  it('allows overlap exactly covered by an authorized transition', () => {
    const ok: WireProject = wp({
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
      ] }],
      transitions: [{ id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0 }],
      duration_us: 1800 })
    expect(() => invNoUnauthorizedOverlap(ok)).not.toThrow()
  })

  it('rejects a layer in two links', () => {
    const bad: WireProject = wp({
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 1000, t_end_us: 2000, params: { kind: 'Color' } },
      ] }],
      links: [{ id: 'g1', members: ['l1', 'l2'] }, { id: 'g2', members: ['l2'] }],
      duration_us: 2000 })
    expect(() => invLinksWellFormed(bad)).toThrow(InvariantError)
  })
})

describe('transition invariant (re-derived, Policy B reconcile guarantee)', () => {
  // Overlapped pair with an exactly-matching transition — the healthy shape.
  const withPair = (tr: Partial<WireTransition>, layers?: WireComposition['tracks']): WireProject => wp({
    tracks: layers ?? [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
    ] }],
    transitions: [{ id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0, ...tr }],
    duration_us: 1800 })

  it('accepts a healthy Crossfade, and a Wipe/Slide with direction', () => {
    expect(() => invTransitionsWellFormed(withPair({}))).not.toThrow()
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Wipe', direction: 'left' } }))).not.toThrow()
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Slide', direction: 'down' } }))).not.toThrow()
  })

  it('rejects duration !== geometric overlap', () =>
    expect(() => invTransitionsWellFormed(withPair({ duration_us: 300 }))).toThrow(InvariantError))

  it('rejects zero/negative duration', () => {
    // Layers adjacent (no overlap) so duration is the only violated law.
    const layers = [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 1000, t_end_us: 2000, params: { kind: 'Color' } },
    ] }]
    expect(() => invTransitionsWellFormed(withPair({ duration_us: 0 }, layers))).toThrow(InvariantError)
  })

  it('rejects a missing participant', () =>
    expect(() => invTransitionsWellFormed(withPair({ to_layer: 'ghost' }))).toThrow(InvariantError))

  it('rejects a self-referencing transition', () =>
    expect(() => invTransitionsWellFormed(withPair({ to_layer: 'l1' }))).toThrow(InvariantError))

  it('rejects a cross-track pair', () => {
    const layers = [
      { id: 'tA', layers: [{ id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } }] },
      { id: 'tB', layers: [{ id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } }] },
    ]
    expect(() => invTransitionsWellFormed(withPair({}, layers))).toThrow(InvariantError)
  })

  it('rejects an audio participant', () => {
    const layers = [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Audio' } },
      { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
    ] }]
    expect(() => invTransitionsWellFormed(withPair({}, layers))).toThrow(InvariantError)
  })

  it('rejects a layer participating twice on the same side', () => {
    const p: WireProject = wp({
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
        { id: 'l3', t_start_us: 1600, t_end_us: 2600, params: { kind: 'Color' } },
      ] }],
      transitions: [
        { id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0 },
        { id: 'y', from_layer: 'l1', to_layer: 'l3', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0 },
      ],
      duration_us: 2600 })
    expect(() => invTransitionsWellFormed(p)).toThrow(InvariantError)
  })

  it('rejects malformed kind/direction pairings', () => {
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Crossfade', direction: 'left' } }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Wipe' } }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Slide', direction: 'diagonal' } }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Dissolve' } }))).toThrow(InvariantError)
  })

  it('accepts extended_us at both lane edges (0 = pure placement, duration = full borrow)', () => {
    expect(() => invTransitionsWellFormed(withPair({ extended_us: 0 }))).not.toThrow()
    expect(() => invTransitionsWellFormed(withPair({ extended_us: 200 }))).not.toThrow()
  })

  it('rejects extended_us outside [0, duration_us]', () => {
    expect(() => invTransitionsWellFormed(withPair({ extended_us: -1 }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ extended_us: 201 }))).toThrow(InvariantError)
  })
})

describe('marker invariant (re-derived, reconcile-on-commit guarantee)', () => {
  // A 2 s clip at 1 s showing source [2 s, 4 s), so a mark at source `s` derives
  // to `1 s + (s − 2 s)`. 30 fps, and every time below is a whole frame.
  const clip = { id: 'v1', t_start_us: 1_000_000, t_end_us: 3_000_000, params: { kind: 'VideoClip', src_in_us: 2_000_000, src_out_us: 4_000_000 } }
  const withMarkers = (markers: WireComposition['markers']): WireProject =>
    wp({ tracks: [{ id: 'tA', layers: [clip] }], markers, duration_us: 3_000_000 })

  it('accepts a free marker anywhere and an awake anchored marker on its derived frame', () => {
    expect(() => invMarkersWellFormed(withMarkers([
      { id: 'm1', t_us: 500_000, end_t_us: null, anchor: null },
      { id: 'm2', t_us: 2_000_000, end_t_us: null, anchor: { layer: 'v1', src_us: 3_000_000 } },
    ]))).not.toThrow()
  })

  it('accepts a hibernating marker at any t_us — outside the window there is nothing to derive', () => {
    expect(() => invMarkersWellFormed(withMarkers([
      { id: 'm1', t_us: 900_000, end_t_us: null, anchor: { layer: 'v1', src_us: 1_000_000 } },
    ]))).not.toThrow()
    // src_out_us is EXCLUSIVE: a mark exactly on it is already asleep.
    expect(() => invMarkersWellFormed(withMarkers([
      { id: 'm1', t_us: 900_000, end_t_us: null, anchor: { layer: 'v1', src_us: 4_000_000 } },
    ]))).not.toThrow()
  })

  it('rejects an awake anchored marker whose t_us disagrees with its anchor', () => {
    expect(() => invMarkersWellFormed(withMarkers([
      { id: 'm1', t_us: 2_500_000, end_t_us: null, anchor: { layer: 'v1', src_us: 3_000_000 } },
    ]))).toThrow(InvariantError)
  })

  it('rejects an anchor on a layer no composition holds — the drop that did not happen', () => {
    expect(() => invMarkersWellFormed(withMarkers([
      { id: 'm1', t_us: 2_000_000, end_t_us: null, anchor: { layer: 'ghost', src_us: 3_000_000 } },
    ]))).toThrow(InvariantError)
  })

  it('rejects an anchor reaching into another composition — the move that lost its marker', () => {
    const p: WireProject = {
      root_id: 'root',
      compositions: {
        root: { ...ROOT, tracks: [{ id: 'tA', layers: [] }], markers: [{ id: 'm1', t_us: 2_000_000, end_t_us: null, anchor: { layer: 'v1', src_us: 3_000_000 } }] },
        g: { ...ROOT, id: 'g', tracks: [{ id: 'tG', layers: [clip] }], markers: [] },
      },
    }
    expect(() => invMarkersWellFormed(p)).toThrow(InvariantError)
  })

  it('rejects an anchor on a kind that carries no source window, and markers out of t_us order', () => {
    expect(() => invMarkersWellFormed(wp({
      markers: [{ id: 'm1', t_us: 500, end_t_us: null, anchor: { layer: 'l1', src_us: 0 } }],
    }))).toThrow(InvariantError)
    expect(() => invMarkersWellFormed(withMarkers([
      { id: 'm1', t_us: 2_000_000, end_t_us: null, anchor: null },
      { id: 'm2', t_us: 500_000, end_t_us: null, anchor: null },
    ]))).toThrow(InvariantError)
  })
})
