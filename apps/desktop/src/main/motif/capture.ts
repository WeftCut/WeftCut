import { BrowserWindow, nativeImage } from 'electron'
import { MotifFrameSkippedError, OffscreenFrames, type FrameMarkerReader, type MotifOsrFrame } from './offscreenFrames.js'
import { BITMAP_CANVAS_RUNTIME_SOURCE } from './bitmapCanvasRuntime.js'
import { hardenWindow, markInternalWindow } from '../windows'
import { BUILTIN_MANIFESTS, motifCtxDurationS, type Manifest } from '../../shared/motifs/catalog.js'
import { MotifError, motifErrorCode, motifSuperseded } from '../../shared/motifs/errors.js'
import { resolveMotifMediaProps } from './mediaProps.js'
import { CAPTURE_HOST_FILE, FRAME_MARKER_ROWS } from '../../shared/motifs/frameMarker.js'
import { fitsMotifTexture } from '../../shared/motifs/limits.js'
import { MOTIF_DEADLINES, type MotifTuning } from '../../shared/motifs/tuning.js'
import type { UserMotifStore } from './store.js'
import type { MotifCaptureArgs, MotifFramePriority } from '../../shared/motifs/frameTransport.js'

export interface CaptureArgs extends MotifCaptureArgs {
  /// PNG captures only: the page still renders at width × height, and the
  /// image comes back scaled by this factor (MCP previews). Absent means 1.
  scale?: number
}

/** The tuning keys the capture host runs on (`shared/motifs/tuning.ts`). */
export type CaptureTuning = Pick<MotifTuning, 'framesInFlight' | 'captureFrameRate' | 'skippedFrameRetries' | 'backgroundAgingMs' | 'stallNudgeMs'>

/** The picture above the marker rows of a shared texture, as a PNG. */
export type TexturePngReader = (handle: Buffer, height: number) => Promise<Buffer>

/** What a capture reads from the Motif store. */
export type CaptureStore = Pick<UserMotifStore, 'getMotif' | 'assertRenderable' | 'pinPackage'>

export interface MotifCapturerDeps {
  tuning: CaptureTuning
  store: CaptureStore
  /// The clock-takeover runtime the renderer registers once at boot
  /// (`motif_register_runtime`); main injects it via
  /// addScriptToEvaluateOnNewDocument. Null until then.
  runtimeSource: () => string | null
  /// The native marker reader, where it exists. Without it the host takes
  /// bitmaps, which need no native reader.
  readFrameMarker: FrameMarkerReader | null
  /// Beside the marker reader: PNG captures on a texture host read the leased
  /// texture.
  readTexturePng: TexturePngReader | null
}

const newCaptureCounters = () => ({ captures: 0, completed: 0, failed: 0, pageLoads: 0, hostBuilds: 0, textureCaptures: 0, bitmapCaptures: 0, skippedFrames: 0, queueMs: 0, captureMs: 0, loadMs: 0, readyMs: 0, setupMs: 0, renderMs: 0, outputMs: 0 })
type CaptureCounters = ReturnType<typeof newCaptureCounters>

interface Host {
  win: BrowserWindow
  send: (method: string, params?: object, timeoutMs?: number, label?: string) => Promise<any>
  loadedId: string
  loadedV: string
  readyFor: string | null
  lastSize: { w: number; h: number } | null
  frames: OffscreenFrames
  /// Shared textures (Windows) or bitmaps; both are leased by frame id. See
  /// `wantsTextureHost`.
  texture: boolean
  /// The one URL the shell's frame may load: the Motif it was built for.
  motifUrl: string
}

interface Ticket {
  priority: MotifFramePriority
  queuedAt: number
  /// In its priority's queue, not running.
  queued: boolean
  /// Withdrawn by its caller: a skipped frame is not rendered again.
  cancelled: boolean
  reject: (e: Error) => void
  /// Renders the ticket's frame and returns once it has committed; the
  /// ticket's own waiter settles when its paint is consumed. Must never throw
  /// (a throw would strand every ticket queued behind it).
  run: () => Promise<void>
}
const PRIORITIES: readonly MotifFramePriority[] = ['current', 'ahead', 'background']

const FAILED_LANE_CAP = 128
const MANIFEST_CACHE_CAP = 32

const laneKeyOf = (motifId: string, contentHash: string) => `${motifId}\0${contentHash}`

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new MotifError('timeout', `motif capture timed out after ${ms}ms: ${label}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** A rendered frame: `delivered` settles once its paint is consumed. */
interface Rendered<T> { delivered: Promise<T> }

/** A capture's place in the queue. Only a queued capture moves or leaves it;
 * a running one finishes, and the caller drops what it no longer wants. */
export interface CaptureTicket {
  /// Moves a queued capture to the back of `priority`'s queue, down as well as
  /// up. A running one keeps the priority for a skipped frame's retry.
  setPriority(priority: MotifFramePriority): void
  /// Rejects a queued capture as superseded without rendering it.
  cancel(): void
}
export interface CaptureOptions {
  priority: MotifFramePriority
  /// Checked when the ticket reaches the host, before any page IO.
  isCurrent?: () => boolean
}
export interface CaptureRun<T> { result: Promise<T>; ticket: CaptureTicket }

const settledTicket: CaptureTicket = { setPriority: () => {}, cancel: () => {} }

/** Renders Motif frames on an offscreen capture host for every consumer:
 * preview, export, preparation, covers and MCP. */
export class MotifCapturer {
  private readonly tuning: CaptureTuning
  private readonly store: CaptureStore
  private readonly runtimeSource: () => string | null
  private readonly readFrameMarker: FrameMarkerReader | null
  private readonly readTexturePng: TexturePngReader | null

  private counters: CaptureCounters = newCaptureCounters()
  private readonly lanes = new Map<string, { motifId: string; contentHash: string; captures: number; pageLoads: number }>()

  private host: Host | null = null
  private textureEnabled = false

  // Serialize ALL captures (preview, export, preparation, MCP) on the one host —
  // single-threaded but await-interleaved. One FIFO queue per priority: a
  // `current` ticket dequeues ahead of any queued `ahead` one, and both ahead of
  // `background`, so lookahead and preparation never hold the frame the user is
  // looking at. A RUNNING capture is never preempted. A `background` ticket
  // waiting `backgroundAgingMs` gets one frame between higher ones, so enabled
  // background work cannot starve. The pump waits for a frame's render, not its
  // paint: the next frame renders while earlier ones are still on their way to
  // the capture (ADR 0159).
  private readonly queues: Record<MotifFramePriority, Ticket[]> = { current: [], ahead: [], background: [] }
  private pumping = false

  /// Failed lanes: capture errors attributable to the Motif's OWN content
  /// (a throwing or hung __motifRender), keyed by `${motifId}\0${contentHash}`,
  /// each a `content` MotifError.
  /// The window and CDP transport are healthy, so the host is NOT torn down —
  /// one broken Motif must not force re-navigation + runtime re-injection for
  /// every other Motif. Same-lane captures fast-reject with the recorded error
  /// until the lane key changes; a draft edit changes the blake3 contentHash,
  /// which is the invalidation signal, so recovery is automatic. That kills the
  /// per-sprite backoff retry storm against known-bad content. Empty contentHash
  /// (MCP callers) is never marked: with no hash there is no recovery signal.
  /// Bounded FIFO (`FAILED_LANE_CAP`) because drafts churn lane keys on every
  /// edit. Navigation bookkeeping (loadedId/loadedV/readyFor) stays host-global
  /// — one window can only ever hold one page.
  private readonly failedLanes = new Map<string, Error>()

  /// Lanes whose last attempt timed out and that hold one more try. A hung
  /// `__motifSetup`/`__motifRender` has two possible authors — the Motif's own
  /// script (an infinite loop: content) or a host wedged by load (transport) —
  /// and the deadline cannot tell them apart. A thrown exception latches the
  /// lane at once; a timeout is probation: the host is rebuilt either way, the
  /// lane gets exactly one retry on the fresh host, and a second consecutive
  /// timeout is the verdict. A success clears the probation. Without this, one
  /// slow frame under contention lost every frame of a user Motif for the
  /// session (built-ins have no contentHash and were never latched). Bounded
  /// like `failedLanes`; drafts churn lane keys on every edit.
  private readonly probationLanes = new Set<string>()

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

  /// Paints still to arrive for frames already rendered (ADR 0159). Settled
  /// whatever the outcome; tracked only to bound and drain the pipeline.
  private readonly framesInFlight = new Set<Promise<void>>()

  constructor(deps: MotifCapturerDeps) {
    this.tuning = deps.tuning
    this.store = deps.store
    this.runtimeSource = deps.runtimeSource
    this.readFrameMarker = deps.readFrameMarker
    this.readTexturePng = deps.readTexturePng
  }

  /** One frame leased to `consume`: a shared texture, released after `consume`
   * settles, or a bitmap. */
  captureFrame<T>(a: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, options: CaptureOptions): CaptureRun<T> {
    return this.enqueueCapture(a, () => this.doCapture(a, frame => {
      this.countFrame(frame)
      return consume(frame)
    }), options)
  }

  /** One frame as a base64 PNG of the picture, scaled by `a.scale` (MCP
   * previews, covers and the Motif panel's preview). */
  capturePng(a: CaptureArgs, { priority }: { priority: MotifFramePriority }): Promise<string> {
    return this.enqueueCapture(a, () => this.doCapture(a, async frame => {
      this.countFrame(frame)
      const png = frame.kind === 'bitmap'
        ? frame.image.crop({ x: 0, y: 0, width: frame.width, height: frame.height })
        : await this.texturePng(frame)
      if (a.scale === undefined || a.scale === 1) return (Buffer.isBuffer(png) ? png : png.toPNG()).toString('base64')
      const image = Buffer.isBuffer(png) ? nativeImage.createFromBuffer(png) : png
      return image.resize({ width: Math.max(1, Math.round(a.width * a.scale)), height: Math.max(1, Math.round(a.height * a.scale)), quality: 'best' }).toPNG().toString('base64')
    }), { priority }).result
  }

  /// Switches the host between shared textures and bitmaps; the next capture
  /// builds the host anew.
  setTextureEnabled(enabled: boolean): void {
    if (this.textureEnabled === enabled) return
    this.textureEnabled = enabled
    this.teardownHost()
  }

  /** Explicit retry revokes only this package's remembered content failure.
   * Automatic retries leave the failure latch intact to prevent retry storms. */
  resetFailure(motifId: string, contentHash: string): void {
    this.failedLanes.delete(laneKeyOf(motifId, contentHash))
  }

  /** Aggregate timings are deliberately content-free so diagnostics can compare
   * cold runs without exposing authored props or retaining an unbounded log. */
  diagnostics(reset = false) {
    if (reset) { this.counters = newCaptureCounters(); this.lanes.clear() }
    return { ...this.counters, queued: PRIORITIES.reduce((sum, priority) => sum + this.queues[priority].length, 0), running: this.pumping, lanes: [...this.lanes.values()].map(lane => ({ ...lane })) }
  }

  /// Retire the host for the rest of the process's life; the app's `before-quit`
  /// calls this.
  ///
  /// The latch is the load-bearing half, not the teardown. Quitting closes every
  /// window ASYNCHRONOUSLY, and a capture still queued on the capture queues
  /// resumes inside that gap: it finds `host` null and rebuilds it, so
  /// Electron's window list never empties, `will-quit` never fires, and the
  /// process runs forever. Tearing the host down without also refusing later
  /// captures re-opens that race.
  shutdown(): void {
    this.shuttingDown = true
    this.teardownHost()
  }

  private diagnosticsLane(motifId: string, contentHash: string) {
    const key = laneKeyOf(motifId, contentHash)
    let lane = this.lanes.get(key)
    if (!lane) {
      if (this.lanes.size >= 128) this.lanes.delete(this.lanes.keys().next().value!)
      lane = { motifId, contentHash, captures: 0, pageLoads: 0 }; this.lanes.set(key, lane)
    }
    return lane
  }

  private async timedCapture<T>(phase: 'loadMs' | 'readyMs' | 'setupMs' | 'renderMs' | 'outputMs', run: () => Promise<T>): Promise<T> {
    const started = performance.now(), counters = this.counters
    try { return await run() } finally { counters[phase] += performance.now() - started }
  }

  /// Shared textures only while the surface, marker rows included, fits the
  /// texture limit: its readback and copy must. A larger frame takes a bitmap
  /// host, which costs that size its GPU path and nothing else.
  private wantsTextureHost(width: number, height: number): boolean {
    return this.textureEnabled && this.readFrameMarker !== null && fitsMotifTexture(width, height + FRAME_MARKER_ROWS, 'copy')
  }

  private schedule(t: Ticket, first = false): void {
    const queue = this.queues[t.priority]
    if (first) queue.unshift(t)
    else queue.push(t)
    t.queued = true
    void this.pump()
  }

  private unschedule(t: Ticket): void {
    const queue = this.queues[t.priority]
    const i = queue.indexOf(t)
    if (i >= 0) queue.splice(i, 1)
    t.queued = false
  }

  private async pump(): Promise<void> {
    if (this.pumping) return // the running loop drains whatever lands behind it
    this.pumping = true
    const queues = this.queues
    let agedLast = false
    try {
      for (;;) {
        const next = queues.current[0] ?? queues.ahead[0]
        const waiting = queues.background[0]
        const aged: boolean = !agedLast && next !== undefined && waiting !== undefined
          && performance.now() - waiting.queuedAt >= this.tuning.backgroundAgingMs
        const t = aged || !next ? queues.background.shift() : queues[next.priority].shift()
        agedLast = aged
        if (!t) return
        t.queued = false
        await t.run()
      }
    } finally {
      this.pumping = false
    }
  }

  /** Latches the lane; returns the `content` error its captures now reject with. */
  private failLane(key: string, error: unknown): MotifError {
    const err = motifErrorCode(error) === 'content' ? error as MotifError
      : new MotifError('content', error instanceof MotifError ? error.detail : String((error as Error | undefined)?.message ?? error), { cause: error })
    if (this.failedLanes.size >= FAILED_LANE_CAP) this.failedLanes.delete(this.failedLanes.keys().next().value!)
    this.failedLanes.set(key, err)
    return err
  }

  /** True when this timeout is the lane's first strike and the lane may retry. */
  private grantProbation(key: string): boolean {
    if (this.probationLanes.has(key)) return false
    if (this.probationLanes.size >= FAILED_LANE_CAP) this.probationLanes.delete(this.probationLanes.values().next().value!)
    this.probationLanes.add(key)
    return true
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

  /// Builds the host of one document. The shell page, which runs no scripts of
  /// its own, is the window's only top-level navigation: a bitmap host paints
  /// real alpha only for a window's first document
  /// (docs/notes/electron-chromium-behavior.md#a-bitmap-osr-window-paints-alpha-only-for-its-first-document),
  /// so another Motif or content version gets a new window. The runtime is
  /// registered once the shell has loaded, and the shell then loads the Motif
  /// into its frame, whose documents the runtime reaches before their scripts.
  private async buildHost(motifId: string, contentHash: string, width: number, height: number): Promise<Host> {
    const runtime = this.runtimeSource()
    if (!runtime) throw new MotifError('closed', 'motif runtime not registered yet (call motif_register_runtime)')
    const texture = this.wantsTextureHost(width, height)
    const pinned = /^[0-9a-f]{64}$/.test(contentHash) && this.store.pinPackage(motifId, contentHash)
    // The shell frames the Motif above the surface's marker rows
    // (shared/motifs/frameMarker.ts); the Motif sees only its own size.
    const dir = `motif://${motifId}/${pinned ? `.revisions/${contentHash}/` : ''}`
    const query = `v=${encodeURIComponent(contentHash)}`
    const motifUrl = `${dir}index.html?${query}`
    // Sized to the capture before its document loads: the macOS bitmap host
    // drops a new document's first commit while the window and the page's
    // emulated size differ
    // (docs/notes/electron-chromium-behavior.md#macos-offscreen-bitmap-host-drops-the-first-commit-when-window-and-emulation-sizes-differ).
    const win = new BrowserWindow({
      show: false,
      width, height: height + FRAME_MARKER_ROWS, useContentSize: true,
      // The capture host renders untrusted, user-authored Motif content, so it runs
      // at the same isolation baseline as every other window: OS sandbox on, no Node,
      // context isolation, web security. The complementary egress half (no network /
      // no remote code) is the per-document CSP served by `motif://`; see docs/security.md.
      transparent: true,
      webPreferences: {
        offscreen: texture ? { useSharedTexture: true } : true, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        // A frame may otherwise draw before its images decode, and the frame id
        // proves only the commit, not that its images are in it.
        additionalArguments: ['--disable-checker-imaging'],
      },
    })
    this.counters.hostBuilds++
    // `offscreen: true` is a paint target, not a lifecycle class: unmarked, this
    // window votes in the quit decision and the app stops quitting when the editor
    // closes (windows.ts → quitIfLastUserWindowClosed). Before the awaits, per its
    // same-tick contract.
    markInternalWindow(win)
    const frames = new OffscreenFrames(win.webContents, texture ? this.readFrameMarker : null, MOTIF_DEADLINES.captureCommandMs, this.tuning.stallNudgeMs)
    // Navigation lockdown for the untrusted Motif page: deny every `window.open`
    // OUTRIGHT (allowExternalOpen:false — a Motif must not be able to pop the user's
    // browser) and block any page-initiated navigation off the app's content. The
    // main-process `loadURL` calls below are programmatic and don't trip will-navigate.
    hardenWindow(win, { allowExternalOpen: false })
    // hardenWindow guards the top frame; the Motif runs in the shell's frame.
    win.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame && event.url !== motifUrl) event.preventDefault()
    })
    this.counters.pageLoads++
    this.diagnosticsLane(motifId, contentHash).pageLoads++
    // Destroy the offscreen window if CDP init throws mid-build, else it orphans.
    // Bounded to ≤1 (captures are serialized) but still a leak; never observed green.
    try {
      const dbg = win.webContents.debugger
      dbg.attach('1.3')
      // Every CDP command is bounded by construction, including Emulation.
      // Callers cannot accidentally wedge the serial queue with an untimed send.
      const send = (method: string, params: object = {}, timeoutMs = MOTIF_DEADLINES.captureCommandMs, label = method) =>
        withTimeout(dbg.sendCommand(method, params), timeoutMs, label)
      await this.timedCapture('loadMs', () => withTimeout(win.loadURL(`${dir}${CAPTURE_HOST_FILE}?${query}`), MOTIF_DEADLINES.captureLoadMs, 'loadURL motif'))
      await send('Page.enable')
      await send('Runtime.enable')
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: texture ? runtime : BITMAP_CANVAS_RUNTIME_SOURCE + runtime,
      })
      // The emulation pins deviceScaleFactor to 1; the default background keeps
      // `background: transparent` real alpha.
      await send('Emulation.setDeviceMetricsOverride', { width, height: height + FRAME_MARKER_ROWS, deviceScaleFactor: 1, mobile: false })
      await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      const shell = await this.timedCapture('loadMs', () => send('Runtime.evaluate', {
        expression: `${runtime};window.__motifShellLoad()`, awaitPromise: true, returnByValue: true,
      }, MOTIF_DEADLINES.captureLoadMs, 'load Motif frame'))
      if (shell?.exceptionDetails) throw new Error('capture host shell failed: ' + JSON.stringify(shell.exceptionDetails))
      win.webContents.setFrameRate(this.tuning.captureFrameRate)
      return { win, send, loadedId: motifId, loadedV: contentHash, readyFor: null, lastSize: { w: width, h: height }, frames, texture, motifUrl }
    } catch (e) {
      frames.dispose()
      try { win.destroy() } catch { /* already gone */ }
      throw e
    }
  }

  /// Tears down `which` (default: the current host). A frame in flight on a host
  /// already replaced must not tear down its successor.
  private teardownHost(which: Host | null = this.host): void {
    if (!which) return
    which.frames.dispose()
    try { which.win.webContents.debugger.detach() } catch { /* already gone */ }
    try { which.win.destroy() } catch { /* already gone */ }
    if (this.host === which) this.host = null
  }

  private async ensureHost(a: CaptureArgs): Promise<Host> {
    // Reuse only when BOTH id and content version match (the ?v= cache-buster)
    // and the size wants the same kind of host.
    const host = this.host
    if (host?.loadedId === a.motifId && host.loadedV === a.contentHash && host.texture === this.wantsTextureHost(a.width, a.height)) return host
    this.teardownHost()
    const built = await this.buildHost(a.motifId, a.contentHash, a.width, a.height)
    this.host = built
    return built
  }

  private async waitReady(h: Host, motifId: string): Promise<void> {
    if (h.readyFor === motifId) return
    // Throw-until-ready: a false boolean would resolve to ready falsely. The
    // hostname guard closes the navigate→stale-page race: with `standard:true`
    // motif://<id>/… parses with hostname===id, so we verify the loaded page is
    // actually the motif we want (not a stale about:blank or prior motif).
    const probe =
      `(typeof window.__motifHostReady==='function' && window.__motifHostReady(${JSON.stringify(motifId)}))`
    for (let i = 0; i < MOTIF_DEADLINES.readyAttempts; i++) {
      // TIMED, unlike a plain send: a wedged offscreen renderer never settles a
      // sendCommand, and an untimed probe would hang the one serial capture
      // queue for the rest of the process's life — every motif in every project
      // frozen, no error anywhere. The timeout converts the wedge into an error, which
      // doCapture's catch answers with teardownHost → the next capture rebuilds.
      // A wedged page does not unwedge between polls, so the throw also skips the
      // remaining attempts (they exist for a LOADING page, which fails fast).
      const r = await h.send('Runtime.evaluate', { expression: probe, returnByValue: true })
      if (r?.result?.value === true) { h.readyFor = motifId; return }
      await delay(MOTIF_DEADLINES.readyPollMs)
    }
    throw new MotifError('content', `motif '${motifId}' never became ready (Motif frame not loaded, __motifRender undefined, or wrong host page loaded)`)
  }

  /// Waits until every rendered frame has its paint. A navigation or resize
  /// replaces the surface those paints come from.
  private async drainFrames(): Promise<void> {
    while (this.framesInFlight.size) await Promise.all(this.framesInFlight)
  }

  /// Renders one frame and leases the paint carrying its id; returns once the
  /// frame has committed, so the queue can render the next one while this one is
  /// still on its way to the capture. `output` runs inside the lease.
  private async doCapture<T>(a: CaptureArgs, output: (frame: MotifOsrFrame) => Promise<T>): Promise<Rendered<T>> {
    // Refuse rather than resurrect — see `shutdown`.
    if (this.shuttingDown) throw new MotifError('closed', 'motif capture host is shut down (the app is quitting)')
    this.store.assertRenderable(a.motifId)
    const lane = laneKeyOf(a.motifId, a.contentHash)
    const host = this.host
    const samePage = host?.loadedId === a.motifId && host.loadedV === a.contentHash
      && host.lastSize?.w === a.width && host.lastSize?.h === a.height
    if (!samePage) await this.drainFrames()
    while (this.framesInFlight.size >= this.tuning.framesInFlight) await Promise.race(this.framesInFlight)
    let h: Host
    try {
      h = await this.ensureHost(a)
      await this.timedCapture('readyMs', () => this.waitReady(h, a.motifId))
    } catch (e) {
      // Transport class: no Motif code ran (host build, loadURL, wedged/never-
      // ready probe), so nothing here is attributable to page content — tear
      // down and let the next capture rebuild.
      this.teardownHost()
      throw e
    }
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
    try {
      if (h.lastSize?.w !== a.width || h.lastSize?.h !== a.height) {
        // Another size for the same document; the window follows, as at build.
        h.win.setContentSize(a.width, a.height + FRAME_MARKER_ROWS)
        await h.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height + FRAME_MARKER_ROWS, deviceScaleFactor: 1, mobile: false })
        h.lastSize = { w: a.width, h: a.height }
      }
    } catch (e) {
      this.teardownHost(h) // transport: wedged host — rebuild on next call
      throw e
    }
    let ev: any
    let phase = '__motifSetup'
    let lease: ReturnType<OffscreenFrames['expect']> | null = null
    try {
      const setup = await this.timedCapture('setupMs', () => h.send('Runtime.evaluate', {
        expression: `window.__motifSetup(${JSON.stringify(props)}, ${JSON.stringify(meta)})`,
        awaitPromise: true, returnByValue: true,
      }, MOTIF_DEADLINES.captureSetupMs, 'setup (model loading / decoder initialization)'))
      // Setup failures use the same lane handling as frame failures; the runtime
      // has already retired its workers. A timeout tears down the entire host.
      if (setup?.exceptionDetails) ev = setup
      else {
        phase = '__motifRender'
        lease = h.frames.expect(a.width, a.height)
        const expr = `window.__motifRender(${JSON.stringify(a.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify({ ...meta, frameId: lease.id })})`
        ev = await this.timedCapture('renderMs', () => h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
      }
    } catch (e) {
      lease?.cancel()
      // A hung __motifSetup/__motifRender wedges the renderer for every other
      // lane, so the host is rebuilt whatever the cause. Whether the LANE is
      // latched depends on the author: a timeout is ambiguous (content or load)
      // and earns one retry on the rebuilt host; anything else, and a second
      // consecutive timeout, latches it so its sprites stop retrying.
      this.teardownHost(h)
      if (a.contentHash !== '' && !(motifErrorCode(e) === 'timeout' && this.grantProbation(lane))) throw this.failLane(lane, e)
      throw e
    }
    this.probationLanes.delete(lane)
    if (ev?.exceptionDetails) {
      // Content error: the Motif's script threw. The window and CDP transport
      // answered fine, so tearing the host down would punish every other Motif
      // with re-navigation + runtime re-injection. Fail the LANE instead —
      // same-lane captures fast-reject until contentHash changes (see failedLanes).
      lease?.cancel()
      const err = new MotifError('content', phase + ' threw: ' + JSON.stringify(ev.exceptionDetails))
      if (a.contentHash !== '') this.failLane(lane, err)
      throw err
    }
    const leased = lease!
    const delivered = this.timedCapture('outputMs', async () => {
      let frame: MotifOsrFrame
      try { frame = await leased.frame }
      catch (e) {
        // A skipped frame is rendered again; the host is healthy.
        if (!(e instanceof MotifFrameSkippedError)) this.teardownHost(h)
        throw e
      }
      // The host painted this frame, so an output failure is its consumer's.
      // Tearing the host down here would fail the other frames in flight on it.
      try { return await output(frame) }
      finally { if (frame.kind === 'texture') frame.texture.release() }
    })
    const settled = delivered.then(() => {}, () => {})
    this.framesInFlight.add(settled)
    void settled.then(() => this.framesInFlight.delete(settled))
    return { delivered }
  }

  private enqueueCapture<T>(a: CaptureArgs, run: () => Promise<Rendered<T>>, { priority, isCurrent = () => true }: CaptureOptions): CaptureRun<T> {
    // Fast-reject a lane whose content already failed this session: same
    // (motifId, contentHash) means the same throwing script against the same
    // page — don't spend queue slots or CDP round trips proving it again.
    const lane = laneKeyOf(a.motifId, a.contentHash)
    const laneError = this.failedLanes.get(lane)
    if (laneError) return { result: Promise.reject(laneError), ticket: settledTicket }
    const queuedAt = performance.now()
    let resolve!: (value: T) => void, reject!: (e: Error) => void
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    // Renders the frame; its waiter settles with the paint. A frame the
    // compositor skipped goes back to the head of its queue, as the same ticket.
    const attempt = async (retries: number): Promise<void> => {
      // The lane may have failed while this ticket sat queued.
      const err = this.failedLanes.get(lane)
      if (err) { reject(err); return }
      const started = performance.now(), counters = this.counters
      if (retries === 0) {
        counters.queueMs += started - queuedAt
        counters.captures++
        this.diagnosticsLane(a.motifId, a.contentHash).captures++
      }
      const finish = (error: unknown | null, value?: T) => {
        counters.captureMs += performance.now() - started
        if (error === null) { counters.completed++; resolve(value as T); return }
        if (error instanceof MotifFrameSkippedError && retries < this.tuning.skippedFrameRetries && !ticket.cancelled) {
          counters.skippedFrames++
          ticket.run = () => attempt(retries + 1)
          this.schedule(ticket, true)
          return
        }
        counters.failed++
        reject(ticket.cancelled && error instanceof MotifFrameSkippedError ? motifSuperseded() : error as Error)
      }
      try {
        if (!isCurrent()) throw motifSuperseded()
        const { delivered } = await run()
        delivered.then(value => finish(null, value), finish)
      } catch (e) { finish(e) }
    }
    const ticket: Ticket = { priority, queuedAt, queued: false, cancelled: false, reject, run: () => attempt(0) }
    this.schedule(ticket)
    return {
      result,
      ticket: {
        setPriority: next => {
          if (next === ticket.priority) return
          if (!ticket.queued) { ticket.priority = next; return }
          this.unschedule(ticket)
          ticket.priority = next
          this.schedule(ticket)
        },
        cancel: () => {
          ticket.cancelled = true
          if (!ticket.queued) return
          this.unschedule(ticket)
          reject(motifSuperseded())
        },
      },
    }
  }

  private async texturePng(frame: Extract<MotifOsrFrame, { kind: 'texture' }>): Promise<Buffer> {
    const handle = frame.texture.textureInfo.handle.ntHandle
    if (!this.readTexturePng || !handle) throw new MotifError('device', 'Motif texture PNG readback unavailable')
    return this.readTexturePng(handle, frame.height)
  }

  private countFrame(frame: MotifOsrFrame): void {
    if (frame.kind === 'texture') this.counters.textureCaptures++
    else this.counters.bitmapCaptures++
  }
}
