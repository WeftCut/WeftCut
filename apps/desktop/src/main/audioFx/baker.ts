// The audio-effect bake orchestrator. Watches the project actor, derives each
// Audio layer's desired chain signature, drives the four stateless Rust
// primitives, and publishes per-layer bake state to the renderer. It is the
// only holder of that state — nothing is persisted, and disk existence is the
// truth (spec Decision 8).
//
// What lives elsewhere: what an effect IS and what graph it emits
// (src/shared/audioEffects/), the digest that names an artifact
// (./signature.ts), the cache layout and its trust predicates (./fxPaths.ts),
// and the ffmpeg runs (native/src/audio/fx.rs).
//
// See ADR 0063 and docs/audio.md § Clip effects.

import {
  chainMeasurements,
  buildFilterComplex,
  measurementKey,
  type BakeMeasurements,
  type MeasurementRequest,
} from '../../shared/audioEffects/graph'
import { effectiveChain, type EffectiveChain } from '../../shared/audioEffects/catalog'
import { CONFORM_FORMAT_VERSION } from '../../shared/audioEffects/conform'
import {
  AUDIO_FX_STATUS_EVENT,
  parseFxWaveformKey,
  type AudioFxError,
  type AudioFxReady,
  type AudioFxSnapshot,
  type AudioFxStatusEvent,
  type EnsureExportAudioFxResult,
  type LayerFxState,
} from '../../shared/audioEffects/status'
import { chainSignature } from './signature'
import { cachedOk, conformCachedOk, touchDue, touchIfStale, type AudioFxFs, type FxCacheLayout } from './fxPaths'
import { eachLayer } from '../state/model'
import type { ActorHandle, ChangeEvent, DiffHint } from '../state/actor'
import type { Layer, MediaItem, Project } from '../state/model'

/// How long a layer's desired signature must hold still before a bake starts.
/// Every other inspector control is live, and a bake is cheap enough to be one
/// too (spec Decision 10) — this only keeps a slider drag from queueing one
/// render per pixel.
const DEBOUNCE_MS = 400

/// Namespaces the cancel key. One key per signature, not per layer: N layers
/// configured alike share one bake, so cancelling is a decision about the
/// artifact and never about who asked for it.
const JOB_KEY_PREFIX = 'audio_fx:'

/// `AudioFxReady.peaks_path` while the waveform sibling has not landed yet. The
/// bake's whole point is correct AUDIO, so the mixer must not wait on a peaks
/// build — the timeline keeps drawing the raw waveform until this fills in, and
/// `resolveWaveformKey` answers `not_ready` meanwhile.
const PEAKS_PENDING: string | null = null

/// A µs range of the root composition, as the export gate and the mix planner
/// window it.
export interface FxWindow {
  start_us: number
  end_us: number
}

/// The Rust primitives, as the baker calls them. A typed facade rather than a
/// raw `invoke` so the state machine holds no JSON plumbing and a test can hand
/// over a recorder. Field names are the wire names: the four bake channels take
/// snake_case, `ensure_conform` takes the resolved MediaItem the TS actor owns.
export interface AudioFxBackend {
  measureConformRms(args: {
    conform_path: string
    in_us: number
    out_us: number
  }): Promise<{ rms_dbfs: number | null; frames: number }>
  bakeAudioFx(args: {
    conform_path: string
    filter_complex: string
    dest_path: string
    media_id: string
    job_key: string
  }): Promise<{ path: string; frame_count: number }>
  cancelAudioFx(args: { job_key: string }): Promise<{ cancelled: boolean }>
  buildPeaksForVconf(args: { vconf_path: string; dest_path: string }): Promise<{ path: string }>
  ensureConform(item: MediaItem): Promise<void>
}

export interface AudioFxBakerDeps {
  actor: Pick<ActorHandle, 'snapshot' | 'subscribe'>
  backend: AudioFxBackend
  cacheLayout: FxCacheLayout
  fs: AudioFxFs
  /** Main→renderer event sink (`emitToRenderer`). */
  emit: (event: string, payload: unknown) => void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export interface AudioFxBaker {
  /** Every known layer's state — the answer to a boot-time or late subscriber. */
  snapshot(): AudioFxSnapshot
  /** Baked sources for the export mixer, keyed by layer id. Only layers whose
   *  DESIRED signature is the one on disk: a stale ready would export audio the
   *  user is no longer hearing, and there is no raw fallback here at all. */
  layerAudioSources(project: Project, window?: FxWindow | null): Record<string, string>
  /** The export gate: flushes the debounce and reports what the mix is still
   *  waiting on and what will never land. */
  ensureExportAudioFx(window?: FxWindow | null): Promise<EnsureExportAudioFxResult>
  /** Peaks path behind an `fx:` waveform key, or null (which the caller turns
   *  into the same `not_ready` a missing waveform answers). */
  resolveWaveformKey(key: string): string | null
  /** Eviction recovery: re-probe this layer's artifacts, drop whatever is gone,
   *  and settle again. The one path that retries a failed signature. */
  reverify(layerId: string): Promise<void>
  /** Project open / switch: abort in-flight bakes, clear timers, rebuild from
   *  the current snapshot. */
  reset(): void
  /** Project close: abort in-flight bakes and stop watching. */
  dispose(): void
}

/// One layer's desired artifact, fully resolved. Minted only from a snapshot,
/// never cached across change events: `new_snapshot` is a whole Project and
/// reading it is cheap, while a stale media lookup would bake against a path
/// that has since moved.
interface Desired {
  mediaId: string
  mediaHash: string
  conformPath: string | null
  sig: string
  chain: EffectiveChain
  measurements: MeasurementRequest[]
  /** The chain's first entry, for error attribution. v1 chains hold one. */
  effectId: string
  kind: string
  destPath: string
  peaksPath: string
}

interface Entry {
  state: LayerFxState
  desired: Desired | null
  timer: unknown | null
  /** Which signature `state.error` belongs to. An error names ONE bake, so any
   *  desired that no longer needs that bake clears it — and while it stands,
   *  the same signature is not retried (a project-change stream would
   *  otherwise re-run a failing ffmpeg on every keystroke). `reverify` is the
   *  deliberate retry. */
  failedSig: string | null
}

interface BakeRun {
  sig: string
  jobKey: string
  /** Set when we asked Rust to abort: the rejection that follows is ours, not
   *  a failure to report. */
  cancelled: boolean
}

function blankState(): LayerFxState {
  return { desired_sig: null, ready: null, pending: null, error: null }
}

function sameReady(a: AudioFxReady | null, b: AudioFxReady | null): boolean {
  if (a === null || b === null) return a === b
  return a.sig === b.sig && a.media_hash === b.media_hash
    && a.audio_path === b.audio_path && a.peaks_path === b.peaks_path
}

function sameError(a: AudioFxError | null, b: AudioFxError | null): boolean {
  if (a === null || b === null) return a === b
  return a.message === b.message && a.effect_id === b.effect_id && a.kind === b.kind
}

function sameState(a: LayerFxState, b: LayerFxState): boolean {
  return a.desired_sig === b.desired_sig && a.pending === b.pending
    && sameReady(a.ready, b.ready) && sameError(a.error, b.error)
}

function sameDesired(a: Desired | null, b: Desired | null): boolean {
  if (a === null || b === null) return a === b
  return a.sig === b.sig && a.conformPath === b.conformPath
    && a.destPath === b.destPath && a.peaksPath === b.peaksPath
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/// The window an export-gate call carries. Accepts the camelCase the sibling
/// conform gate already receives from the renderer and the snake_case wire
/// alias, the same liberality the widened Rust channels have. Null — the whole
/// project — unless BOTH bounds are numbers.
export function exportWindowFromArgs(args: Record<string, unknown>): FxWindow | null {
  const start = args['startUs'] ?? args['start_us']
  const end = args['endUs'] ?? args['end_us']
  if (typeof start !== 'number' || typeof end !== 'number') return null
  return { start_us: start, end_us: end }
}

export function createAudioFxBaker(deps: AudioFxBakerDeps): AudioFxBaker {
  const { actor, backend, cacheLayout, fs, emit } = deps
  const now = deps.now ?? (() => Date.now())
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })

  const entries = new Map<string, Entry>()
  /** Live bakes by signature — the index that makes N layers one bake. */
  const bakes = new Map<string, BakeRun>()
  /** Media whose conform we have already asked for, so two layers on one media
   *  kick one job. Cleared the moment that conform is observed on disk. */
  const conformAsked = new Set<string>()
  /** Peaks builds in flight, by destination — a settle that re-runs while one
   *  is running must not launch a second. */
  const peaksInFlight = new Set<string>()

  // ── publishing ────────────────────────────────────────────────────────────

  function patch(layerId: string, partial: Partial<LayerFxState>): void {
    const entry = entries.get(layerId)
    if (!entry) return
    const next: LayerFxState = { ...entry.state, ...partial }
    if (sameState(entry.state, next)) return
    entry.state = next
    const event: AudioFxStatusEvent = { layer_id: layerId, state: next }
    emit(AUDIO_FX_STATUS_EVENT, event)
  }

  // ── desired derivation ────────────────────────────────────────────────────

  function desiredFor(project: Project, layer: Layer): Desired | null {
    const params = layer.params
    if (params.kind !== 'Audio') return null
    const media: MediaItem | undefined = project.media_pool[params.media]
    if (!media) return null
    const chain = effectiveChain(layer, { duration_us: media.metadata.duration_us ?? null })
    const signature = chainSignature(media.file_hash_blake3, CONFORM_FORMAT_VERSION, chain)
    if (signature === null) return null
    const first = chain[0]
    return {
      mediaId: media.id,
      mediaHash: media.file_hash_blake3,
      conformPath: media.conform_path,
      sig: signature.sig,
      chain,
      measurements: chainMeasurements(chain),
      effectId: first.effect.id,
      kind: first.effect.kind,
      destPath: cacheLayout.audioFxConform(media.file_hash_blake3, signature.sig16),
      peaksPath: cacheLayout.waveformFx(media.file_hash_blake3, signature.sig16),
    }
  }

  function findLayer(project: Project, layerId: string): Layer | null {
    for (const { layer } of eachLayer(project)) if (layer.id === layerId) return layer
    return null
  }

  /// True when this layer still has work to do for its current desired: no
  /// ready artifact under that signature, nothing baking it, and no standing
  /// failure naming it.
  function needsSettle(entry: Entry): boolean {
    const d = entry.desired
    if (d === null) return entry.state.desired_sig !== null
    if (entry.state.ready?.sig === d.sig) {
      // One metadata read, because a "ready" state has two ways of going bad:
      // the file can be gone (LRU eviction, or the cache root moved with the
      // workspace), and its mtime — the disk-LRU clock — can age out under an
      // artifact that is being played but never re-derived.
      return !cachedOk(fs, d.destPath) || touchDue(fs, d.destPath, now())
    }
    if (entry.state.pending === d.sig) return false
    return entry.failedSig !== d.sig
  }

  /// Re-arm on a CHANGED desired (so three edits inside the window collapse to
  /// one bake of the last signature), but leave a standing timer alone
  /// otherwise: unrelated project changes arrive in bursts, and re-arming on
  /// each would starve a layer that is already waiting to settle.
  function arm(layerId: string, force: boolean): void {
    const entry = entries.get(layerId)
    if (!entry) return
    if (entry.timer !== null) {
      if (!force) return
      clearT(entry.timer)
    }
    entry.timer = setT(() => { void settle(layerId) }, DEBOUNCE_MS)
  }

  function apply(project: Project, layer: Layer): void {
    const d = desiredFor(project, layer)
    const existing = entries.get(layer.id)
    // A layer that has never had an effective chain gets no entry at all: the
    // renderer's absence of a row already means "plays the raw conform".
    if (d === null && !existing) return
    const entry: Entry = existing ?? { state: blankState(), desired: null, timer: null, failedSig: null }
    if (!existing) entries.set(layer.id, entry)
    const changed = !sameDesired(entry.desired, d)
    entry.desired = d
    if (changed) arm(layer.id, true)
    else if (needsSettle(entry)) arm(layer.id, false)
  }

  /// Drop a layer we will never hear about again (deleted, or no longer Audio),
  /// telling the renderer to drop its row.
  function forget(layerId: string): void {
    const entry = entries.get(layerId)
    if (!entry) return
    if (entry.timer !== null) clearT(entry.timer)
    entry.timer = null
    entry.desired = null
    supersede(layerId, null)
    entries.delete(layerId)
    const event: AudioFxStatusEvent = { layer_id: layerId, state: blankState() }
    emit(AUDIO_FX_STATUS_EVENT, event)
  }

  function recomputeAll(project: Project): void {
    const seen = new Set<string>()
    for (const { layer } of eachLayer(project)) {
      if (layer.params.kind !== 'Audio') continue
      seen.add(layer.id)
      apply(project, layer)
    }
    for (const layerId of [...entries.keys()]) if (!seen.has(layerId)) forget(layerId)
  }

  function recompute(hint: DiffHint, project: Project): void {
    if (hint.kind === 'Layer') {
      const layer = findLayer(project, hint.id)
      if (layer === null) forget(hint.id)
      else apply(project, layer)
      return
    }
    recomputeAll(project)
  }

  // ── bake lifecycle ────────────────────────────────────────────────────────

  function wantedByOther(sig: string, exceptLayerId: string): boolean {
    for (const [layerId, entry] of entries) {
      if (layerId === exceptLayerId) continue
      if (entry.desired?.sig === sig) return true
    }
    return false
  }

  /// Release the bake this layer was waiting on. It only reaches Rust when the
  /// layer has moved to another signature (or to none) AND no other layer still
  /// wants the old one — N layers share one artifact, so the last one off is
  /// what cancels it.
  function supersede(layerId: string, keepSig: string | null): void {
    const entry = entries.get(layerId)
    if (!entry) return
    const old = entry.state.pending
    if (old === null || old === keepSig) return
    if (wantedByOther(old, layerId)) return
    const run = bakes.get(old)
    if (!run) return
    run.cancelled = true
    bakes.delete(old)
    void backend.cancelAudioFx({ job_key: run.jobKey }).catch((e: unknown) => {
      console.warn(`[audio-fx] cancel ${run.jobKey} failed`, e)
    })
  }

  function attach(layerId: string, run: BakeRun): void {
    const entry = entries.get(layerId)
    if (!entry) return
    supersede(layerId, run.sig)
    entry.failedSig = null
    patch(layerId, { pending: run.sig, error: null })
  }

  async function runBake(d: Desired, jobKey: string): Promise<AudioFxReady> {
    const conformPath = d.conformPath
    if (conformPath === null) throw new Error('audio fx bake: the media has no conform')
    const measurements: BakeMeasurements = {}
    for (const req of d.measurements) {
      const report = await backend.measureConformRms({
        conform_path: conformPath, in_us: req.inUs, out_us: req.outUs,
      })
      measurements[measurementKey(req)] = report.rms_dbfs
    }
    const filterComplex = buildFilterComplex(d.chain, { measurements })
    // Unreachable: a Desired exists only for a non-empty effective chain. Loud
    // rather than a bake of the unfiltered conform, which would be silently
    // wrong audio.
    if (filterComplex === null) throw new Error('audio fx bake: the effective chain emitted no graph')
    await backend.bakeAudioFx({
      conform_path: conformPath,
      filter_complex: filterComplex,
      dest_path: d.destPath,
      media_id: d.mediaId,
      job_key: jobKey,
    })
    let peaksPath = PEAKS_PENDING
    try {
      peaksPath = (await backend.buildPeaksForVconf({ vconf_path: d.destPath, dest_path: d.peaksPath })).path
    } catch (e) {
      // A missing waveform costs a picture, not correct audio.
      console.warn(`[audio-fx] peaks build failed for ${d.destPath}`, e)
    }
    return { sig: d.sig, media_hash: d.mediaHash, audio_path: d.destPath, peaks_path: peaksPath }
  }

  /// Fan a finished bake out to every layer that still wants that signature. A
  /// layer whose desired moved on keeps whatever it has: this result is no
  /// longer an answer to its question.
  function finishBake(run: BakeRun, ready: AudioFxReady | null, error: string | null): void {
    if (bakes.get(run.sig) === run) bakes.delete(run.sig)
    if (run.cancelled) return
    for (const [layerId, entry] of entries) {
      const d = entry.desired
      if (d === null || d.sig !== run.sig) continue
      if (ready !== null) {
        entry.failedSig = null
        patch(layerId, { ready, pending: null, error: null })
        continue
      }
      entry.failedSig = run.sig
      // The previous `ready` SURVIVES: preview is stale-while-revalidate, so
      // the last good artifact keeps playing (spec Decision 9).
      patch(layerId, {
        pending: null,
        error: { message: error ?? 'audio fx bake failed', effect_id: d.effectId, kind: d.kind },
      })
    }
  }

  function startBake(layerId: string, d: Desired): void {
    const run: BakeRun = { sig: d.sig, jobKey: JOB_KEY_PREFIX + d.sig, cancelled: false }
    bakes.set(d.sig, run)
    attach(layerId, run)
    void runBake(d, run.jobKey).then(
      (ready) => { finishBake(run, ready, null) },
      (err: unknown) => { finishBake(run, null, messageOf(err)) },
    )
  }

  /// Build the waveform sibling for an artifact that is already playable, then
  /// fill its path into every layer that shares the signature.
  function kickPeaks(d: Desired): void {
    if (peaksInFlight.has(d.peaksPath)) return
    peaksInFlight.add(d.peaksPath)
    void backend.buildPeaksForVconf({ vconf_path: d.destPath, dest_path: d.peaksPath }).then(
      (built) => {
        peaksInFlight.delete(d.peaksPath)
        for (const [layerId, entry] of entries) {
          const ready = entry.state.ready
          if (!ready || ready.sig !== d.sig || ready.peaks_path === built.path) continue
          patch(layerId, { ready: { ...ready, peaks_path: built.path } })
        }
      },
      (e: unknown) => {
        peaksInFlight.delete(d.peaksPath)
        console.warn(`[audio-fx] peaks build failed for ${d.destPath}`, e)
      },
    )
  }

  async function ensureConformOnce(mediaId: string): Promise<void> {
    if (conformAsked.has(mediaId)) return
    conformAsked.add(mediaId)
    const item: MediaItem | undefined = actor.snapshot().media_pool[mediaId]
    if (!item) return
    try {
      await backend.ensureConform(item)
    } catch (e) {
      conformAsked.delete(mediaId)
      console.warn(`[audio-fx] ensure_conform for ${mediaId} failed`, e)
    }
  }

  // ── the pipeline ──────────────────────────────────────────────────────────

  async function settle(layerId: string): Promise<void> {
    const entry = entries.get(layerId)
    if (!entry) return
    if (entry.timer !== null) { clearT(entry.timer); entry.timer = null }
    const d = entry.desired

    if (entry.failedSig !== null && entry.failedSig !== (d?.sig ?? null)) {
      entry.failedSig = null
      patch(layerId, { error: null })
    }

    if (d === null) {
      supersede(layerId, null)
      patch(layerId, { desired_sig: null, pending: null, error: null })
      return
    }
    patch(layerId, { desired_sig: d.sig })

    const ready = entry.state.ready
    if (ready !== null && ready.sig === d.sig) {
      if (ready.audio_path === d.destPath && conformCachedOk(fs, d.destPath)) {
        // mtime IS the LRU clock, and a short-circuit is a read: without this
        // the live artifact ages out as the oldest unit in the cache.
        touchIfStale(fs, d.destPath, now())
        supersede(layerId, d.sig)
        patch(layerId, { pending: null, error: null })
        if (ready.peaks_path === null) kickPeaks(d)
        return
      }
      // The state named a file that is gone (LRU eviction, or the cache root
      // moved with the workspace), so it is a lie — drop it and re-derive.
      patch(layerId, { ready: null })
    }
    if (entry.failedSig === d.sig) return

    if (d.conformPath === null || !conformCachedOk(fs, d.conformPath)) {
      // Nothing to bake FROM. Kicking the conform is the whole action: its
      // derivatives broadcast re-enters this pipeline through the subscription.
      supersede(layerId, d.sig)
      patch(layerId, { pending: null })
      await ensureConformOnce(d.mediaId)
      return
    }
    conformAsked.delete(d.mediaId)

    if (conformCachedOk(fs, d.destPath)) {
      supersede(layerId, d.sig)
      entry.failedSig = null
      const peaksPath = cachedOk(fs, d.peaksPath) ? d.peaksPath : PEAKS_PENDING
      patch(layerId, {
        ready: { sig: d.sig, media_hash: d.mediaHash, audio_path: d.destPath, peaks_path: peaksPath },
        pending: null,
        error: null,
      })
      if (peaksPath === null) kickPeaks(d)
      return
    }

    const live = bakes.get(d.sig)
    if (live) { attach(layerId, live); return }
    startBake(layerId, d)
  }

  /// Settle now, ignoring the debounce — the export gate cannot wait 400 ms to
  /// learn what it is waiting for.
  function flushSettle(layerId: string): Promise<void> {
    const entry = entries.get(layerId)
    if (entry?.timer != null) { clearT(entry.timer); entry.timer = null }
    return settle(layerId)
  }

  // ── window selection ──────────────────────────────────────────────────────

  /// Audio layers an export window can reach. Root-composition layers are
  /// filtered by the window; a layer inside a Group is not, because its times
  /// are local to that Group and only the mix planner resolves the parent
  /// placement that maps them. Over-including costs an extra bake wait, while
  /// omitting one would export audio the user never heard (spec Decision 9).
  function* audioLayersInWindow(project: Project, window: FxWindow | null): Iterable<Layer> {
    for (const { composition, layer } of eachLayer(project)) {
      if (layer.params.kind !== 'Audio') continue
      if (window !== null && composition.id === project.root_id) {
        if (layer.t_end_us <= window.start_us || layer.t_start_us >= window.end_us) continue
      }
      yield layer
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  function cancelAllBakes(): void {
    for (const run of bakes.values()) {
      run.cancelled = true
      void backend.cancelAudioFx({ job_key: run.jobKey }).catch((e: unknown) => {
        console.warn(`[audio-fx] cancel ${run.jobKey} failed`, e)
      })
    }
    bakes.clear()
    for (const layerId of entries.keys()) patch(layerId, { pending: null })
  }

  function clearTimers(): void {
    for (const entry of entries.values()) {
      if (entry.timer !== null) clearT(entry.timer)
      entry.timer = null
    }
  }

  const unsubscribe = actor.subscribe((e: ChangeEvent) => {
    // The actor already isolates a throwing subscriber; this keeps OUR
    // bookkeeping consistent when one layer's derivation blows up.
    try { recompute(e.diff_hint, e.new_snapshot) }
    catch (err) { console.warn('[audio-fx] recompute threw', err) }
  })

  return {
    snapshot() {
      const out: AudioFxSnapshot = {}
      for (const [layerId, entry] of entries) out[layerId] = entry.state
      return out
    },

    layerAudioSources(project, window) {
      const out: Record<string, string> = {}
      for (const layer of audioLayersInWindow(project, window ?? null)) {
        const entry = entries.get(layer.id)
        const desiredSig = entry?.desired?.sig ?? null
        const ready = entry?.state.ready ?? null
        if (desiredSig === null || ready === null || ready.sig !== desiredSig) continue
        out[layer.id] = ready.audio_path
      }
      return out
    },

    async ensureExportAudioFx(window) {
      const project = actor.snapshot()
      recomputeAll(project)
      const layers = [...audioLayersInWindow(project, window ?? null)]
        .filter((layer) => entries.get(layer.id)?.desired != null)
      await Promise.all(layers.map((layer) => flushSettle(layer.id)))
      const waiting: string[] = []
      const failed: EnsureExportAudioFxResult['failed'] = []
      for (const layer of layers) {
        const entry = entries.get(layer.id)
        const d = entry?.desired
        if (!entry || !d) continue
        if (entry.state.ready?.sig === d.sig) continue
        const error = entry.state.error
        if (entry.failedSig === d.sig && error !== null) {
          failed.push({ layer_id: layer.id, effect_id: error.effect_id, kind: error.kind, error: error.message })
          continue
        }
        waiting.push(layer.id)
      }
      return { waiting, failed }
    },

    resolveWaveformKey(key) {
      const parsed = parseFxWaveformKey(key)
      if (parsed === null) return null
      const path = cacheLayout.waveformFx(parsed.mediaHash, parsed.sig16)
      return cachedOk(fs, path) ? path : null
    },

    async reverify(layerId) {
      const entry = entries.get(layerId)
      if (!entry) return
      const ready = entry.state.ready
      if (ready !== null) {
        if (!conformCachedOk(fs, ready.audio_path)) patch(layerId, { ready: null })
        else if (ready.peaks_path !== null && !cachedOk(fs, ready.peaks_path)) {
          // Only the waveform sibling evicted — the audio is still good, so keep
          // playing it and rebuild the picture.
          patch(layerId, { ready: { ...ready, peaks_path: PEAKS_PENDING } })
        }
      }
      // The deliberate retry: a consumer asking us to re-verify is asking for
      // another attempt, which is what lifts the no-auto-retry rule.
      entry.failedSig = null
      patch(layerId, { error: null })
      const project = actor.snapshot()
      const layer = findLayer(project, layerId)
      if (layer !== null) apply(project, layer)
      await flushSettle(layerId)
    },

    reset() {
      clearTimers()
      cancelAllBakes()
      conformAsked.clear()
      peaksInFlight.clear()
      // Entries are KEPT where the layer survives: a signature names a
      // content-addressed artifact, so a still-valid ready outlives a save-as.
      // `settle` re-probes the path (the cache root moves with the workspace).
      recomputeAll(actor.snapshot())
    },

    dispose() {
      unsubscribe()
      clearTimers()
      cancelAllBakes()
    },
  }
}
