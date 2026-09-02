// apps/desktop/src/main/state/validate.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Project, Layer, LayerParams } from './model'
import { validate } from './validate'
import { isValidationFailure } from './errors'
import { timeUsAtFrame } from './snap'
import { asRoot, root, withGroup } from './__tests__/fixtures/project'
import { applyAddLayer } from './mutations/add'

function colorLayer(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 255, g: 0, b: 0, a: 255 } }, width: 1920, height: 1080 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function audioLayer(id: string, media: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Audio', media, src_in_us: 0, src_out_us: t1 - t0, gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
const BLACK = { r: 0, g: 0, b: 0, a: 255 }
function expectRule(p: Project, rule: string) {
  try { validate(p); throw new Error(`expected ${rule}, but validate passed`) }
  catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err.rule).toBe(rule) }
}
/** Fixture times below are all CANONICAL on the blank project's 30/1 grid
 *  (multiples of 100_000 µs = 3 frames), so a fixture never trips the grid
 *  backstop while a different rule is under test. */

describe('validate', () => {
  it('passes a blank project', () => { expect(() => validate(blankProject(seededGen(), 't'))).not.toThrow() })

  it('rejects zero canvas width/height and fps', () => {
    const p = blankProject(seededGen(), 't'); root(p).width = 0; expectRule(p, 'InvalidCanvas')
    const q = blankProject(seededGen(), 't'); root(q).fps = { num: 0, den: 1 }; expectRule(q, 'InvalidFps')
  })

  it('rejects two overlapping visual layers on one track', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [colorLayer('a', 0, 1_000_000), colorLayer('b', 500_000, 1_500_000)]
    expectRule(p, 'LayerOverlap')
  })

  it('allows a visual + an audio layer to coexist on one track', () => {
    const p = blankProject(seededGen(), 't')
    p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 2_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    root(p).tracks[0].layers = [colorLayer('a', 0, 1_000_000), audioLayer('b', 'm', 0, 1_000_000)]
    expect(() => validate(p)).not.toThrow()
  })

  it('rejects a transition with an Audio participant in either seat (visual-only backstop)', () => {
    const mediaItem = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio' as const, metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' as const }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    // Audio from-layer: an otherwise-valid audio↔audio transition (overlap === duration).
    const p = blankProject(seededGen(), 't')
    p.media_pool['m'] = mediaItem
    root(p).tracks[0].layers = [audioLayer('a', 'm', 0, 1_000_000), audioLayer('b', 'm', 800_000, 1_800_000)]
    root(p).transitions = [{ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: 200_000, kind: { kind: 'Crossfade' }, extended_us: 0 }]
    try { validate(p); throw new Error('expected TransitionUnsupportedLayerKind, but validate passed') }
    catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err).toEqual({ rule: 'TransitionUnsupportedLayerKind', transition: 'tr', layer: 'a' }) }
    // Audio to-layer behind a visual from-layer.
    const q = blankProject(seededGen(), 't')
    q.media_pool['m'] = mediaItem
    root(q).tracks[0].layers = [colorLayer('a', 0, 1_000_000), audioLayer('b', 'm', 800_000, 1_800_000)]
    root(q).transitions = [{ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: 200_000, kind: { kind: 'Crossfade' }, extended_us: 0 }]
    try { validate(q); throw new Error('expected TransitionUnsupportedLayerKind, but validate passed') }
    catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err).toEqual({ rule: 'TransitionUnsupportedLayerKind', transition: 'tr', layer: 'b' }) }
  })

  it('uses the longest-reaching prior layer for the next overlap check', () => {
    // A=[0,1s) with B=[0.5s,0.8s) contained in it: a plain overlap reject — the A/B
    // pair trips LayerOverlap before C=[0.9s,1.2s) is ever reached.
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [colorLayer('a', 0, 1_000_000), colorLayer('b', 500_000, 800_000), colorLayer('c', 900_000, 1_200_000)]
    expectRule(p, 'LayerOverlap')
  })

  it('rejects an inverted layer range', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [colorLayer('a', 1_000_000, 1_000_000)]
    expectRule(p, 'InvalidLayerRange')
  })

  it('rejects a duplicate layer id across tracks', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [colorLayer('dup', 0, 100_000)]
    root(p).tracks[1].layers = [colorLayer('dup', 0, 100_000)]
    expectRule(p, 'DuplicateLayerId')
  })

  it('rejects audio referencing missing media and an invalid src range', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [audioLayer('a', 'nope', 0, 100_000)]
    expectRule(p, 'MissingMedia')
    const q = blankProject(seededGen(), 't')
    q.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: null }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    const al = audioLayer('a', 'm', 0, 100_000); (al.params as any).src_in_us = 100; (al.params as any).src_out_us = 50
    root(q).tracks[0].layers = [al]; expectRule(q, 'InvalidSrcRange')
  })

  it('rejects a link below 2 members, a missing member, and a layer in two links', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [colorLayer('a', 0, 100_000)]
    root(p).links = [{ id: 'g', members: ['a'] }]; expectRule(p, 'LinkBelowMinSize')
    const q = blankProject(seededGen(), 't'); root(q).tracks[0].layers = [colorLayer('a', 0, 100_000)]
    root(q).links = [{ id: 'g', members: ['a', 'ghost'] }]; expectRule(q, 'LinkMemberMissing')
    const r = blankProject(seededGen(), 't'); root(r).tracks[0].layers = [colorLayer('a', 0, 100_000), colorLayer('b', 200_000, 300_000)]
    root(r).links = [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['a', 'b'] }]; expectRule(r, 'LayerInMultipleLinks')
  })

  it('does NOT reject out-of-range keyframes (intentional, validate.rs:495-509)', () => {
    const p = blankProject(seededGen(), 't')
    const l = colorLayer('a', 0, 100_000)
    ;(l.params as any).color = { mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [{ id: 'k', t_us: -50_000, value: { r: 1, g: 2, b: 3, a: 4 }, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } }] }
    root(p).tracks[0].layers = [l]
    expect(() => validate(p)).not.toThrow()
  })

  it('does NOT reject an OFF-GRID keyframe time (content-glued rebases move keys by a delta)', () => {
    // The complement of the rule below: an endpoint off the grid is rejected, a
    // keyframe off the grid is not. Re-snapping a rebased key would dedupe-merge
    // colliding keys and lose authored data — see validateLayerParams.
    const p = blankProject(seededGen(), 't')
    const l = colorLayer('a', 0, 100_000)
    ;(l.params as any).color = { mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [{ id: 'k', t_us: 33_334, value: { r: 1, g: 2, b: 3, a: 4 }, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } }] }
    root(p).tracks[0].layers = [l]
    expect(() => validate(p)).not.toThrow()
  })
})

describe('validate — frame-grid backstop', () => {
  it('rejects an off-grid t_start_us / t_end_us with the offending field, time, rate and the value to retry with', () => {
    // 2_999_999 µs is 1 µs below frame 90 at 30/1.
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [colorLayer('a', 2_999_999, 4_000_000)]
    try { validate(p); throw new Error('expected OffGridLayerBoundary, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_start_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000 })
    }
    const q = blankProject(seededGen(), 't')
    root(q).tracks[0].layers = [colorLayer('a', 0, 2_999_999)]
    try { validate(q); throw new Error('expected OffGridLayerBoundary, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_end_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000 })
    }
  })

  // ── The two grids, asserted against each other ──────────────────────────────
  // Both halves in one test on purpose: a predicate that
  // accepted everything for audio, or that had quietly stayed frame-only, would pass
  // one half and fail the other.
  it('holds Audio to the 48 kHz sample lattice and visual kinds to the composition frame grid', () => {
    const audioMedia = (p: Project) => {
      p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    }
    // 29.97, where the two lattices genuinely differ: frame 1 is 33_367 µs and
    // sample 1602 is 33_375 µs, so each grid rejects the other's boundary.
    const FPS = { num: 30000, den: 1001 }
    const FRAME_1 = 33_367
    const SAMPLE_1602 = 33_375

    // Audio ACCEPTS a sample boundary the frame grid would reject...
    const ok = blankProject(seededGen(), 't')
    root(ok).fps = FPS
    root(ok).duration_us = timeUsAtFrame(2, FPS.num, FPS.den) // encloses the tail
    audioMedia(ok)
    root(ok).tracks[0].layers = [audioLayer('a', 'm', 0, SAMPLE_1602)]
    expect(() => validate(ok)).not.toThrow()

    // ...and REJECTS a frame boundary that is not a sample boundary, with the
    // lattice it was measured against named in the error.
    const bad = blankProject(seededGen(), 't')
    root(bad).fps = FPS
    root(bad).duration_us = timeUsAtFrame(2, FPS.num, FPS.den)
    audioMedia(bad)
    root(bad).tracks[0].layers = [audioLayer('a', 'm', 0, FRAME_1)]
    try { validate(bad); throw new Error('expected OffGridLayerBoundary for frame-aligned audio at 29.97') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      // `snap_to` is the OTHER constant: the two lattices are 8 µs apart here, so the
      // repair the caller is told to make lands exactly on sample 1602.
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_end_us', t: FRAME_1, fps: { num: 48_000, den: 1 }, grid: 'sample', snap_to: SAMPLE_1602 })
    }

    // A VISUAL layer is the mirror image: the frame boundary passes, the sample
    // boundary does not. This is the assertion that fails if the predicate ever
    // collapses back to one grid for both kinds.
    const vis = blankProject(seededGen(), 't')
    root(vis).fps = FPS
    root(vis).duration_us = timeUsAtFrame(2, FPS.num, FPS.den)
    root(vis).tracks[0].layers = [colorLayer('v', 0, FRAME_1)]
    expect(() => validate(vis)).not.toThrow()
    const visBad = blankProject(seededGen(), 't')
    root(visBad).fps = FPS
    root(visBad).duration_us = timeUsAtFrame(2, FPS.num, FPS.den)
    root(visBad).tracks[0].layers = [colorLayer('v', 0, SAMPLE_1602)]
    try { validate(visBad); throw new Error('expected OffGridLayerBoundary for sample-aligned video at 29.97') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      // ...and symmetrically back: the visual repair lands on frame 1.
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'v', field: 't_end_us', t: SAMPLE_1602, fps: FPS, grid: 'frame', snap_to: FRAME_1 })
    }
  })

  it('does not flag two audio layers whose edges differ by one sample as overlapping', () => {
    // The half-open `[t_start, t_end)` comparison gives this for free at 20.83 µs
    // precision — the regression exists so nobody "fixes" it with a tolerance.
    const p = blankProject(seededGen(), 't')
    root(p).fps = { num: 30000, den: 1001 }
    p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    const s = (i: number) => timeUsAtFrame(i, 48_000, 1)
    root(p).duration_us = timeUsAtFrame(1, 30000, 1001)
    // Abutting at sample 480, then one more layer starting exactly one sample later.
    root(p).tracks[0].layers = [audioLayer('a', 'm', s(0), s(480)), audioLayer('b', 'm', s(480), s(960))]
    expect(() => validate(p)).not.toThrow()
    // And a one-sample genuine overlap IS still caught.
    const q = blankProject(seededGen(), 't')
    root(q).fps = { num: 30000, den: 1001 }
    q.media_pool['m'] = p.media_pool['m']
    root(q).duration_us = timeUsAtFrame(1, 30000, 1001)
    root(q).tracks[0].layers = [audioLayer('a', 'm', s(0), s(481)), audioLayer('b', 'm', s(480), s(960))]
    expectRule(q, 'LayerOverlap')
  })

  it('accepts canonical endpoints at a fractional rate and rejects the neighbouring µs', () => {
    // At 30000/1001 frame 1 is 33_367 µs, not 33_366 — the divergence that makes a
    // hand-computed grid wrong.
    const p = blankProject(seededGen(), 't')
    root(p).fps = { num: 30000, den: 1001 }
    root(p).duration_us = 33_367
    root(p).tracks[0].layers = [colorLayer('a', 0, 33_367)]
    expect(() => validate(p)).not.toThrow()
    const q = blankProject(seededGen(), 't')
    root(q).fps = { num: 30000, den: 1001 }
    root(q).duration_us = 33_366
    root(q).tracks[0].layers = [colorLayer('a', 0, 33_366)]
    expectRule(q, 'OffGridTime') // composition duration is checked first
  })

  it('rejects a negative t_start_us as a BOUNDS failure, not an off-grid one', () => {
    // -1_000_000 is frame -30 at 30/1 — perfectly canonical, so the grid predicate
    // waves it through. This is the rule that catches it, and reporting it as
    // "off grid" instead would point the caller at the wrong fix.
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [colorLayer('a', -1_000_000, 1_000_000)]
    try { validate(p); throw new Error('expected NegativeLayerStart, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'NegativeLayerStart', layer: 'a', t_start: -1_000_000 })
    }
    // A layer starting exactly at 0 is fine — the bound is inclusive.
    const q = blankProject(seededGen(), 't')
    root(q).tracks[0].layers = [colorLayer('a', 0, 1_000_000)]
    expect(() => validate(q)).not.toThrow()
  })

  it('rejects an off-grid composition.duration_us', () => {
    const p = blankProject(seededGen(), 't')
    root(p).duration_us = 2_999_999
    try { validate(p); throw new Error('expected OffGridTime, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridTime', entity: 'Composition', id: p.root_id, field: 'duration_us', t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000 })
    }
  })

  it('rejects an off-grid marker t_us / end_t_us', () => {
    const p = blankProject(seededGen(), 't')
    root(p).markers = [{ id: 'mk', t_us: 2_999_999, end_t_us: null, label: 'm', note: '', color: { r: 0, g: 0, b: 0, a: 255 }, anchor: null }]
    try { validate(p); throw new Error('expected OffGridTime, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridTime', entity: 'Marker', id: 'mk', field: 't_us', t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000 })
    }
    const q = blankProject(seededGen(), 't')
    root(q).markers = [{ id: 'mk', t_us: 0, end_t_us: 2_999_999, label: 'm', note: '', color: { r: 0, g: 0, b: 0, a: 255 }, anchor: null }]
    expectRule(q, 'OffGridTime')
  })

  it('does NOT require transition.duration_us to be a canonical time (it is a distance)', () => {
    // At 30000/1001 a 1-frame transition at cut frame 1 is 33_366 µs — off the
    // grid as an absolute time, exactly right as a distance. Both endpoints are
    // canonical and overlap === duration_us, so validate must accept it.
    const p = blankProject(seededGen(), 't')
    root(p).fps = { num: 30000, den: 1001 }
    const cut = 33_367            // frame 1
    const fromEnd = 66_733        // frame 2
    root(p).duration_us = 100_100 // frame 3
    root(p).tracks[0].layers = [colorLayer('a', 0, fromEnd), colorLayer('b', cut, 100_100)]
    root(p).transitions = [{ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: fromEnd - cut, kind: { kind: 'Crossfade' }, extended_us: 0 }]
    expect(fromEnd - cut).toBe(33_366) // NOT a canonical time
    expect(() => validate(p)).not.toThrow()
  })

  it('reports every endpoint as on-grid under a degenerate rate (InvalidFps owns that project)', () => {
    const p = blankProject(seededGen(), 't')
    root(p).fps = { num: 0, den: 1 }
    root(p).tracks[0].layers = [colorLayer('a', 2_999_999, 4_000_001)]
    expectRule(p, 'InvalidFps')
  })
})

// ── The composition container (ADR 0052 §3–§6) ───────────────────────────────
describe('validate — compositions', () => {
  const twoComps = () => {
    const gen = seededGen()
    return { gen, ...withGroup(blankProject(gen, 't'), gen, (g, view) => applyAddLayer(view, gen, g.tracks[0].id, colorLayer('gl', 0, 1_000_000).params, 0, 1_000_000)) }
  }

  it('passes a root + Group project, and a Group with layers of its own', () => {
    const { p } = twoComps()
    expect(Object.keys(p.compositions)).toHaveLength(2)
    expect(() => validate(p)).not.toThrow()
  })
  it('CompositionCycle: A → B → A is refused, naming the loop', () => {
    const { p, gen, groupId } = twoComps()
    // the Group references the root's OTHER Group… make a second Group that the
    // first references, and have the second reference the first.
    const second = withGroup(p, gen)
    const g1 = second.p.compositions[groupId]
    const g2 = second.p.compositions[second.groupId]
    applyAddLayer(asRoot(second.p, g1), gen, g1.tracks[1].id, { kind: 'CompositionRef', composition: g2.id, src_in_us: 0, src_out_us: 1_000_000, transform: textTransform(), opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal' }, 0, 1_000_000)
    applyAddLayer(asRoot(second.p, g2), gen, g2.tracks[0].id, { kind: 'CompositionRef', composition: g1.id, src_in_us: 0, src_out_us: 1_000_000, transform: textTransform(), opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal' }, 0, 1_000_000)
    try { validate(second.p); throw new Error('expected CompositionCycle') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err.rule).toBe('CompositionCycle')
      if (e.err.rule === 'CompositionCycle') {
        expect(e.err.path[0]).toBe(e.err.path[e.err.path.length - 1])
        expect(new Set(e.err.path)).toEqual(new Set([g1.id, g2.id]))
      }
    }
  })
  it('CompositionLatticeMismatch: a 25 fps Group under a 30 fps root; 60/2 under 30/1 is the same rate', () => {
    const { p, groupId } = twoComps()
    const q = structuredClone(p)
    q.compositions[groupId].fps = { num: 25, den: 1 }
    try { validate(q); throw new Error('expected CompositionLatticeMismatch') }
    catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err).toEqual({ rule: 'CompositionLatticeMismatch', composition: groupId, field: 'fps' }) }
    const r = structuredClone(p)
    r.compositions[groupId].fps = { num: 60, den: 2 }
    expect(() => validate(r)).not.toThrow()
    const s = structuredClone(p)
    s.compositions[groupId].sample_rate = 44_100
    expectRule(s, 'CompositionLatticeMismatch')
    const t = structuredClone(p)
    t.compositions[groupId].channels = 1
    expectRule(t, 'CompositionLatticeMismatch')
  })
  it('tolerates src_out_us past the referenced composition\'s duration (overhang, ADR 0052 §6)', () => {
    const { p, refLayerId, groupId } = twoComps()
    const ref = root(p).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!
    expect(ref.params.kind).toBe('CompositionRef')
    if (ref.params.kind !== 'CompositionRef') return
    ref.params.src_out_us = p.compositions[groupId].duration_us + 10_000_000
    expect(() => validate(p)).not.toThrow()
    // …but the window itself must still be well-formed.
    ref.params.src_in_us = ref.params.src_out_us
    expectRule(p, 'InvalidSrcRange')
  })
  it('DuplicateLayerId spans compositions', () => {
    const { p, groupId } = twoComps()
    const rootLayer = root(p).tracks.flatMap((t) => t.layers)[0]
    p.compositions[groupId].tracks[1].layers = [colorLayer(rootLayer.id, 0, 1_000_000)]
    expectRule(p, 'DuplicateLayerId')
  })
  it('DuplicateMarkerId spans compositions', () => {
    const { p, groupId } = twoComps()
    const m = { id: 'mk', t_us: 0, end_t_us: null, label: 'm', note: '', color: { r: 0, g: 0, b: 0, a: 255 }, anchor: null }
    root(p).markers = [structuredClone(m)]
    p.compositions[groupId].markers = [structuredClone(m)]
    expectRule(p, 'DuplicateMarkerId')
  })
  // An anchor is checked against ONE composition's own layer set, exactly as
  // link members are: the two timelines share no origin, so no `t_us` could be
  // derived from a tie that crosses one.
  it('MarkerAnchorNotInComposition: an anchor may not reach into another composition', () => {
    const { p, groupId } = twoComps()
    const groupLayer = p.compositions[groupId].tracks.flatMap((t) => t.layers)[0]
    root(p).markers = [{ id: 'mk', t_us: 0, end_t_us: null, label: 'm', note: '', color: BLACK, anchor: { layer: groupLayer.id, src_us: 0 } }]
    expectRule(p, 'MarkerAnchorNotInComposition')
  })
  // The derivation reads `params.src_in_us`, so a kind that has none cannot
  // carry an anchor at all — refused as unrepresentable, not tolerated as inert.
  it('MarkerAnchorLayerHasNoSourceWindow: a Color layer cannot be anchored to', () => {
    const { p, groupId } = twoComps()
    const colorLayerId = p.compositions[groupId].tracks.flatMap((t) => t.layers)[0].id
    p.compositions[groupId].markers = [{ id: 'mk', t_us: 0, end_t_us: null, label: 'm', note: '', color: BLACK, anchor: { layer: colorLayerId, src_us: 0 } }]
    expectRule(p, 'MarkerAnchorLayerHasNoSourceWindow')
  })
  // HIBERNATING is a legal state, not a broken project: a trim that pushes
  // `src_us` out of the window must not make the project unopenable, because the
  // marker is exactly what un-trimming brings back.
  it('accepts an anchor whose src_us is outside the layer window (hibernating)', () => {
    const { p, refLayerId } = twoComps()
    const params = root(p).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!.params as { src_out_us: number }
    root(p).markers = [{ id: 'mk', t_us: 0, end_t_us: null, label: 'm', note: '', color: BLACK, anchor: { layer: refLayerId, src_us: params.src_out_us + 10_000_000 } }]
    expect(() => validate(p)).not.toThrow()
  })
  it('LinkMemberMissing: a link may not reach into another composition', () => {
    const { p, groupId } = twoComps()
    const groupLayer = p.compositions[groupId].tracks[0].layers[0]
    const rootLayer = root(p).tracks.flatMap((t) => t.layers)[0]
    root(p).links = [{ id: 'g', members: [groupLayer.id, rootLayer.id].sort() }]
    expectRule(p, 'LinkMemberMissing')
  })
  it('CompositionMissing / RootReferenced / RootMissing / CompositionIdMismatch', () => {
    const { p, refLayerId } = twoComps()
    const ref = () => root(p).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!.params as Extract<LayerParams, { kind: 'CompositionRef' }>
    const q = structuredClone(p); (root(q).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!.params as Extract<LayerParams, { kind: 'CompositionRef' }>).composition = 'ghost'
    expectRule(q, 'CompositionMissing')
    const r = structuredClone(p); (root(r).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!.params as Extract<LayerParams, { kind: 'CompositionRef' }>).composition = r.root_id
    expectRule(r, 'RootReferenced')
    const s = structuredClone(p); s.root_id = 'ghost'
    expectRule(s, 'RootMissing')
    const t = structuredClone(p); t.compositions['other'] = t.compositions[ref().composition]
    expectRule(t, 'CompositionIdMismatch')
  })
  it('an orphan composition is legal', () => {
    const { p, refLayerId } = twoComps()
    for (const t of root(p).tracks) t.layers = t.layers.filter((l) => l.id !== refLayerId)
    expect(() => validate(p)).not.toThrow()
  })
})

function textTransform(): Extract<LayerParams, { kind: 'Text' }>['transform'] {
  const s = (v: number) => ({ mode: 'Static' as const, value: v })
  return { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor_x: s(0.5), anchor_y: s(0.5), scale_linked: true }
}
