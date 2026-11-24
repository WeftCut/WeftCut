// Every layer edge, Audio's included, sits on the composition frame grid, and audio
// sample precision lives in the source window (ADR 0038). The 48 kHz lattice is
// still where a slip is counted, where audio automation keys sit, and the unit the
// mixer plays in, so these tests read both lattices.
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { createActor } from '../actor'
import { parseProject, serializeProject, type GridRepair } from '../serialize'
import { serializeProjectToJson } from '../persistence'
import { AUDIO_GRID, frameGrid, gridIndex, isCanonicalOnGrid, snapFrameRound, timeUsAtGridIndex } from '../snap'
import { nudgedSource, syncOffsetSamples, type SlipLayer } from '../../../renderer/timeline/audioSlip'
import { root } from './fixtures/project'
import { layerParamsView } from '../summary'

// 29.97 is the discriminating rate: 48000 * 1001/30000 = 1601.6 samples per frame, so
// the frame lattice is NOT a sublattice of the 48 kHz one and an audio edge written
// on samples is off the frame grid. At 24/25/30/50/60 and 23.976 the ratio IS an
// integer (2000/1920/1600/960/800/2002), so no test there can tell the two apart.
const FPS = { num: 30_000, den: 1001 }
const AV_MEDIA = 'audio-grid-av'
const MEDIA_US = 10_000_000
/** Where both members start reading, far enough in that a slip either way stays
 *  inside the media. */
const SRC_IN = 1_000_000

/** Canonical µs of sample index `i` — the mixer's own lattice. */
const sample = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID)
/** Canonical µs of composition frame `i` at 29.97. */
const frame = (i: number) => timeUsAtGridIndex(i, frameGrid(FPS))
const onFrames = (t: number) => isCanonicalOnGrid(t, frameGrid(FPS))

/** The first frame index at or after `from` whose canonical µs is NOT a sample
 *  boundary. LANDMINE for anyone hand-picking fixture times: at 29.97 one frame is
 *  1601.6 samples, so every FIFTH frame lands exactly on the 48 kHz lattice
 *  (1601.6 × 5 = 8008). A round multiple of 5 — frame 30, frame 90 — would make every
 *  "the two grids differ" assertion below silently vacuous. Derived, not assumed. */
function offSampleFrame(from: number): number {
  for (let i = from; i < from + 16; i++) {
    if (snapFrameRound(frame(i), AUDIO_GRID.num, AUDIO_GRID.den) !== frame(i)) return i
  }
  throw new Error('no frame off the sample lattice — the fixture rate is not discriminating')
}
// Resolved lazily: every grid primitive is wasm-backed and `initEval()` runs in the
// suite's beforeAll, so a module-level call would fire before the wasm exists.
let vStart = 0
let vMove = 0
const V_START_FRAME = () => (vStart ||= offSampleFrame(30))
const V_MOVE_FRAME = () => (vMove ||= offSampleFrame(90))

interface Fixture {
  actor: ReturnType<typeof createActor>
  videoLayer: string
  audioLayer: string
  videoTrack: string
  audioTrack: string
}

/** A linked picture/sound pair of ONE recording, on separate tracks, both reading
 *  the media from `SRC_IN`. */
function pairedFixture(): Fixture {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'audio-grid')
  root(initial).fps = FPS
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  actor.dispatch('add_media', { id: AV_MEDIA, kind: 'Video', duration_us: MEDIA_US, with_audio: true })
  const [videoTrack, audioTrack] = root(actor.snapshot()).tracks.map((t) => t.id)
  const at = frame(V_START_FRAME())
  const v = actor.dispatch('add_layer', { track: videoTrack, kind: 'video', media: AV_MEDIA, src_in_us: SRC_IN, src_out_us: SRC_IN + 2_000_000, t_start_us: at, t_end_us: at + 2_000_000 })
  const a = actor.dispatch('add_layer', { track: audioTrack, kind: 'audio', media: AV_MEDIA, src_in_us: SRC_IN, src_out_us: SRC_IN + 2_000_000, t_start_us: at, t_end_us: at + 2_000_000 })
  expect([v.ok, a.ok]).toEqual([true, true])
  const videoLayer = v.ok ? (v.value as string) : ''
  const audioLayer = a.ok ? (a.value as string) : ''
  expect(actor.dispatch('links_create', { layers: [videoLayer, audioLayer], label: null, reassign: false }).ok).toBe(true)
  return { actor, videoLayer, audioLayer, videoTrack, audioTrack }
}

const stateOf = (f: Fixture): Project => f.actor.snapshot()
const findLayer = (p: Project, id: string): Layer => root(p).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!

/** A model layer as the timeline's summary row carries it, through the summary's
 *  own `layerParamsView`, so the slip helpers read the shape they get in the app. */
function slipLayer(l: Layer, p: Project): SlipLayer {
  return { id: l.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us, kind: l.params.kind, params: layerParamsView(l.params, p.media_pool) }
}

const srcIn = (l: Layer) => (l.params as { src_in_us: number }).src_in_us
const srcOut = (l: Layer) => (l.params as { src_out_us: number }).src_out_us

/** The mix sample the layer's source time 0 lands on: the mixer reads source sample
 *  `n - this` at timeline sample `n`, so two states with the same value play every
 *  sample at the same instant. */
const mixOrigin = (l: Layer) => gridIndex(l.t_start_us, AUDIO_GRID) - gridIndex(srcIn(l), AUDIO_GRID)

/** Slip the audio layer's sound `samples` later through the command the nudge sends. */
function slip(f: Fixture, samples: number): void {
  const snap = f.actor.snapshot()
  const next = nudgedSource(slipLayer(findLayer(snap, f.audioLayer), snap), samples)
  expect(next).not.toBeNull()
  expect(f.actor.dispatch('update_layer_params', { layer: f.audioLayer, patch: { kind: 'Audio', ...next! } }).ok).toBe(true)
}

function offsetOf(p: Project, f: Fixture): number | null {
  return syncOffsetSamples(slipLayer(findLayer(p, f.audioLayer), p), [slipLayer(findLayer(p, f.videoLayer), p), slipLayer(findLayer(p, f.audioLayer), p)])
}

describe('audio grid — edges on frames, precision in the source', () => {
  it('the authoring index IS the mixer sample index (leaf twin, not a parallel implementation)', () => {
    // `gridIndex(us, AUDIO_GRID)` is `frame_index_round(us, 48000, 1)`, and the mixer
    // uses `us_to_frame(us, 48000)`. Both reduce to `(us*48000 + 500000)/1000000` in
    // the leaf, so a one-sample slip is exactly one mix sample rather than
    // approximately one.
    for (const us of [0, 1, 17, 20_833, 33_367, 1_000_000, 3_600_000_000]) {
      expect(gridIndex(us, AUDIO_GRID)).toBe(Math.floor((us * 48 + 500) / 1000))
    }
    // And the inverse is distinct + invertible at ~20.83 µs spacing, so µs storage
    // represents the lattice exactly.
    for (let i = 0; i < 1000; i++) {
      expect(gridIndex(sample(i), AUDIO_GRID)).toBe(i)
      if (i > 0) expect(sample(i)).toBeGreaterThan(sample(i - 1))
    }
  })

  it('at 29.97 the two lattices genuinely differ (else every assertion below is vacuous)', () => {
    expect(snapFrameRound(frame(1), AUDIO_GRID.num, AUDIO_GRID.den)).not.toBe(frame(1))
    expect(snapFrameRound(sample(1602), FPS.num, FPS.den)).not.toBe(sample(1602))
  })

  it('an audio layer asked for a sample time lands on the nearest frame, moved or trimmed', () => {
    const { actor, audioLayer, audioTrack } = pairedFixture()

    const target = sample(gridIndex(frame(V_MOVE_FRAME()), AUDIO_GRID) + 7)
    expect(onFrames(target)).toBe(false)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: target, escape_link: true }).ok).toBe(true)
    expect(findLayer(actor.snapshot(), audioLayer).t_start_us).toBe(snapFrameRound(target, FPS.num, FPS.den))

    const outEdge = findLayer(actor.snapshot(), audioLayer).t_end_us
    const trimTo = sample(gridIndex(outEdge, AUDIO_GRID) - 7)
    expect(onFrames(trimTo)).toBe(false)
    expect(actor.dispatch('trim_layer', { layer: audioLayer, edge: 'out', new_t_us: trimTo, escape_link: true }).ok).toBe(true)
    expect(findLayer(actor.snapshot(), audioLayer).t_end_us).toBe(snapFrameRound(trimTo, FPS.num, FPS.den))
  })

  it('a linked pair shares its edges exactly, and a whole-link move keeps them shared', () => {
    const { actor, videoLayer, audioLayer, videoTrack } = pairedFixture()
    const edges = (p: Project, id: string) => [findLayer(p, id).t_start_us, findLayer(p, id).t_end_us]
    expect(edges(actor.snapshot(), audioLayer)).toEqual(edges(actor.snapshot(), videoLayer))

    expect(actor.dispatch('move_layer', { layer: videoLayer, to_track: videoTrack, t_start_us: frame(V_MOVE_FRAME()), escape_link: false }).ok).toBe(true)
    const after = actor.snapshot()
    expect(edges(after, videoLayer)[0]).toBe(frame(V_MOVE_FRAME()))
    expect(edges(after, audioLayer)).toEqual(edges(after, videoLayer))
  })

  it('a one-sample nudge slips the audio source under fixed edges; the picture is untouched', () => {
    const f = pairedFixture()
    const before = stateOf(f)
    expect(offsetOf(before, f)).toBe(0)

    slip(f, 1)
    const after = stateOf(f)
    const audioBefore = findLayer(before, f.audioLayer)
    const audioAfter = findLayer(after, f.audioLayer)
    expect([audioAfter.t_start_us, audioAfter.t_end_us]).toEqual([audioBefore.t_start_us, audioBefore.t_end_us])
    expect(gridIndex(srcIn(audioAfter), AUDIO_GRID)).toBe(gridIndex(srcIn(audioBefore), AUDIO_GRID) - 1)
    expect(mixOrigin(audioAfter)).toBe(mixOrigin(audioBefore) + 1)
    expect(offsetOf(after, f)).toBe(1)
    expect(findLayer(after, f.videoLayer)).toEqual(findLayer(before, f.videoLayer))
  })

  it('a whole-link move carries a slip exactly: the source window rides along unchanged', () => {
    const f = pairedFixture()
    slip(f, 7)
    const before = stateOf(f)
    expect(f.actor.dispatch('move_layer', { layer: f.videoLayer, to_track: f.videoTrack, t_start_us: frame(V_MOVE_FRAME()), escape_link: false }).ok).toBe(true)
    const after = stateOf(f)
    expect(findLayer(after, f.audioLayer).t_start_us).toBe(frame(V_MOVE_FRAME()))
    expect([srcIn(findLayer(after, f.audioLayer)), srcOut(findLayer(after, f.audioLayer))])
      .toEqual([srcIn(findLayer(before, f.audioLayer)), srcOut(findLayer(before, f.audioLayer))])
    expect(offsetOf(after, f)).toBe(7)
  })

  it('a linked In trim after a slip moves both edges together and keeps the slip', () => {
    const f = pairedFixture()
    slip(f, 7)
    const trimTo = frame(V_START_FRAME() + 10)
    expect(f.actor.dispatch('trim_layer', { layer: f.videoLayer, edge: 'in', new_t_us: trimTo, escape_link: false }).ok).toBe(true)
    const after = stateOf(f)
    expect(findLayer(after, f.videoLayer).t_start_us).toBe(trimTo)
    expect(findLayer(after, f.audioLayer).t_start_us).toBe(trimTo)
    expect(offsetOf(after, f)).toBe(7)
  })

  it('a slipped project reopens with no repair and byte-identical geometry', () => {
    const f = pairedFixture()
    slip(f, 7)
    const saved = serializeProjectToJson(stateOf(f))
    const reported: GridRepair[][] = []
    const reopened = parseProject(JSON.parse(saved), { onGridRepair: (r) => reported.push([...r]) })
    expect(reported).toEqual([])
    expect(JSON.stringify(serializeProject(reopened))).toBe(JSON.stringify(JSON.parse(saved)))
    expect(offsetOf(reopened, f)).toBe(7)
  })

  it('composition.duration_us is a frame count that encloses the audio tail', () => {
    const { actor, audioLayer, videoLayer } = pairedFixture()
    // Delete the video so the audio tail alone defines the duration.
    expect(actor.dispatch('delete_layers', { layers: [videoLayer] }).ok).toBe(true)
    const end = sample(gridIndex(frame(120), AUDIO_GRID) + 3)
    expect(actor.dispatch('trim_layer', { layer: audioLayer, edge: 'out', new_t_us: end, escape_link: true }).ok).toBe(true)
    const comp = root(actor.snapshot())
    const audio = findLayer(actor.snapshot(), audioLayer)
    expect(onFrames(audio.t_end_us)).toBe(true)
    expect(onFrames(comp.duration_us)).toBe(true)
    expect(comp.duration_us).toBeGreaterThanOrEqual(audio.t_end_us)
  })

  it('composition.sample_rate is untouched by all of this (export target, not a grid)', () => {
    const f = pairedFixture()
    const before = root(stateOf(f)).sample_rate
    slip(f, 1234)
    expect(root(stateOf(f)).sample_rate).toBe(before)
    // And it is still freely settable — no lock.
    expect(f.actor.dispatch('set_composition', { sample_rate: 44_100 }).ok).toBe(true)
    expect(root(stateOf(f)).sample_rate).toBe(44_100)
  })

  it('audio param tracks (gain/pan) normalize on the sample lattice, visual params on the frame grid', () => {
    const { actor, audioLayer, videoLayer } = pairedFixture()
    // A sample boundary that is deliberately NOT a frame boundary, so the two arms of
    // the write-time snap resolve the SAME request to two different times.
    const raw = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 3)
    expect(snapFrameRound(raw, FPS.num, FPS.den)).not.toBe(raw)

    const kf = (t: number) => ({ mode: 'Keyframed' as const, extrapolate: { before: 'Hold' as const, after: 'Hold' as const }, value: [{ id: 'k1', t_us: t, value: 0.5, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' as const }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' as const }, continuity: 'Broken' as const, segment: { kind: 'Linear' as const } }] })
    expect(actor.dispatch('update_layer_param_track', { layer: audioLayer, param_key: 'gain_db', track: kf(raw) }).ok).toBe(true)
    const audioParams = findLayer(actor.snapshot(), audioLayer).params
    if (audioParams.kind !== 'Audio' || audioParams.gain_db.mode !== 'Keyframed') throw new Error('expected a keyframed audio gain')
    const audioT = audioParams.gain_db.value[0]!.t_us
    // Audio automation resolves on the mix lattice, so the request survives verbatim.
    expect(audioT).toBe(raw)

    expect(actor.dispatch('update_layer_param_track', { layer: videoLayer, param_key: 'opacity', track: kf(raw) }).ok).toBe(true)
    const videoParams = findLayer(actor.snapshot(), videoLayer).params
    if (videoParams.kind !== 'VideoClip' || videoParams.opacity.mode !== 'Keyframed') throw new Error('expected a keyframed opacity')
    expect(videoParams.opacity.value[0]!.t_us).toBe(snapFrameRound(raw, FPS.num, FPS.den))
    expect(audioT).not.toBe(videoParams.opacity.value[0]!.t_us)
  })
})

/** The wire project the actor would save, as a mutable record. */
type WireLayer = Record<string, unknown> & { id: string; t_start_us: number; t_end_us: number; params: Record<string, unknown> }
function wireOf(p: Project): { wire: Record<string, unknown>; layer: (id: string) => WireLayer } {
  const wire = JSON.parse(serializeProjectToJson(p)) as Record<string, unknown> & {
    compositions: Record<string, { tracks: Array<{ layers: WireLayer[] }> }>
    root_id: string
  }
  const layer = (id: string) => wire.compositions[wire.root_id].tracks.flatMap((t) => t.layers).find((l) => l.id === id)!
  return { wire, layer }
}

describe('load repair of audio edges written on the sample lattice', () => {
  /** The pair as a project saved when audio edges lived on samples: the audio's
   *  edges sit `slipSamples` past the samples nearest the picture's frames, and its
   *  source window reads from `SRC_IN` for as many samples as its edges span, as
   *  every edit of that time wrote it. */
  function legacyPair(slipSamples: number) {
    const f = pairedFixture()
    const { wire, layer } = wireOf(stateOf(f))
    const audio = layer(f.audioLayer)
    audio.t_start_us = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + slipSamples)
    audio.t_end_us = sample(gridIndex(audio.t_end_us, AUDIO_GRID) + slipSamples)
    const spanSamples = gridIndex(audio.t_end_us, AUDIO_GRID) - gridIndex(audio.t_start_us, AUDIO_GRID)
    audio.params.src_out_us = sample(gridIndex(audio.params.src_in_us as number, AUDIO_GRID) + spanSamples)
    expect(onFrames(audio.t_start_us)).toBe(false)
    expect(onFrames(audio.t_end_us)).toBe(false)
    const legacyOrigin = gridIndex(audio.t_start_us, AUDIO_GRID) - gridIndex(audio.params.src_in_us as number, AUDIO_GRID)
    return { f, wire, legacy: { ...audio, params: { ...audio.params } }, legacyOrigin }
  }

  function open(wire: unknown) {
    const reported: GridRepair[][] = []
    const project = parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    return { project, repairs: reported.flat() }
  }

  it.each([
    ['grid residue only', 0],
    ['a 7-sample slip', 7],
  ])('%s: edges move onto the picture\'s frames, every sample plays where it did, and the repair is reported once', (_name, slipSamples) => {
    const { f, wire, legacy, legacyOrigin } = legacyPair(slipSamples)
    const { project, repairs } = open(wire)
    const audio = findLayer(project, f.audioLayer)
    const video = findLayer(project, f.videoLayer)

    expect([audio.t_start_us, audio.t_end_us]).toEqual([video.t_start_us, video.t_end_us])
    expect(mixOrigin(audio)).toBe(legacyOrigin)
    // The mixer plays the source window's length, so its length in samples is
    // what keeps the last sample where it played.
    const windowSamples = (inUs: number, outUs: number) => gridIndex(outUs, AUDIO_GRID) - gridIndex(inUs, AUDIO_GRID)
    expect(windowSamples(srcIn(audio), srcOut(audio))).toBe(windowSamples(legacy.params.src_in_us as number, legacy.params.src_out_us as number))
    if (slipSamples === 0) {
      // The residue is under half a sample, so the mixer already played these
      // samples: the source is left exactly as it was.
      expect([srcIn(audio), srcOut(audio)]).toEqual([legacy.params.src_in_us, legacy.params.src_out_us])
    } else {
      expect(gridIndex(srcIn(audio), AUDIO_GRID)).toBe(gridIndex(legacy.params.src_in_us as number, AUDIO_GRID) - slipSamples)
      expect(offsetOf(project, f)).toBe(slipSamples)
    }

    const fields = repairs.filter((r) => r.id === f.audioLayer).map((r) => r.field)
    expect(fields).toEqual(expect.arrayContaining(['t_start_us', 't_end_us']))
    if (slipSamples === 0) expect(fields).not.toContain('src_in_us')
    else expect(fields).toContain('src_in_us')
    expect(repairs.every((r) => r.id === f.audioLayer || r.entity === 'Composition')).toBe(true)

    expect(open(JSON.parse(serializeProjectToJson(project))).repairs).toEqual([])
  })
})
