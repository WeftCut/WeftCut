// apps/desktop/src/main/state/validate.backstops.test.ts
//
// What only a hand-edited file or a writer bug can reach: no ordinary edit
// produces these states, so nothing but this file notices if a backstop stops
// firing. Each case states the whole error, because a neighbouring rule often
// catches the same corruption under another name.
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, type Layer, type LayerParams, type Project, type Transition } from './model'
import { validate } from './validate'
import { isCommandFailure, isValidationFailure } from './errors'
import { defaultTransform, textParamsDefault } from './mutations/add'
import { mkComposition, root, withGroup } from './__tests__/fixtures/project'

const MEDIA = 'media-1'
const MEDIA_US = 10_000_000
const stat = <T,>(value: T) => ({ mode: 'Static' as const, value })

function project(): Project {
  const p = blankProject(seededGen(), 't')
  p.media_pool[MEDIA] = { id: MEDIA, label: null, path_abs: '/x', path_rel: null, kind: 'Video', metadata: { duration_us: MEDIA_US }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
  return p
}
function layer(id: string, t0: number, t1: number, params: unknown): Layer {
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params: params as LayerParams, effects: [] }
}
const visualFields = () => ({ transform: defaultTransform(), opacity: stat(1) })
const colorParams = (over: object = {}) => ({ kind: 'Color', color: stat({ r: 0, g: 0, b: 0, a: 255 }), width: 1, height: 1, ...over })
const textParams = (over: object = {}) => ({ ...textParamsDefault('hello', { width: 1920, height: 1080 }), graphic_role: null, ...over })
const imageParams = (over: object = {}) => ({ kind: 'ImageOverlay', media: MEDIA, ...visualFields(), graphic_role: null, ...over })
const motifParams = (over: object = {}) => ({ kind: 'Motif', ...visualFields(), graphic_role: null, ...over })
const videoParams = (over: object = {}) => ({ kind: 'VideoClip', media: MEDIA, src_in_us: 0, src_out_us: 1_000_000, ...visualFields(), crop: null, flip_h: false, flip_v: false, blend_mode: 'Normal', fade_in_us: 0, fade_out_us: 0, ...over })
const audioParams = (over: object = {}) => ({ kind: 'Audio', media: MEDIA, src_in_us: 0, src_out_us: 1_000_000, gain_db: stat(0), pan: stat(0), fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music', ...over })
const color = (id: string, t0: number, t1: number) => layer(id, t0, t1, colorParams())

function withLayers(...layers: Layer[]): Project {
  const p = project()
  root(p).tracks[0].layers = layers
  return p
}
const withParams = (params: unknown) => withLayers(layer('l', 0, 1_000_000, params))

function validationError(p: Project): unknown {
  try { validate(p) } catch (e) { if (isValidationFailure(e)) return e.err; throw e }
  throw new Error('validate passed')
}
function commandError(p: Project): unknown {
  try { validate(p) } catch (e) { if (isCommandFailure(e)) return e.err; throw e }
  throw new Error('validate passed')
}
const timing = (detail: string) => ({ error: 'InvalidArgument', field: 'timing', detail })

describe('validate: a transition\'s structural rules', () => {
  const tr = (over: Partial<Transition> = {}): Transition => ({ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: 200_000, kind: { kind: 'Crossfade' }, extended_us: 0, ...over })
  const pair = (...transitions: Transition[]) => {
    const p = withLayers(color('a', 0, 1_000_000), color('b', 800_000, 1_800_000), color('c', 800_000, 1_800_000))
    root(p).transitions = transitions
    return p
  }

  it('a repeated id', () => {
    expect(validationError(pair(tr(), tr()))).toEqual({ rule: 'DuplicateTransitionId', transition: 'tr' })
  })
  it('a layer transitioning into itself', () => {
    expect(validationError(pair(tr({ to_layer: 'a' })))).toEqual({ rule: 'TransitionSelfReference', transition: 'tr', layer: 'a' })
  })
  it('a borrowed tail outside [0, duration]; both ends of the range are legal', () => {
    for (const extended_us of [-1, 200_001, Number.NaN])
      expect(validationError(pair(tr({ extended_us })))).toEqual({ rule: 'TransitionExtendedOutOfRange', transition: 'tr', extended: extended_us, duration: 200_000 })
    for (const extended_us of [0, 200_000]) {
      const p = withLayers(color('a', 0, 1_000_000), color('b', 800_000, 1_800_000))
      root(p).transitions = [tr({ extended_us })]
      expect(() => validate(p)).not.toThrow()
    }
  })
  it('a layer in two transitions, in either seat', () => {
    expect(validationError(pair(tr(), tr({ id: 'tr2', to_layer: 'c' })))).toEqual({ rule: 'LayerInMultipleTransitions', layer: 'a' })
    const p = withLayers(color('a', 0, 1_000_000), color('c', 0, 1_000_000), color('b', 800_000, 1_800_000))
    root(p).transitions = [tr(), tr({ id: 'tr2', from_layer: 'c' })]
    expect(validationError(p)).toEqual({ rule: 'LayerInMultipleTransitions', layer: 'b' })
  })
  it('a duration longer than either participant, measured off its span and not its position', () => {
    const shortFrom = withLayers(color('a', 800_000, 1_000_000), color('b', 800_000, 1_800_000))
    root(shortFrom).transitions = [tr({ duration_us: 300_000 })]
    expect(validationError(shortFrom)).toEqual({ rule: 'TransitionDurationOutOfRange', transition: 'tr', duration: 300_000 })
    const shortTo = withLayers(color('a', 0, 1_000_000), color('b', 800_000, 1_000_000))
    root(shortTo).transitions = [tr({ duration_us: 300_000 })]
    expect(validationError(shortTo)).toEqual({ rule: 'TransitionDurationOutOfRange', transition: 'tr', duration: 300_000 })
  })
  it('a duration exactly as long as a participant is in range', () => {
    const p = withLayers(color('a', 800_000, 1_000_000), color('b', 800_000, 1_800_000))
    root(p).transitions = [tr()]
    expect(() => validate(p)).not.toThrow()
  })
})

describe('validate: a composition\'s lattice and markers', () => {
  it('names the field of a Group that disagrees with the root', () => {
    const gen = seededGen()
    const { p, groupId } = withGroup(blankProject(gen, 't'), gen)
    const rate = structuredClone(p); rate.compositions[groupId].sample_rate = 44_100
    expect(validationError(rate)).toEqual({ rule: 'CompositionLatticeMismatch', composition: groupId, field: 'sample_rate' })
    const channels = structuredClone(p); channels.compositions[groupId].channels = 1
    expect(validationError(channels)).toEqual({ rule: 'CompositionLatticeMismatch', composition: groupId, field: 'channels' })
  })
  it('compares frame rates as ratios when both denominators differ from 1', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    root(p).fps = { num: 30_000, den: 1001 }
    const group = mkComposition(gen, { fps: { num: 60_000, den: 2002 }, sample_rate: root(p).sample_rate, channels: root(p).channels })
    p.compositions[group.id] = group
    expect(() => validate(p)).not.toThrow()
  })
  it('names the off-grid end of a marker region, and accepts every spelling of "no end" and "no anchor"', () => {
    const p = project()
    const marker = { id: 'm', label: '', color: null, notes: '', t_us: 0, end_t_us: 1, anchor: null }
    root(p).markers = [marker as never]
    expect(validationError(p)).toMatchObject({ rule: 'OffGridTime', entity: 'Marker', id: 'm', field: 'end_t_us', t: 1, snap_to: 0 })
    root(p).markers = [{ ...marker, end_t_us: null } as never, { ...marker, id: 'm2', end_t_us: undefined, anchor: undefined } as never]
    expect(() => validate(p)).not.toThrow()
  })
})

describe('validate: a clip\'s source window', () => {
  const exact = (num: number, den: number) => ({ num, den })

  it('refuses an inverted or empty window by name, on every kind that has one', () => {
    for (const params of [videoParams({ src_in_us: 5, src_out_us: 5 }), audioParams({ src_in_us: 5, src_out_us: 5 })])
      expect(validationError(withParams(params))).toEqual({ rule: 'InvalidSrcRange', layer: 'l', src_in: 5, src_out: 5 })
    expect(validationError(withParams(videoParams({ src_in_us: -5 })))).toEqual({ rule: 'InvalidSrcRange', layer: 'l', src_in: -5, src_out: 1_000_000 })
    expect(validationError(withParams(imageParams({ content_window: { in_us: 5, out_us: 5 } })))).toEqual({ rule: 'InvalidSrcRange', layer: 'l', src_in: 5, src_out: 5 })
    const gen = seededGen()
    const { p, refLayerId } = withGroup(blankProject(gen, 't'), gen)
    const ref = root(p).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!
    Object.assign(ref.params, { src_in_us: 9, src_out_us: 9 })
    expect(validationError(p)).toEqual({ rule: 'InvalidSrcRange', layer: refLayerId, src_in: 9, src_out: 9 })
  })
  it('refuses a window past the media, by its exact end, on both media kinds', () => {
    for (const make of [videoParams, audioParams]) {
      expect(validationError(withParams(make({ src_out_us: MEDIA_US + 1 })))).toEqual({ rule: 'SrcRangeExceedsMedia', layer: 'l', src_in: 0, src_out: MEDIA_US + 1, media_duration: MEDIA_US })
      // A quarter microsecond over: the comparison is exact, not rounded to whole µs.
      expect(validationError(withParams(make({ src_out_us: MEDIA_US, source_phase: { in: exact(0, 1), out: exact(1, 4) } })))).toMatchObject({ rule: 'SrcRangeExceedsMedia', layer: 'l', media_duration: MEDIA_US })
      expect(() => validate(withParams(make({ src_out_us: MEDIA_US })))).not.toThrow()
    }
  })
  it('accepts any window on media of unknown length', () => {
    for (const duration_us of [null, undefined]) {
      const p = withParams(videoParams({ src_out_us: MEDIA_US * 2 }))
      p.media_pool[MEDIA].metadata = { duration_us } as never
      expect(() => validate(p)).not.toThrow()
    }
  })
})

describe('validate: timing fields', () => {
  const badFraction = { num: 3, den: 2 }
  const goodFraction = { num: 1, den: 2 }

  it('refuses each malformed field on a timed clip', () => {
    expect(commandError(withParams(videoParams({ time_map: { kind: 'Bogus' } })))).toEqual(timing('UnknownTimeMap'))
    for (const [field, side] of [['source_phase', 'in'], ['source_phase', 'out'], ['fade_phase', 'in'], ['fade_phase', 'out']] as const) {
      const phase = { in: goodFraction, out: goodFraction, [side]: badFraction }
      expect(commandError(withParams(videoParams({ src_out_us: 2_000_000, [field]: phase })))).toEqual(timing('NonCanonical'))
    }
    expect(commandError(withParams(videoParams({ preserve_pitch: 'yes' })))).toEqual(timing('InvalidNumber'))
    expect(commandError(withParams(audioParams({ preserve_pitch: 1 })))).toEqual(timing('InvalidNumber'))
    expect(commandError(withParams(videoParams({ frame_interpolation: { kind: 'OpticalFlow' } })))).toEqual({ error: 'InvalidArgument', field: 'frame_interpolation', detail: 'This build supports FrameSampling only' })
  })
  it('accepts the same fields well formed', () => {
    const params = videoParams({ src_out_us: 2_000_000, time_map: { kind: 'Affine', rate: { num: 2, den: 1 } }, source_phase: { in: goodFraction, out: goodFraction }, fade_phase: { in: goodFraction, out: goodFraction }, preserve_pitch: false, frame_interpolation: { kind: 'FrameSampling' } })
    expect(() => validate(withParams(params))).not.toThrow()
  })
  it('does not read a clip clock on the kinds that have none', () => {
    const bogus = { time_map: { kind: 'Bogus' }, source_phase: { in: badFraction, out: badFraction }, frame_interpolation: { kind: 'OpticalFlow' } }
    expect(() => validate(withParams(colorParams(bogus)))).not.toThrow()
    expect(() => validate(withParams(textParams(bogus)))).not.toThrow()
  })
  it('refuses a malformed keyframe time on every animated track a layer carries', () => {
    const keyed = (time_fraction: unknown, t_us = 0) => ({ mode: 'Keyframed', value: [{ t_us, value: 1, time_fraction }] })
    expect(commandError(withParams(videoParams({ opacity: keyed(badFraction) })))).toEqual(timing('NonCanonical'))
    expect(commandError(withParams(audioParams({ gain_db: keyed(badFraction) })))).toEqual(timing('NonCanonical'))
    expect(commandError(withParams(colorParams({ color: keyed(badFraction) })))).toEqual(timing('NonCanonical'))
    const effect = layer('l', 0, 1_000_000, colorParams())
    effect.effects = [{ params: { amount: keyed(badFraction) } } as never]
    expect(commandError(withLayers(effect))).toEqual(timing('NonCanonical'))
    expect(() => validate(withParams(videoParams({ opacity: keyed(goodFraction) })))).not.toThrow()
    expect(() => validate(withParams(videoParams({ opacity: keyed(undefined) })))).not.toThrow()
  })
  it('refuses a keyframe time that is not a whole number before its fraction', () => {
    const params = videoParams({ opacity: { mode: 'Keyframed', value: [{ t_us: 0.5, value: 1 }] } })
    expect(commandError(withParams(params))).toMatchObject({ error: 'InvalidArgument', field: 'timing' })
  })
})

describe('validate: fields one kind owns', () => {
  it('a VideoClip\'s crop, and only a VideoClip\'s', () => {
    const bad = { x: 0, y: 0, w: 2, h: 1 }
    expect(commandError(withParams(videoParams({ crop: bad })))).toMatchObject({ error: 'InvalidArgument', field: 'crop', detail: expect.stringContaining('positive rectangle') })
    expect(() => validate(withParams(videoParams({ crop: { x: 0, y: 0, w: 0.5, h: 0.5 } })))).not.toThrow()
    expect(() => validate(withParams(videoParams({ crop: null })))).not.toThrow()
    expect(() => validate(withParams(colorParams({ crop: bad })))).not.toThrow()
  })
  it('a graphic_role on the three kinds that carry one, and on no other', () => {
    for (const make of [textParams, imageParams, motifParams]) {
      expect(commandError(withParams(make({ graphic_role: 'Not A Role' })))).toMatchObject({ error: 'InvalidArgument', field: 'graphic_role', detail: expect.stringContaining('graphic_role must be') })
      expect(() => validate(withParams(make({ graphic_role: 'lower_third' })))).not.toThrow()
    }
    expect(() => validate(withParams(colorParams({ graphic_role: 'Not A Role' })))).not.toThrow()
    expect(() => validate(withParams(videoParams({ graphic_role: 'Not A Role' })))).not.toThrow()
  })
  it('an ImageOverlay\'s media must exist', () => {
    expect(validationError(withParams(imageParams({ media: 'nope' })))).toEqual({ rule: 'MissingMedia', layer: 'l', media: 'nope' })
  })
})

describe('validate: a track and its links', () => {
  it('reads a lane in time order, not stored order', () => {
    expect(() => validate(withLayers(color('later', 1_000_000, 2_000_000), color('earlier', 0, 1_000_000)))).not.toThrow()
  })
  it('a repeated link id', () => {
    const p = withLayers(color('a', 0, 100_000), color('b', 100_000, 200_000), color('c', 200_000, 300_000), color('d', 300_000, 400_000))
    root(p).links = [{ id: 'link', members: ['a', 'b'] }, { id: 'link', members: ['c', 'd'] }]
    expect(validationError(p)).toEqual({ rule: 'DuplicateLinkId', link: 'link' })
  })
})

describe('validate: the reference graph', () => {
  const refParams = (composition: string, over: object = {}) => ({ kind: 'CompositionRef', composition, src_in_us: 0, src_out_us: 1_000_000, ...visualFields(), ...over })
  function graph(edges: Record<string, string[]>, over: object = {}) {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const s = root(p)
    const ids: Record<string, string> = { root: s.id }
    for (const name of Object.keys(edges)) if (name !== 'root') {
      const c = mkComposition(gen, { fps: s.fps, sample_rate: s.sample_rate, channels: s.channels })
      p.compositions[c.id] = c
      ids[name] = c.id
    }
    let n = 0
    for (const [name, targets] of Object.entries(edges))
      p.compositions[ids[name]].tracks[0].layers = targets.map((t, i) => layer(`ref${n++}`, i * 1_000_000, (i + 1) * 1_000_000, refParams(ids[t], over)))
    return { p, ids }
  }

  it('a chain that reaches one composition twice is not a loop', () => {
    const { p } = graph({ root: ['a', 'b'], a: ['d'], b: ['d'], d: [] })
    expect(() => validate(p)).not.toThrow()
  })
  it('a loop is reported from its own start, without the branches walked before it', () => {
    const { p, ids } = graph({ root: [], a: ['b', 'c'], b: [], c: ['a'] })
    expect(validationError(p)).toEqual({ rule: 'CompositionCycle', path: [ids.a, ids.c, ids.a] })
  })
  it('a clock nested past what exact arithmetic can hold is refused by name', () => {
    const huge = { time_map: { kind: 'Affine', rate: { num: Number.MAX_SAFE_INTEGER, den: 1 } } }
    const { p } = graph({ root: ['a'], a: ['b'], b: [] }, huge)
    expect(commandError(p)).toMatchObject({ error: 'RetimeRejected', reason: { kind: 'Numeric' } })
  })
})
