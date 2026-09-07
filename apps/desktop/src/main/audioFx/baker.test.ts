// The baker's state machine, against a recording backend and hand-driven
// timers. What is pinned here is the behaviour a user would notice: one bake
// per settled edit, one bake shared by N layers configured alike, correct
// audio or an explicit refusal (never a silent raw fallback), and the last
// good artifact surviving a failure.
import { describe, it, expect } from 'vitest'
import { createAudioFxBaker, exportWindowFromArgs, type AudioFxBackend, type AudioFxBaker } from './baker'
import { createFxCacheLayout, VCONF_HEADER_LEN, type AudioFxFs } from './fxPaths'
import { chainSignature } from './signature'
import { effectiveChain } from '../../shared/audioEffects/catalog'
import { CONFORM_FORMAT_VERSION } from '../../shared/audioEffects/conform'
import {
  AUDIO_FX_STATUS_EVENT, fxWaveformKey,
  type AudioFxStatusEvent, type LayerFxState,
} from '../../shared/audioEffects/status'
import { blankProject, rootComposition } from '../state/model'
import { uuidV7Gen } from '../state/ids'
import type { ChangeEvent, DiffHint } from '../state/actor'
import type { Effect, Layer, MediaItem, Project } from '../state/model'

const CACHE = '/cache'
const HASH = 'aaaa1111'
const CONFORM = '/cache/audio/aaaa1111.conform'
const REGION = { profile_in_us: 200_000, profile_out_us: 1_800_000 }
const join = (...parts: string[]): string => parts.join('/')

// ── project fixtures ─────────────────────────────────────────────────────────

function denoise(id: string, values: Record<string, number> = {}, enabled = true): Effect {
  const params = Object.fromEntries(
    Object.entries({ ...REGION, ...values }).map(([k, v]) => [k, { mode: 'Static' as const, value: v }]),
  )
  return { id, kind: 'audio.denoise', enabled, params }
}

function audioLayer(id: string, mediaId: string, effects: Effect[], span = [0, 5_000_000]): Layer {
  return {
    id, label: null, t_start_us: span[0], t_end_us: span[1], enabled: true, locked: false,
    metadata: {},
    params: {
      kind: 'Audio', media: mediaId, src_in_us: 0, src_out_us: span[1] - span[0],
      gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
      fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue',
    },
    effects,
  }
}

function mediaItem(id: string, hash: string, conformPath: string | null): MediaItem {
  return {
    id, label: null, path_abs: `/m/${id}.wav`, path_rel: null, kind: 'Audio',
    metadata: { duration_us: 10_000_000, audio: { sample_rate: 48_000, channels: 2 } },
    file_hash_blake3: hash, file_size: 4_096, file_mtime: 0, imported_at: '2020-01-01T00:00:00Z',
    decode_route: { route: 'bypass' }, conform_path: conformPath,
    waveform_path: null, thumbnails_dir: null,
  }
}

function projectWith(layers: Layer[], pool: MediaItem[]): Project {
  const p = blankProject(uuidV7Gen(), 'fx')
  const root = rootComposition(p)
  root.duration_us = 60_000_000
  root.tracks[0].layers = layers
  for (const m of pool) p.media_pool[m.id] = m
  return p
}

/** The signature the baker will derive for this layer — computed through the
 *  production helpers so the test never restates the grammar. */
function sigOf(layer: Layer, media: MediaItem): string {
  const chain = effectiveChain(layer, { duration_us: media.metadata.duration_us })
  const signature = chainSignature(media.file_hash_blake3, CONFORM_FORMAT_VERSION, chain)
  if (signature === null) throw new Error('fixture has no effective chain')
  return signature.sig
}

const jobKeyOf = (sig: string): string => `audio_fx:${sig}`
const destOf = (sig: string): string => `${CACHE}/audio/${HASH}.fx-${sig.slice(0, 16)}.conform`
const peaksOf = (sig: string): string => `${CACHE}/waveforms/${HASH}.fx-${sig.slice(0, 16)}.v4.peaks`

// ── harness ──────────────────────────────────────────────────────────────────

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Drain the microtask queue. The injected timers are hand-driven, so a real
 *  zero-delay timer is the one thing that still runs after every `await`. */
const flush = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0) })

function vconfHeader(): Uint8Array {
  const buf = new Uint8Array(VCONF_HEADER_LEN)
  const view = new DataView(buf.buffer)
  for (const [i, c] of [...'VCONF\0\0\0'].entries()) buf[i] = c.charCodeAt(0)
  view.setUint32(8, CONFORM_FORMAT_VERSION, true)
  view.setUint32(12, 48_000, true)
  view.setUint32(16, 2, true)
  return buf
}

function fakeFs() {
  const files = new Map<string, { size: number; mtimeMs: number; conform: boolean }>()
  const touched: string[] = []
  const fs: AudioFxFs = {
    statFile: (p) => {
      const f = files.get(p)
      return f ? { size: f.size, mtimeMs: f.mtimeMs } : null
    },
    readHeader: (p) => (files.get(p)?.conform ? vconfHeader() : null),
    touch: (p, whenMs) => {
      touched.push(p)
      const f = files.get(p)
      if (f) f.mtimeMs = whenMs
    },
  }
  return {
    fs, files, touched,
    addConform(path: string, mtimeMs = Date.now()) { files.set(path, { size: 4_096, mtimeMs, conform: true }) },
    addPeaks(path: string) { files.set(path, { size: 512, mtimeMs: Date.now(), conform: false }) },
    remove(path: string) { files.delete(path) },
  }
}

function fakeTimers() {
  let seq = 0
  const armed = new Map<number, { fn: () => void; ms: number }>()
  const cleared: number[] = []
  return {
    setTimeout: (fn: () => void, ms: number): unknown => { const id = ++seq; armed.set(id, { fn, ms }); return id },
    clearTimeout: (handle: unknown): void => {
      const id = handle as number
      if (armed.delete(id)) cleared.push(id)
    },
    cleared,
    armedCount: (): number => armed.size,
    /** Fire every timer due within `ms`, then let the async pipeline run. */
    async advance(ms = 400): Promise<void> {
      for (const [id, t] of [...armed]) {
        if (t.ms > ms) continue
        armed.delete(id)
        t.fn()
      }
      await flush()
    },
  }
}

function fakeBackend(rmsDbfs: number | null = -34) {
  const calls: Array<{ channel: string; args: Record<string, unknown> }> = []
  const bakes = new Map<string, Deferred<{ path: string; frame_count: number }>>()
  let autoPeaks = true
  const backend: AudioFxBackend = {
    async measureConformRms(a) {
      calls.push({ channel: 'measure_conform_rms', args: { ...a } })
      return { rms_dbfs: rmsDbfs, frames: 96_000 }
    },
    bakeAudioFx(a) {
      calls.push({ channel: 'bake_audio_fx', args: { ...a } })
      const d = deferred<{ path: string; frame_count: number }>()
      bakes.set(a.job_key, d)
      return d.promise
    },
    async cancelAudioFx(a) {
      calls.push({ channel: 'cancel_audio_fx', args: { ...a } })
      return { cancelled: true }
    },
    buildPeaksForVconf(a) {
      calls.push({ channel: 'build_peaks_for_vconf', args: { ...a } })
      return autoPeaks
        ? Promise.resolve({ path: a.dest_path })
        : new Promise<{ path: string }>(() => { /* never lands */ })
    },
    async ensureConform(item) {
      calls.push({ channel: 'ensure_conform', args: { media_id: item.id } })
    },
  }
  return {
    backend, calls,
    of: (channel: string) => calls.filter((c) => c.channel === channel),
    /** Land the bake under `sig`, writing its artifacts to `disk`. */
    async finish(sig: string, disk: ReturnType<typeof fakeFs>): Promise<void> {
      disk.addConform(destOf(sig))
      disk.addPeaks(peaksOf(sig))
      bakes.get(jobKeyOf(sig))?.resolve({ path: destOf(sig), frame_count: 96_000 })
      await flush()
    },
    async fail(sig: string, message: string): Promise<void> {
      bakes.get(jobKeyOf(sig))?.reject(new Error(message))
      await flush()
    },
    stallPeaks() { autoPeaks = false },
  }
}

function harness(initial: Project, rmsDbfs: number | null = -34) {
  let snapshot = initial
  const subs = new Set<(e: ChangeEvent) => void>()
  const disk = fakeFs()
  const rust = fakeBackend(rmsDbfs)
  const timers = fakeTimers()
  const events: AudioFxStatusEvent[] = []
  const eventNames: string[] = []
  const baker: AudioFxBaker = createAudioFxBaker({
    actor: {
      snapshot: () => snapshot,
      subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    },
    backend: rust.backend,
    cacheLayout: createFxCacheLayout({ cacheRoot: () => CACHE, join }),
    fs: disk.fs,
    emit: (event, payload) => {
      eventNames.push(event)
      events.push(payload as AudioFxStatusEvent)
    },
    now: () => Date.now(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  return {
    baker, disk, rust, timers, events, eventNames,
    project: () => snapshot,
    /** Publish a project revision, as the actor's subscription would. */
    change(next: Project, hint: DiffHint = { kind: 'Coarse' }): void {
      snapshot = next
      const e = {
        op_id: 'op', actor: { kind: 'User' }, timestamp: '2020-01-01T00:00:00Z',
        summary: 'edit', affected: [], new_snapshot: next, diff_hint: hint,
      } as unknown as ChangeEvent
      for (const cb of [...subs]) cb(e)
    },
    /** Clone the current project and hand the copy to `mutate`. */
    edit(mutate: (p: Project) => void, hint?: DiffHint): Project {
      const next = structuredClone(snapshot) as Project
      mutate(next)
      this.change(next, hint)
      return next
    },
    stateOf(layerId: string): LayerFxState | null {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].layer_id === layerId) return events[i].state
      return null
    },
  }
}

/** One media with its conform on disk, one audio layer with one denoise. */
function oneLayerSetup(values: Record<string, number> = {}) {
  const media = mediaItem('m1', HASH, CONFORM)
  const layer = audioLayer('L1', 'm1', [denoise('e1', values)])
  const h = harness(projectWith([layer], [media]))
  h.disk.addConform(CONFORM)
  return { ...h, media, layer, sig: sigOf(layer, media) }
}

function layerOf(p: Project, id: string): Layer {
  for (const track of rootComposition(p).tracks) {
    const found = track.layers.find((l) => l.id === id)
    if (found) return found
  }
  throw new Error(`no layer ${id}`)
}

function setStrength(p: Project, layerId: string, value: number): void {
  const effect = layerOf(p, layerId).effects[0]
  effect.params.strength = { mode: 'Static', value }
}

// ── debounce ─────────────────────────────────────────────────────────────────

describe('debounce', () => {
  it('bakes once, after the window, for a single settled edit', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    expect(h.rust.of('bake_audio_fx')).toHaveLength(0)
    await h.timers.advance()
    const bakes = h.rust.of('bake_audio_fx')
    expect(bakes).toHaveLength(1)
    expect(bakes[0].args.job_key).toBe(jobKeyOf(h.sig))
    expect(bakes[0].args.conform_path).toBe(CONFORM)
    expect(bakes[0].args.dest_path).toBe(destOf(h.sig))
    expect(bakes[0].args.media_id).toBe('m1')
    // The graph is the shared builder's, filled with the measured floor.
    expect(String(bakes[0].args.filter_complex)).toContain('afftdn@fx0=nr=12.000:nf=-26')
  })

  it('collapses three edits inside the window into one bake of the LAST signature', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    let last: Project = h.project()
    for (const value of [20, 24, 30]) last = h.edit((p) => { setStrength(p, 'L1', value) })
    await h.timers.advance()
    const bakes = h.rust.of('bake_audio_fx')
    expect(bakes).toHaveLength(1)
    expect(bakes[0].args.job_key).toBe(jobKeyOf(sigOf(layerOf(last, 'L1'), h.media)))
  })

  // Bursts of unrelated project changes must not push a waiting layer's settle
  // out indefinitely.
  it('does not re-arm a standing timer when the desired signature is unchanged', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    const armedAfterFirst = h.timers.armedCount()
    h.change(h.project())
    h.change(h.project())
    expect(h.timers.armedCount()).toBe(armedAfterFirst)
    expect(h.timers.cleared).toEqual([])
  })
})

// ── supersede / share ────────────────────────────────────────────────────────

describe('supersede and sharing', () => {
  it('cancels the in-flight bake and starts the new one when the signature moves', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    const first = h.sig
    const next = h.edit((p) => { setStrength(p, 'L1', 30) })
    await h.timers.advance()
    expect(h.rust.of('cancel_audio_fx').map((c) => c.args.job_key)).toEqual([jobKeyOf(first)])
    const second = sigOf(layerOf(next, 'L1'), h.media)
    expect(h.rust.of('bake_audio_fx').map((c) => c.args.job_key)).toEqual([jobKeyOf(first), jobKeyOf(second)])
  })

  it('leaves the old signature baking while another layer still wants it', async () => {
    const media = mediaItem('m1', HASH, CONFORM)
    const h = harness(projectWith(
      [audioLayer('L1', 'm1', [denoise('e1')]), audioLayer('L2', 'm1', [denoise('e2')])],
      [media],
    ))
    h.disk.addConform(CONFORM)
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(1)
    const next = h.edit((p) => { setStrength(p, 'L1', 30) })
    await h.timers.advance()
    expect(h.rust.of('cancel_audio_fx')).toEqual([])
    expect(h.rust.of('bake_audio_fx').map((c) => c.args.job_key)).toContain(
      jobKeyOf(sigOf(layerOf(next, 'L1'), media)),
    )
  })

  it('bakes once for two layers configured alike and readies both', async () => {
    const media = mediaItem('m1', HASH, CONFORM)
    const layer = audioLayer('L1', 'm1', [denoise('e1')])
    const h = harness(projectWith(
      [layer, audioLayer('L2', 'm1', [denoise('e2')])], [media],
    ))
    h.disk.addConform(CONFORM)
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(1)
    const sig = sigOf(layer, media)
    await h.rust.finish(sig, h.disk)
    for (const id of ['L1', 'L2']) {
      expect(h.stateOf(id)?.ready).toMatchObject({ sig, media_hash: HASH, audio_path: destOf(sig) })
      expect(h.stateOf(id)?.pending).toBeNull()
    }
  })
})

// ── conform dependency ───────────────────────────────────────────────────────

describe('conform dependency', () => {
  it('kicks one conform for the media and bakes nothing until it lands', async () => {
    const media = mediaItem('m1', HASH, null)
    const h = harness(projectWith(
      [audioLayer('L1', 'm1', [denoise('e1')]), audioLayer('L2', 'm1', [denoise('e2')])],
      [media],
    ))
    h.change(h.project())
    await h.timers.advance()
    // Two layers, two settles, one job: a second conform of the same media is
    // pure duplicate work.
    expect(h.rust.of('ensure_conform')).toEqual([{ channel: 'ensure_conform', args: { media_id: 'm1' } }])
    expect(h.rust.of('bake_audio_fx')).toHaveLength(0)
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('ensure_conform')).toHaveLength(1)

    // The derivatives write-back re-enters through the same subscription.
    h.disk.addConform(CONFORM)
    h.edit((p) => { p.media_pool.m1.conform_path = CONFORM })
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(1)
  })

  it('re-kicks the conform when a landed one is a zero-byte stub', async () => {
    const h = oneLayerSetup()
    h.disk.files.set(CONFORM, { size: 0, mtimeMs: 0, conform: true })
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('ensure_conform')).toHaveLength(1)
    expect(h.rust.of('bake_audio_fx')).toHaveLength(0)
  })
})

// ── failure ──────────────────────────────────────────────────────────────────

describe('failure', () => {
  it('keeps the last ready artifact, attributes the effect, and clears on the next success', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    const goodReady = h.stateOf('L1')?.ready
    expect(goodReady?.sig).toBe(h.sig)

    const broken = h.edit((p) => { setStrength(p, 'L1', 30) })
    await h.timers.advance()
    const brokenSig = sigOf(layerOf(broken, 'L1'), h.media)
    await h.rust.fail(brokenSig, 'ffmpeg: no such filter')
    const failed = h.stateOf('L1')
    expect(failed?.error).toEqual({ message: 'ffmpeg: no such filter', effect_id: 'e1', kind: 'audio.denoise' })
    // Stale-while-revalidate: the mixer keeps playing the last good bake.
    expect(failed?.ready).toEqual(goodReady)
    expect(failed?.pending).toBeNull()

    // A failure names ONE signature and is not retried under it, so nothing
    // re-bakes on the next project change.
    const bakesAfterFailure = h.rust.of('bake_audio_fx').length
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(bakesAfterFailure)

    const fixed = h.edit((p) => { setStrength(p, 'L1', 18) })
    await h.timers.advance()
    const fixedSig = sigOf(layerOf(fixed, 'L1'), h.media)
    await h.rust.finish(fixedSig, h.disk)
    expect(h.stateOf('L1')?.error).toBeNull()
    expect(h.stateOf('L1')?.ready?.sig).toBe(fixedSig)
  })
})

// ── desired becomes null ─────────────────────────────────────────────────────

describe('an emptied chain', () => {
  it('publishes desired_sig null, bakes nothing, and cancels nothing another layer wants', async () => {
    const media = mediaItem('m1', HASH, CONFORM)
    const h = harness(projectWith(
      [audioLayer('L1', 'm1', [denoise('e1')]), audioLayer('L2', 'm1', [denoise('e2')])],
      [media],
    ))
    h.disk.addConform(CONFORM)
    h.change(h.project())
    await h.timers.advance()
    const bakesBefore = h.rust.of('bake_audio_fx').length
    h.edit((p) => { layerOf(p, 'L1').effects[0].enabled = false })
    await h.timers.advance()
    expect(h.stateOf('L1')?.desired_sig).toBeNull()
    expect(h.stateOf('L1')?.pending).toBeNull()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(bakesBefore)
    expect(h.rust.of('cancel_audio_fx')).toEqual([])
  })

  it('treats an incomplete region as no chain at all', async () => {
    // Below the filter's minimum sample span: baking a bad profile would be
    // audio nobody asked for, so the effect stays out of the chain entirely and
    // the layer never earns a state row.
    const media = mediaItem('m1', HASH, CONFORM)
    const h = harness(projectWith(
      [audioLayer('L1', 'm1', [denoise('e1', { profile_out_us: 300_000 })])], [media],
    ))
    h.disk.addConform(CONFORM)
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(0)
    expect(h.events).toEqual([])
    expect(h.baker.snapshot()).toEqual({})
  })
})

// ── the cached-artifact short-circuit ────────────────────────────────────────

describe('an artifact already on disk', () => {
  it('readies without baking and refreshes the LRU mtime', async () => {
    const h = oneLayerSetup()
    const sig = h.sig
    h.disk.addConform(destOf(sig), 0)
    h.disk.addPeaks(peaksOf(sig))
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(0)
    expect(h.stateOf('L1')?.ready).toEqual({
      sig, media_hash: HASH, audio_path: destOf(sig), peaks_path: peaksOf(sig),
    })
    // A short-circuit is a read, and mtime IS the disk-LRU clock.
    h.change(h.project())
    await h.timers.advance()
    expect(h.disk.touched).toContain(destOf(sig))
  })

  it('readies the audio first and fills the waveform path in when the peaks land', async () => {
    const h = oneLayerSetup()
    const sig = h.sig
    h.disk.addConform(destOf(sig))
    h.rust.stallPeaks()
    h.change(h.project())
    await h.timers.advance()
    const pending = h.stateOf('L1')
    expect(pending?.ready?.audio_path).toBe(destOf(sig))
    expect(pending?.ready?.peaks_path).toBeNull()
    expect(h.rust.of('build_peaks_for_vconf')).toEqual([{
      channel: 'build_peaks_for_vconf',
      args: { vconf_path: destOf(sig), dest_path: peaksOf(sig) },
    }])
    // A settle that re-runs must not launch a second build of the same file.
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('build_peaks_for_vconf')).toHaveLength(1)
  })
})

// ── export seams ─────────────────────────────────────────────────────────────

describe('layerAudioSources', () => {
  it('names only layers whose desired signature is the one on disk', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    expect(h.baker.layerAudioSources(h.project())).toEqual({ L1: destOf(h.sig) })

    // Edit past the ready artifact: a stale bake is not what the user hears.
    h.edit((p) => { setStrength(p, 'L1', 30) })
    await h.timers.advance()
    expect(h.baker.layerAudioSources(h.project())).toEqual({})
  })

  it('drops layers the export window cannot reach', async () => {
    const media = mediaItem('m1', HASH, CONFORM)
    const early = audioLayer('L1', 'm1', [denoise('e1')], [0, 4_000_000])
    const late = audioLayer('L2', 'm1', [denoise('e1')], [10_000_000, 14_000_000])
    const h = harness(projectWith([early, late], [media]))
    h.disk.addConform(CONFORM)
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(sigOf(early, media), h.disk)
    expect(Object.keys(h.baker.layerAudioSources(h.project()))).toEqual(['L1', 'L2'])
    expect(Object.keys(h.baker.layerAudioSources(h.project(), { start_us: 0, end_us: 2_000_000 }))).toEqual(['L1'])
  })
})

describe('ensureExportAudioFx', () => {
  it('flushes the debounce, reports the layers still baking, and offers no source for them', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    // No advance: the gate must not have to wait out the debounce.
    const gate = await h.baker.ensureExportAudioFx(null)
    expect(gate).toEqual({ waiting: ['L1'], failed: [] })
    expect(h.rust.of('bake_audio_fx')).toHaveLength(1)
    expect(h.baker.layerAudioSources(h.project())).toEqual({})

    await h.rust.finish(h.sig, h.disk)
    expect(await h.baker.ensureExportAudioFx(null)).toEqual({ waiting: [], failed: [] })
    expect(h.baker.layerAudioSources(h.project())).toEqual({ L1: destOf(h.sig) })
  })

  it('surfaces a failed bake as an error naming the layer and effect, with no source', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.fail(h.sig, 'ffmpeg exited 1')
    const gate = await h.baker.ensureExportAudioFx(null)
    expect(gate).toEqual({
      waiting: [],
      failed: [{ layer_id: 'L1', effect_id: 'e1', kind: 'audio.denoise', error: 'ffmpeg exited 1' }],
    })
    // Never a raw fallback: a failed layer maps to nothing at all.
    expect(h.baker.layerAudioSources(h.project())).toEqual({})
  })

  it('ignores layers with no effective chain', async () => {
    const media = mediaItem('m1', HASH, CONFORM)
    const h = harness(projectWith([audioLayer('L1', 'm1', [])], [media]))
    h.disk.addConform(CONFORM)
    h.change(h.project())
    expect(await h.baker.ensureExportAudioFx(null)).toEqual({ waiting: [], failed: [] })
  })
})

// ── waveform keys and eviction recovery ──────────────────────────────────────

describe('resolveWaveformKey', () => {
  it('round-trips an fx key to its peaks path and answers null once it is gone', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    const key = fxWaveformKey(HASH, h.sig.slice(0, 16))
    expect(h.baker.resolveWaveformKey(key)).toBe(peaksOf(h.sig))
    h.disk.remove(peaksOf(h.sig))
    expect(h.baker.resolveWaveformKey(key)).toBeNull()
  })

  it('answers null for a media-id key and for a malformed one', () => {
    const h = oneLayerSetup()
    expect(h.baker.resolveWaveformKey('m1')).toBeNull()
    expect(h.baker.resolveWaveformKey('fx:nothex.fx-zz')).toBeNull()
  })
})

describe('reverify', () => {
  it('drops a ready artifact the cache evicted and bakes it again', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    expect(h.stateOf('L1')?.ready?.sig).toBe(h.sig)

    h.disk.remove(destOf(h.sig))
    await h.baker.reverify('L1')
    await flush()
    expect(h.stateOf('L1')?.ready).toBeNull()
    expect(h.stateOf('L1')?.pending).toBe(h.sig)
    expect(h.rust.of('bake_audio_fx')).toHaveLength(2)
  })

  it('keeps the audio and rebuilds only the waveform when just the peaks evicted', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    h.disk.remove(peaksOf(h.sig))
    h.rust.stallPeaks()
    await h.baker.reverify('L1')
    await flush()
    expect(h.stateOf('L1')?.ready?.audio_path).toBe(destOf(h.sig))
    expect(h.stateOf('L1')?.ready?.peaks_path).toBeNull()
    expect(h.rust.of('build_peaks_for_vconf')).toHaveLength(2)
  })

  it('is the retry a standing failure needs', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.fail(h.sig, 'ffmpeg exited 1')
    await h.baker.reverify('L1')
    await flush()
    expect(h.stateOf('L1')?.error).toBeNull()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(2)
  })

  it('is a no-op for a layer it has never seen', async () => {
    const h = oneLayerSetup()
    await expect(h.baker.reverify('nope')).resolves.toBeUndefined()
    expect(h.events).toEqual([])
  })
})

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('cancels the in-flight bake, clears the armed timers, and rebuilds from the snapshot', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(1)

    h.baker.reset()
    expect(h.rust.of('cancel_audio_fx').map((c) => c.args.job_key)).toEqual([jobKeyOf(h.sig)])
    expect(h.stateOf('L1')?.pending).toBeNull()

    // The abandoned bake's late result belongs to nobody.
    await h.rust.finish(h.sig, h.disk)
    expect(h.stateOf('L1')?.ready).toBeNull()

    // …and the rebuild re-derives it from the project that is now current.
    await h.timers.advance()
    expect(h.rust.of('bake_audio_fx')).toHaveLength(1)
    expect(h.stateOf('L1')?.ready?.sig).toBe(h.sig)
  })

  it('clears the debounce timer armed before it', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    expect(h.timers.armedCount()).toBe(1)
    h.baker.reset()
    expect(h.timers.cleared).toHaveLength(1)
  })

  it('drops layers the new project does not have', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    h.edit((p) => { rootComposition(p).tracks[0].layers = [] })
    expect(h.stateOf('L1')).toEqual({ desired_sig: null, ready: null, pending: null, error: null })
    expect(h.baker.snapshot()).toEqual({})
  })
})

describe('dispose', () => {
  it('stops watching and cancels what is in flight', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    h.baker.dispose()
    expect(h.rust.of('cancel_audio_fx')).toHaveLength(1)
    const before = h.events.length
    h.edit((p) => { setStrength(p, 'L1', 30) })
    await h.timers.advance()
    expect(h.events).toHaveLength(before)
  })
})

describe('snapshot', () => {
  it('answers the whole map, keyed by layer id', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    expect(Object.keys(h.baker.snapshot())).toEqual(['L1'])
    expect(h.baker.snapshot().L1).toEqual(h.stateOf('L1'))
  })
})

describe('diff hints', () => {
  it('recomputes just the hinted layer', async () => {
    const media = mediaItem('m1', HASH, CONFORM)
    const h = harness(projectWith(
      [audioLayer('L1', 'm1', [denoise('e1')]), audioLayer('L2', 'm1', [denoise('e2', { strength: 24 })])],
      [media],
    ))
    h.disk.addConform(CONFORM)
    h.edit((p) => { setStrength(p, 'L1', 30) }, { kind: 'Layer', id: 'L1' })
    await h.timers.advance()
    expect(Object.keys(h.baker.snapshot())).toEqual(['L1'])
  })

  it('forgets a layer a Layer hint says is gone', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    h.edit((p) => { rootComposition(p).tracks[0].layers = [] }, { kind: 'Layer', id: 'L1' })
    expect(h.stateOf('L1')?.desired_sig).toBeNull()
    expect(h.baker.snapshot()).toEqual({})
  })
})

describe('exportWindowFromArgs', () => {
  it('accepts the camelCase the renderer sends and the snake_case alias', () => {
    expect(exportWindowFromArgs({ startUs: 1, endUs: 2 })).toEqual({ start_us: 1, end_us: 2 })
    expect(exportWindowFromArgs({ start_us: 3, end_us: 4 })).toEqual({ start_us: 3, end_us: 4 })
  })
  it('answers null unless BOTH bounds are numbers', () => {
    expect(exportWindowFromArgs({ startUs: 1, endUs: null })).toBeNull()
    expect(exportWindowFromArgs({})).toBeNull()
  })
})

describe('event channel', () => {
  it('publishes every state change on the one status event', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    await h.rust.finish(h.sig, h.disk)
    expect(h.eventNames.length).toBeGreaterThan(0)
    expect([...new Set(h.eventNames)]).toEqual([AUDIO_FX_STATUS_EVENT])
  })

  // A media removed under a layer that still references it is a real project
  // state (remove_media leaves the layer), so it must read as "no chain".
  it('drops the desired signature when the layer loses its media', async () => {
    const h = oneLayerSetup()
    h.change(h.project())
    await h.timers.advance()
    h.edit((p) => { delete p.media_pool.m1 })
    await h.timers.advance()
    expect(h.stateOf('L1')?.desired_sig).toBeNull()
  })
})
