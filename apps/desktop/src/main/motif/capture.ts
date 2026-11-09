import { nativeImage } from 'electron'
import type { MotifOsrFrame } from './offscreenFrames.js'
import type { MotifMarkerReader, MotifTextureReader } from './native.js'
import { CaptureQueue, type CaptureArgs, type CaptureOptions, type CaptureRun, type Rendered } from './captureQueue.js'
import { HostPool, type HostKey, type HostPoolLease } from './hostPool.js'
import { CaptureHost, HostRenderError, type CapturePhase } from './captureHost.js'
import { LanePolicy } from './lanePolicy.js'
import { BUILTIN_MANIFESTS, motifCtxDurationS, type Manifest } from '../../shared/motifs/catalog.js'
import { MotifError } from '../../shared/motifs/errors.js'
import { resolveMotifMediaProps } from './mediaProps.js'
import { frameMarkerRows } from '../../shared/motifs/frameMarker.js'
import { fitsMotifTexture } from '../../shared/motifs/limits.js'
import type { MotifTuning } from '../../shared/motifs/tuning.js'
import type { UserMotifStore } from './store.js'
import type { MotifFramePriority } from '../../shared/motifs/frameTransport.js'

/** The tuning keys the capture hosts run on (`shared/motifs/tuning.ts`). */
export type CaptureTuning = Pick<MotifTuning, 'captureHosts' | 'framesInFlight' | 'captureFrameRate' | 'skippedFrameRetries' | 'backgroundAgingMs' | 'hostAffinityMs' | 'stallNudgeMs'>

/** What a capture reads from the Motif store. */
export type CaptureStore = Pick<UserMotifStore, 'getMotif' | 'assertRenderable' | 'pinPackage'>

export interface MotifCapturerDeps {
  tuning: CaptureTuning
  store: CaptureStore
  /// The clock-takeover runtime the renderer registers once at boot
  /// (`motif_register_runtime`); main injects it via
  /// addScriptToEvaluateOnNewDocument. Null until then.
  runtimeSource: () => string | null
  /// The native marker reader, where it exists. Without it the hosts take
  /// bitmaps, which need no native reader.
  markerReader: Pick<MotifMarkerReader, 'read'> | null
  /// Beside the marker reader: PNG captures on a texture host read the leased
  /// texture.
  textureReader: Pick<MotifTextureReader, 'read'> | null
}

const newCaptureCounters = () => ({ captures: 0, completed: 0, failed: 0, pageLoads: 0, hostBuilds: 0, hostSwaps: 0, hostEvictions: 0, affinityPicks: 0, textureCaptures: 0, bitmapCaptures: 0, skippedFrames: 0, queueMs: 0, captureMs: 0, loadMs: 0, readyMs: 0, setupMs: 0, renderMs: 0, outputMs: 0 })
type CaptureCounters = ReturnType<typeof newCaptureCounters>

const DIAGNOSTIC_LANE_CAP = 128
const MANIFEST_CACHE_CAP = 32
/// Hosts one render step may ask for when each retires before the step
/// renders. A fresh host has nothing in flight to wait on, so only a
/// `setTextureEnabled` or a failure landing between its open and its render
/// retires it; this bounds a storm of those.
const HOSTS_PER_STEP = 3

const laneKeyOf = (motifId: string, contentHash: string) => `${motifId}\0${contentHash}`
const closedError = () => new MotifError('closed', 'motif capture host is shut down (the app is quitting)')

/** Renders Motif frames on a pool of offscreen capture hosts for every
 * consumer: preview, export, preparation, covers and MCP. The queue orders
 * captures (`captureQueue.ts`), the pool owns the hosts (`hostPool.ts`), a
 * host owns its window and frames in flight (`captureHost.ts`), and the lane
 * policy remembers content failures (`lanePolicy.ts`). */
export class MotifCapturer {
  private readonly tuning: CaptureTuning
  private readonly store: CaptureStore
  private readonly runtimeSource: () => string | null
  private readonly markerReader: Pick<MotifMarkerReader, 'read'> | null
  private readonly textureReader: Pick<MotifTextureReader, 'read'> | null

  private counters: CaptureCounters = newCaptureCounters()
  private readonly lanes = new Map<string, { motifId: string; contentHash: string; captures: number; pageLoads: number }>()

  private readonly pool: HostPool<CaptureHost>
  private readonly queue: CaptureQueue<HostPoolLease<CaptureHost>>
  private readonly failures = new LanePolicy()
  private textureEnabled = false

  /// Resolved user-Motif manifests keyed by `${motifId}\0${contentHash}`:
  /// getMotif is readFileSync + parseManifestIsland — synchronous fs on the
  /// capture hot path, once per frame. The content hash IS the invalidation
  /// signal, so caching by it is exact. Empty contentHash (MCP callers) is never
  /// cached: no invalidation signal. FIFO-evicted at `MANIFEST_CACHE_CAP` —
  /// drafts churn keys on every edit. Built-ins never reach here (already in RAM).
  private readonly manifestCache = new Map<string, Manifest | null>()

  /// Latched by `shutdown` — a capture that wakes up afterwards must not build
  /// a window. See there for why.
  private shuttingDown = false

  constructor(deps: MotifCapturerDeps) {
    this.tuning = deps.tuning
    this.store = deps.store
    this.runtimeSource = deps.runtimeSource
    this.markerReader = deps.markerReader
    this.textureReader = deps.textureReader
    this.pool = new HostPool({
      capacity: deps.tuning.captureHosts,
      affinityMs: deps.tuning.hostAffinityMs,
      hostKeyOf: a => ({ motifId: a.motifId, contentHash: a.contentHash, texture: this.wantsTextureHost(a.width, a.height) }),
      open: (key, a) => this.openHost(key, a),
      evicted: () => { this.counters.hostEvictions++ },
      swap: (host, key) => this.swapHost(host, key),
    })
    this.queue = new CaptureQueue(this.pool, deps.tuning, {
      // Fast-reject a lane whose content failed while the ticket waited.
      refuse: a => this.failures.failure(a.motifId, a.contentHash) ?? null,
      started: (a, queuedMs) => {
        this.counters.queueMs += queuedMs
        this.counters.captures++
        this.diagnosticsLane(a.motifId, a.contentHash).captures++
      },
      settled: (outcome, captureMs) => {
        this.counters.captureMs += captureMs
        if (outcome === 'completed') this.counters.completed++
        else if (outcome === 'skipped') this.counters.skippedFrames++
        else this.counters.failed++
      },
      affinityPick: () => { this.counters.affinityPicks++ },
    })
  }

  /** One frame leased to `consume`: a shared texture, released after `consume`
   * settles, or a bitmap. */
  captureFrame<T>(a: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, options: CaptureOptions): CaptureRun<T> {
    return this.enqueueCapture(a, frame => {
      this.countFrame(frame)
      return consume(frame)
    }, options)
  }

  /** One frame as a base64 PNG of the picture, scaled by `a.scale` (MCP
   * previews, covers and the Motif panel's preview). */
  capturePng(a: CaptureArgs, { priority }: { priority: MotifFramePriority }): Promise<string> {
    return this.enqueueCapture(a, async frame => {
      this.countFrame(frame)
      const png = frame.kind === 'bitmap'
        ? frame.image.crop({ x: 0, y: 0, width: frame.width, height: frame.height })
        : await this.texturePng(frame)
      if (a.scale === undefined || a.scale === 1) return (Buffer.isBuffer(png) ? png : png.toPNG()).toString('base64')
      const image = Buffer.isBuffer(png) ? nativeImage.createFromBuffer(png) : png
      return image.resize({ width: Math.max(1, Math.round(a.width * a.scale)), height: Math.max(1, Math.round(a.height * a.scale)), quality: 'best' }).toPNG().toString('base64')
    }, { priority }).result
  }

  /// Switches the hosts between shared textures and bitmaps; the next capture
  /// opens its host anew.
  setTextureEnabled(enabled: boolean): void {
    if (this.textureEnabled === enabled) return
    this.textureEnabled = enabled
    this.pool.retireAll()
  }

  /** Explicit retry revokes only this package's remembered content failure.
   * Automatic retries leave the failure latch intact to prevent retry storms. */
  resetFailure(motifId: string, contentHash: string): void {
    this.failures.reset(motifId, contentHash)
  }

  /** Aggregate timings are deliberately content-free so diagnostics can compare
   * cold runs without exposing authored props or retaining an unbounded log. */
  diagnostics(reset = false) {
    if (reset) { this.counters = newCaptureCounters(); this.lanes.clear() }
    return {
      ...this.counters,
      queued: this.queue.queued,
      rendering: this.queue.rendering,
      lanes: [...this.lanes.values()].map(lane => ({ ...lane })),
      hosts: this.pool.diagnostics(),
    }
  }

  /// Retire the hosts for the rest of the process's life; the app's
  /// `before-quit` calls this. Queued captures, and any queued later, reject
  /// `closed` at once.
  ///
  /// The latch is the load-bearing half, not the teardown. Quitting closes every
  /// window ASYNCHRONOUSLY, and a capture already running resumes inside that
  /// gap: were it to open a host, Electron's window list would never empty,
  /// `will-quit` would never fire, and the process would run forever. Retiring
  /// the hosts without also refusing later captures re-opens that race.
  shutdown(): void {
    this.shuttingDown = true
    this.queue.close(closedError())
    this.pool.shutdown()
  }

  private diagnosticsLane(motifId: string, contentHash: string) {
    const key = laneKeyOf(motifId, contentHash)
    let lane = this.lanes.get(key)
    if (!lane) {
      if (this.lanes.size >= DIAGNOSTIC_LANE_CAP) this.lanes.delete(this.lanes.keys().next().value!)
      lane = { motifId, contentHash, captures: 0, pageLoads: 0 }; this.lanes.set(key, lane)
    }
    return lane
  }

  private async timed<T>(phase: CapturePhase, run: () => Promise<T>): Promise<T> {
    const started = performance.now(), counters = this.counters
    try { return await run() } finally { counters[phase] += performance.now() - started }
  }

  /// Shared textures only while the surface, marker rows included, fits the
  /// texture limit: its readback and copy must. A larger frame takes a bitmap
  /// host, which costs that size its GPU path and nothing else.
  private wantsTextureHost(width: number, height: number): boolean {
    return this.textureEnabled && this.markerReader !== null && fitsMotifTexture(width, height + frameMarkerRows(width), 'copy')
  }

  private openHost(key: HostKey, a: CaptureArgs): Promise<CaptureHost> {
    const runtime = this.runtimeSource()
    if (!runtime) throw new MotifError('closed', 'motif runtime not registered yet (call motif_register_runtime)')
    const pin = /^[0-9a-f]{64}$/.test(key.contentHash) ? this.store.pinPackage(key.motifId, key.contentHash) : null
    this.counters.hostBuilds++
    this.counters.pageLoads++
    this.diagnosticsLane(key.motifId, key.contentHash).pageLoads++
    // The host releases the pin when it retires; a build that throws before
    // the host exists releases it here.
    return CaptureHost.open(key, { width: a.width, height: a.height }, pin, {
      runtime, markerReader: this.markerReader, tuning: this.tuning,
      timed: (phase, run) => this.timed(phase, run),
    }).catch((e: unknown) => { pin?.release(); throw e })
  }

  /// Shows another content version of `host`'s Motif in its window, from a
  /// pin of that version's revision.
  private swapHost(host: CaptureHost, key: HostKey): Promise<boolean> {
    const pin = /^[0-9a-f]{64}$/.test(key.contentHash) ? this.store.pinPackage(key.motifId, key.contentHash) : null
    this.counters.hostSwaps++
    this.counters.pageLoads++
    this.diagnosticsLane(key.motifId, key.contentHash).pageLoads++
    return host.swap(key, pin)
  }

  private manifestFor(a: CaptureArgs): Manifest | undefined {
    const builtin = BUILTIN_MANIFESTS.get(a.motifId)
    if (builtin) return builtin
    if (a.contentHash === '') return this.store.getMotif(a.motifId)?.manifest
    const key = laneKeyOf(a.motifId, a.contentHash)
    if (this.manifestCache.has(key)) return this.manifestCache.get(key) ?? undefined
    const manifest = this.store.getMotif(a.motifId)?.manifest ?? null
    if (this.manifestCache.size >= MANIFEST_CACHE_CAP) this.manifestCache.delete(this.manifestCache.keys().next().value!)
    this.manifestCache.set(key, manifest)
    return manifest ?? undefined
  }

  /// Renders one frame on the leased host; returns once the frame has
  /// committed. `output` runs inside the frame's lease.
  private async render<T>(lease: HostPoolLease<CaptureHost>, a: CaptureArgs, output: (frame: MotifOsrFrame) => Promise<T>): Promise<Rendered<T>> {
    // Refuse rather than resurrect — see `shutdown`.
    if (this.shuttingDown) throw closedError()
    this.store.assertRenderable(a.motifId)
    const manifest = this.manifestFor(a)
    // A `media` prop becomes a URL on the Motif's origin before setup sees it.
    const props = await resolveMotifMediaProps(a.motifId, manifest, JSON.parse(a.propsJson) as Record<string, unknown>)
    const duration = manifest ? motifCtxDurationS(manifest, props) : 5
    // meta.fps must be the rate the caller computed tSec on (the composition's
    // fps) — a Motif reading it (or ctx.frame = round(t*fps)) renders wrong when
    // it disagrees. 30 only when no rate arrived (MCP without a project, legacy).
    const fps =
      a.fpsNum != null && a.fpsDen != null && a.fpsNum > 0 && a.fpsDen > 0
        ? a.fpsNum / a.fpsDen
        : 30
    const meta = { duration, width: a.width, height: a.height, fps }
    // Opening and readiness are the host's, never the Motif's content: a
    // failure retires the host and the next capture opens another.
    let host = await lease.host(a)
    for (let hosts = 1; ; hosts++) {
      // A frame without the Motif's served page (`unready`) is the host's: it
      // retired, and its `transient` error leaves the lane open to the retry.
      try { await host.prepare(a.width, a.height) }
      catch (e) { throw e instanceof HostRenderError ? e.error : e }
      // LANDMINE: no await between this check and `host.render`. A host that
      // retired while the step waited would fail the render as a transport
      // failure and spend the lane's probation on content that never ran.
      if (!host.retired) break
      if (hosts >= HOSTS_PER_STEP) throw new MotifError('transient', `motif capture host retired ${hosts} times before the frame could render`)
      host = await lease.host(a)
    }
    try {
      const rendered = await host.render({ tSec: a.tSec, width: a.width, height: a.height, props, meta }, output)
      this.failures.rendered(a.motifId, a.contentHash)
      return rendered
    } catch (e) {
      if (!(e instanceof HostRenderError)) throw e
      // A timeout or a transport failure mid-step is ambiguous (content or
      // load) and earns the lane one retry on a new host; a throw in the
      // Motif's served page, and a second consecutive ambiguous failure, latch
      // it so its sprites stop retrying.
      if (e.kind !== 'threw') throw this.failures.ambiguous(a.motifId, a.contentHash, e.error)
      this.failures.rendered(a.motifId, a.contentHash)
      throw this.failures.threw(a.motifId, a.contentHash, e.error)
    }
  }

  private enqueueCapture<T>(a: CaptureArgs, output: (frame: MotifOsrFrame) => Promise<T>, options: CaptureOptions): CaptureRun<T> {
    // Same (motifId, contentHash) as a recorded failure means the same throwing
    // script against the same page — don't spend queue slots or CDP round
    // trips proving it again.
    const laneError = this.failures.failure(a.motifId, a.contentHash)
    if (laneError) return CaptureQueue.rejected(laneError)
    return this.queue.enqueue(a, lease => this.render(lease, a, output), options)
  }

  private async texturePng(frame: Extract<MotifOsrFrame, { kind: 'texture' }>): Promise<Buffer> {
    const handle = frame.texture.textureInfo.handle.ntHandle
    if (!this.textureReader || !handle) throw new MotifError('device', 'Motif texture PNG readback unavailable')
    return (await this.textureReader.read(handle, frame.height)).finish('png')
  }

  private countFrame(frame: MotifOsrFrame): void {
    if (frame.kind === 'texture') this.counters.textureCaptures++
    else this.counters.bitmapCaptures++
  }
}
