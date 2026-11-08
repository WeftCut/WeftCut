import { BrowserWindow, nativeImage } from 'electron'
import { MotifFrameSkippedError, OffscreenFrames, type FrameMarkerReader, type MotifOsrFrame } from './offscreenFrames.js'
import { BITMAP_CANVAS_RUNTIME_SOURCE } from './bitmapCanvasRuntime.js'
import { hardenWindow, markInternalWindow } from '../windows'
import { BUILTIN_MANIFESTS, motifCtxDurationS, type Manifest } from '../../shared/motifs/catalog.js'
import { MotifError, motifErrorCode, motifSuperseded } from '../../shared/motifs/errors.js'
import { resolveMotifMediaProps } from './mediaProps.js'
import { CAPTURE_HOST_FILE, FRAME_MARKER_ROWS } from '../../shared/motifs/frameMarker.js'
import type { UserMotifStore } from './store.js'

export interface CaptureArgs {
  motifId: string
  tSec: number
  propsJson: string
  width: number
  height: number
  contentHash: string
  /// Composition fps as an exact rational, when the caller knows it. Absent or
  /// invalid falls back to 30 (the pre-threading behaviour), keeping MCP and
  /// older callers safe.
  fpsNum?: number
  fpsDen?: number
  /// PNG captures only: the page still renders at width × height, and the
  /// image comes back scaled by this factor (MCP previews). Absent means 1.
  scale?: number
}

const CAPTURE_TIMEOUT_MS = 5000
const SETUP_TIMEOUT_MS = 30_000
const READY_ATTEMPTS = 30
const READY_POLL_MS = 100
const MAX_BACKGROUND_WAIT_MS = 2000
/// Frames rendered while earlier ones are still on their way to a paint
/// (ADR 0159). Each frame's render returns once the frame has committed, so a
/// deeper pipeline only holds more capture surfaces.
const MAX_FRAMES_IN_FLIGHT = 3
/// Paint rate of the capture host while frames are in flight; the host renders
/// one pipelined frame per BeginFrame.
const CAPTURE_FRAME_RATE = 120
/// A frame the compositor skipped is rendered again at most this many times.
const SKIPPED_FRAME_RETRIES = 3

const newCaptureCounters = () => ({ captures: 0, completed: 0, failed: 0, pageLoads: 0, hostBuilds: 0, textureCaptures: 0, bitmapCaptures: 0, skippedFrames: 0, queueMs: 0, captureMs: 0, loadMs: 0, readyMs: 0, setupMs: 0, renderMs: 0, outputMs: 0 })
let captureCounters = newCaptureCounters()
const captureLanes = new Map<string, { motifId: string; contentHash: string; captures: number; pageLoads: number }>()
function diagnosticsLane(motifId: string, contentHash: string) {
  const key = `${motifId}\0${contentHash}`
  let lane = captureLanes.get(key)
  if (!lane) {
    if (captureLanes.size >= 128) captureLanes.delete(captureLanes.keys().next().value!)
    lane = { motifId, contentHash, captures: 0, pageLoads: 0 }; captureLanes.set(key, lane)
  }
  return lane
}
/** Aggregate timings are deliberately content-free so diagnostics can compare
 * cold runs without exposing authored props or retaining an unbounded log. */
export function captureDiagnostics(reset = false) {
  if (reset) { captureCounters = newCaptureCounters(); captureLanes.clear() }
  return { ...captureCounters, queued: highQueue.filter(t => !t.stale).length + lowQueue.filter(t => !t.stale).length, running: pumping, lanes: [...captureLanes.values()].map(lane => ({ ...lane })) }
}
async function timedCapture<T>(phase: 'loadMs' | 'readyMs' | 'setupMs' | 'renderMs' | 'outputMs', run: () => Promise<T>): Promise<T> {
  const started = performance.now(), counters = captureCounters
  try { return await run() } finally { counters[phase] += performance.now() - started }
}

let runtimeSource: string | null = null
/// The renderer registers the clock-takeover runtime once at boot
/// (`motif_register_runtime`); main injects it via addScriptToEvaluateOnNewDocument.
export function setRuntimeSource(src: string): void {
  runtimeSource = src
}

let motifStore: UserMotifStore | null = null
/// Set once at boot (after UserMotifStore is constructed in index.ts), mirrors
/// the setRuntimeSource singleton pattern so MCP and IPC call sites stay thin.
export function setMotifStore(s: UserMotifStore): void {
  motifStore = s
}

interface Host {
  win: BrowserWindow
  send: (method: string, params?: object, timeoutMs?: number, label?: string) => Promise<any>
  loadedId: string
  loadedV: string
  readyFor: string | null
  lastSize: { w: number; h: number } | null
  frames: OffscreenFrames
  /// Shared textures (Windows) or bitmaps; both are leased by frame id.
  texture: boolean
  /// The one URL the shell's frame may load: the Motif it was built for.
  motifUrl: string
}
let host: Host | null = null
let textureCaptureEnabled = false
/// Switches the host between shared textures and bitmaps; the next capture
/// builds the host anew.
export function setTextureCaptureEnabled(enabled: boolean): void {
  if (textureCaptureEnabled === enabled) return
  textureCaptureEnabled = enabled
  teardownHost()
}

let readFrameMarker: FrameMarkerReader | null = null
/// Set once at boot where the native marker reader exists. Without it the host
/// takes bitmaps, which need no native reader.
export function setFrameMarkerReader(read: FrameMarkerReader): void {
  readFrameMarker = read
}

/** The picture above the marker rows of a shared texture, as a PNG. */
export type TexturePngReader = (handle: Buffer, height: number) => Promise<Buffer>
let readTexturePng: TexturePngReader | null = null
/// Set once at boot beside the marker reader: PNG captures on a texture host
/// read the leased texture.
export function setTexturePngReader(read: TexturePngReader): void {
  readTexturePng = read
}

// Serialize ALL captures (on-demand sprite / prewarmer / baker / MCP) on the
// one host — single-threaded but await-interleaved. Two FIFO queues replace a
// bare promise chain so a HIGH ticket (keyed: the on-demand sprite frame the
// user is looking at NOW) dequeues ahead of any queued LOW ticket (keyless
// prewarmer/baker/MCP): during playback the prewarmer used to hold the chain
// while fresh sprite frames waited behind it (5b7cbaec). A RUNNING capture is
// never preempted. Old LOW work receives one frame between HIGH frames after
// two seconds, so explicitly enabled background work cannot starve forever.
// The pump waits for a frame's render, not its paint: the next frame renders
// while earlier ones are still on their way to the capture (ADR 0159).
interface Ticket {
  /// Coalesce key when keyed; lets the pump drop the ticket from queuedKeys
  /// the moment it passes the replaceable window.
  key: string | undefined
  high: boolean
  queuedAt: number
  /// Set by a superseding same-key request: the waiter was already rejected,
  /// so the pump must skip this ticket instead of executing a stale frame.
  stale: boolean
  reject: (e: Error) => void
  /// Renders the ticket's frame and returns once it has committed; the
  /// ticket's own waiter settles when its paint is consumed. Must never throw
  /// (a throw would strand every ticket queued behind it).
  run: () => Promise<void>
}
const highQueue: Ticket[] = []
const lowQueue: Ticket[] = []
let pumping = false

function schedule(t: Ticket, first = false): void {
  const queue = t.high ? highQueue : lowQueue
  if (first) queue.unshift(t)
  else queue.push(t)
  void pump()
}

async function pump(): Promise<void> {
  if (pumping) return // the running loop drains whatever lands behind it
  pumping = true
  let agedLast = false
  try {
    for (;;) {
      while (highQueue[0]?.stale) highQueue.shift()
      while (lowQueue[0]?.stale) lowQueue.shift()
      const aged: boolean = !agedLast && highQueue.length > 0 && lowQueue[0] !== undefined
        && performance.now() - lowQueue[0].queuedAt >= MAX_BACKGROUND_WAIT_MS
      const t = aged ? lowQueue.shift() : highQueue.shift() ?? lowQueue.shift()
      agedLast = aged
      if (!t) return
      // A superseded ticket must not occupy its HIGH slot when reached.
      if (t.stale) continue
      // Past the replaceable window — leave the map before running.
      if (t.key !== undefined && queuedKeys.get(t.key) === t) queuedKeys.delete(t.key)
      await t.run()
    }
  } finally {
    pumping = false
  }
}

/// Queued (not yet running) keyed captures, latest-wins per key. The on-demand
/// sprite path keys by layer id, so during playback each tick's fresh frame
/// replaces the still-queued previous one: its waiter rejects IMMEDIATELY as
/// `superseded` and its queue slot no-ops when reached — the one
/// serial queue never spends capture-seconds executing a frame nobody wants
/// anymore. Without this, real-time playback enqueues ~30 requests/s per
/// visible motif against a ~1 s/capture queue, and the unbounded backlog
/// starves the prewarmer AND the L2 baker queued behind it. Keyless requests
/// (prewarmer, baker, MCP) are never superseded: their frames stay wanted.
const queuedKeys = new Map<string, Ticket>()

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
/// Bounded FIFO because drafts churn lane keys on every edit. Navigation
/// bookkeeping (loadedId/loadedV/readyFor) stays host-global — one window can
/// only ever hold one page.
const failedLanes = new Map<string, Error>()
const FAILED_LANE_CAP = 128

const laneKeyOf = (motifId: string, contentHash: string) => `${motifId}\0${contentHash}`

/** Explicit retry revokes only this package's remembered content failure.
 * Automatic retries leave the failure latch intact to prevent retry storms. */
export function resetCaptureFailure(motifId: string, contentHash: string): void {
  failedLanes.delete(laneKeyOf(motifId, contentHash))
}

/** Latches the lane; returns the `content` error its captures now reject with. */
function failLane(key: string, error: unknown): MotifError {
  const err = motifErrorCode(error) === 'content' ? error as MotifError
    : new MotifError('content', error instanceof MotifError ? error.detail : String((error as Error | undefined)?.message ?? error), { cause: error })
  if (failedLanes.size >= FAILED_LANE_CAP) failedLanes.delete(failedLanes.keys().next().value!)
  failedLanes.set(key, err)
  return err
}

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
const probationLanes = new Set<string>()

/** True when this timeout is the lane's first strike and the lane may retry. */
function grantProbation(key: string): boolean {
  if (probationLanes.has(key)) return false
  if (probationLanes.size >= FAILED_LANE_CAP) probationLanes.delete(probationLanes.values().next().value!)
  probationLanes.add(key)
  return true
}

/// Resolved user-Motif manifests keyed by `${motifId}\0${contentHash}`:
/// getMotif is readFileSync + parseManifestIsland — synchronous fs on the
/// capture hot path, once per frame. The content hash IS the invalidation
/// signal, so caching by it is exact. Empty contentHash (MCP callers) is never
/// cached: no invalidation signal. FIFO-evicted at a small cap — drafts churn
/// keys on every edit. Built-ins never reach here (already in RAM).
const manifestCache = new Map<string, Manifest | null>()
const MANIFEST_CACHE_CAP = 32

function manifestFor(a: CaptureArgs): Manifest | undefined {
  const builtin = BUILTIN_MANIFESTS.get(a.motifId)
  if (builtin) return builtin
  if (!motifStore) return undefined
  if (a.contentHash === '') return motifStore.getMotif(a.motifId)?.manifest
  const key = laneKeyOf(a.motifId, a.contentHash)
  if (manifestCache.has(key)) return manifestCache.get(key) ?? undefined
  const manifest = motifStore.getMotif(a.motifId)?.manifest ?? null
  if (manifestCache.size >= MANIFEST_CACHE_CAP) manifestCache.delete(manifestCache.keys().next().value!)
  manifestCache.set(key, manifest)
  return manifest ?? undefined
}

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

/// Builds the host of one document. The shell page, which runs no scripts of
/// its own, is the window's only top-level navigation: a bitmap host paints
/// real alpha only for a window's first document
/// (docs/notes/electron-chromium-behavior.md#a-bitmap-osr-window-paints-alpha-only-for-its-first-document),
/// so another Motif or content version gets a new window. The runtime is
/// registered once the shell has loaded, and the shell then loads the Motif
/// into its frame, whose documents the runtime reaches before their scripts.
async function buildHost(motifId: string, contentHash: string, width: number, height: number): Promise<Host> {
  const runtime = runtimeSource
  if (!runtime) throw new MotifError('closed', 'motif runtime not registered yet (call motif_register_runtime)')
  const texture = textureCaptureEnabled && readFrameMarker !== null
  const pinned = /^[0-9a-f]{64}$/.test(contentHash) && motifStore?.pinPackage?.(motifId, contentHash)
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
  captureCounters.hostBuilds++
  // `offscreen: true` is a paint target, not a lifecycle class: unmarked, this
  // window votes in the quit decision and the app stops quitting when the editor
  // closes (windows.ts → quitIfLastUserWindowClosed). Before the awaits, per its
  // same-tick contract.
  markInternalWindow(win)
  const frames = new OffscreenFrames(win.webContents, texture ? readFrameMarker : null, CAPTURE_TIMEOUT_MS)
  // Navigation lockdown for the untrusted Motif page: deny every `window.open`
  // OUTRIGHT (allowExternalOpen:false — a Motif must not be able to pop the user's
  // browser) and block any page-initiated navigation off the app's content. The
  // main-process `loadURL` calls below are programmatic and don't trip will-navigate.
  hardenWindow(win, { allowExternalOpen: false })
  // hardenWindow guards the top frame; the Motif runs in the shell's frame.
  win.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.url !== motifUrl) event.preventDefault()
  })
  captureCounters.pageLoads++
  diagnosticsLane(motifId, contentHash).pageLoads++
  // Destroy the offscreen window if CDP init throws mid-build, else it orphans.
  // Bounded to ≤1 (captures are serialized) but still a leak; never observed green.
  try {
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    // Every CDP command is bounded by construction, including Emulation.
    // Callers cannot accidentally wedge the serial queue with an untimed send.
    const send = (method: string, params: object = {}, timeoutMs = CAPTURE_TIMEOUT_MS, label = method) =>
      withTimeout(dbg.sendCommand(method, params), timeoutMs, label)
    await timedCapture('loadMs', () => withTimeout(win.loadURL(`${dir}${CAPTURE_HOST_FILE}?${query}`), CAPTURE_TIMEOUT_MS * 2, 'loadURL motif'))
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: texture ? runtime : BITMAP_CANVAS_RUNTIME_SOURCE + runtime,
    })
    // The emulation pins deviceScaleFactor to 1; the default background keeps
    // `background: transparent` real alpha.
    await send('Emulation.setDeviceMetricsOverride', { width, height: height + FRAME_MARKER_ROWS, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    const shell = await timedCapture('loadMs', () => send('Runtime.evaluate', {
      expression: `${runtime};window.__motifShellLoad()`, awaitPromise: true, returnByValue: true,
    }, CAPTURE_TIMEOUT_MS * 2, 'load Motif frame'))
    if (shell?.exceptionDetails) throw new Error('capture host shell failed: ' + JSON.stringify(shell.exceptionDetails))
    win.webContents.setFrameRate(CAPTURE_FRAME_RATE)
    return { win, send, loadedId: motifId, loadedV: contentHash, readyFor: null, lastSize: { w: width, h: height }, frames, texture, motifUrl }
  } catch (e) {
    frames.dispose()
    try { win.destroy() } catch { /* already gone */ }
    throw e
  }
}

/// Tears down `which` (default: the current host). A frame in flight on a host
/// already replaced must not tear down its successor.
function teardownHost(which: Host | null = host): void {
  if (!which) return
  which.frames.dispose()
  try { which.win.webContents.debugger.detach() } catch { /* already gone */ }
  try { which.win.destroy() } catch { /* already gone */ }
  if (host === which) host = null
}

/// Latched by `shutdownCaptureHost` — a capture that wakes up afterwards must not
/// build a window. See there for why.
let shuttingDown = false

/// Retire the host for the rest of the process's life; the app's `before-quit`
/// calls this.
///
/// The latch is the load-bearing half, not the teardown. Quitting closes every
/// window ASYNCHRONOUSLY, and a capture still queued on the capture queues
/// resumes inside that gap: it finds `host` null and rebuilds it, so
/// Electron's window list never empties, `will-quit` never fires, and the
/// process runs forever. Tearing the host down without also refusing later
/// captures re-opens that race.
export function shutdownCaptureHost(): void {
  shuttingDown = true
  teardownHost()
}

async function ensureHost(a: CaptureArgs): Promise<Host> {
  // Reuse only when BOTH id and content version match (the ?v= cache-buster).
  if (host?.loadedId === a.motifId && host.loadedV === a.contentHash) return host
  teardownHost()
  host = await buildHost(a.motifId, a.contentHash, a.width, a.height)
  return host
}

async function waitReady(h: Host, motifId: string): Promise<void> {
  if (h.readyFor === motifId) return
  // Throw-until-ready: a false boolean would resolve to ready falsely. The
  // hostname guard closes the navigate→stale-page race: with `standard:true`
  // motif://<id>/… parses with hostname===id, so we verify the loaded page is
  // actually the motif we want (not a stale about:blank or prior motif).
  const probe =
    `(typeof window.__motifHostReady==='function' && window.__motifHostReady(${JSON.stringify(motifId)}))`
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    // TIMED, unlike a plain send: a wedged offscreen renderer never settles a
    // sendCommand, and an untimed probe would hang the one serial capture
    // queue for the rest of the process's life — every motif in every project
    // frozen, no error anywhere. The timeout converts the wedge into an error, which
    // doCapture's catch answers with teardownHost → the next capture rebuilds.
    // A wedged page does not unwedge between polls, so the throw also skips the
    // remaining attempts (they exist for a LOADING page, which fails fast).
    const r = await h.send('Runtime.evaluate', { expression: probe, returnByValue: true })
    if (r?.result?.value === true) { h.readyFor = motifId; return }
    await delay(READY_POLL_MS)
  }
  throw new MotifError('content', `motif '${motifId}' never became ready (Motif frame not loaded, __motifRender undefined, or wrong host page loaded)`)
}

/// Paints still to arrive for frames already rendered (ADR 0159). Settled
/// whatever the outcome; tracked only to bound and drain the pipeline.
const framesInFlight = new Set<Promise<void>>()

/// Waits until every rendered frame has its paint. A navigation or resize
/// replaces the surface those paints come from.
async function drainFrames(): Promise<void> {
  while (framesInFlight.size) await Promise.all(framesInFlight)
}

/** A rendered frame: `delivered` settles once its paint is consumed. */
interface Rendered<T> { delivered: Promise<T> }

/// Renders one frame and leases the paint carrying its id; returns once the
/// frame has committed, so the queue can render the next one while this one is
/// still on its way to the capture. `output` runs inside the lease.
async function doCapture<T>(a: CaptureArgs, output: (frame: MotifOsrFrame) => Promise<T>): Promise<Rendered<T>> {
  // Refuse rather than resurrect — see shutdownCaptureHost.
  if (shuttingDown) throw new MotifError('closed', 'motif capture host is shut down (the app is quitting)')
  motifStore?.assertRenderable?.(a.motifId)
  const lane = laneKeyOf(a.motifId, a.contentHash)
  const samePage = host?.loadedId === a.motifId && host.loadedV === a.contentHash
    && host.lastSize?.w === a.width && host.lastSize?.h === a.height
  if (!samePage) await drainFrames()
  while (framesInFlight.size >= MAX_FRAMES_IN_FLIGHT) await Promise.race(framesInFlight)
  let h: Host
  try {
    h = await ensureHost(a)
    await timedCapture('readyMs', () => waitReady(h, a.motifId))
  } catch (e) {
    // Transport class: no Motif code ran (host build, loadURL, wedged/never-
    // ready probe), so nothing here is attributable to page content — tear
    // down and let the next capture rebuild.
    teardownHost()
    throw e
  }
  const manifest = manifestFor(a)
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
    teardownHost(h) // transport: wedged host — rebuild on next call
    throw e
  }
  let ev: any
  let phase = '__motifSetup'
  let lease: ReturnType<OffscreenFrames['expect']> | null = null
  try {
    const setup = await timedCapture('setupMs', () => h.send('Runtime.evaluate', {
      expression: `window.__motifSetup(${JSON.stringify(props)}, ${JSON.stringify(meta)})`,
      awaitPromise: true, returnByValue: true,
    }, SETUP_TIMEOUT_MS, 'setup (model loading / decoder initialization)'))
    // Setup failures use the same lane handling as frame failures; the runtime
    // has already retired its workers. A timeout tears down the entire host.
    if (setup?.exceptionDetails) ev = setup
    else {
      phase = '__motifRender'
      lease = h.frames.expect(a.width, a.height)
      const expr = `window.__motifRender(${JSON.stringify(a.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify({ ...meta, frameId: lease.id })})`
      ev = await timedCapture('renderMs', () => h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
    }
  } catch (e) {
    lease?.cancel()
    // A hung __motifSetup/__motifRender wedges the renderer for every other
    // lane, so the host is rebuilt whatever the cause. Whether the LANE is
    // latched depends on the author: a timeout is ambiguous (content or load)
    // and earns one retry on the rebuilt host; anything else, and a second
    // consecutive timeout, latches it so its sprites stop retrying.
    teardownHost(h)
    if (a.contentHash !== '' && !(motifErrorCode(e) === 'timeout' && grantProbation(lane))) throw failLane(lane, e)
    throw e
  }
  probationLanes.delete(lane)
  if (ev?.exceptionDetails) {
    // Content error: the Motif's script threw. The window and CDP transport
    // answered fine, so tearing the host down would punish every other Motif
    // with re-navigation + runtime re-injection. Fail the LANE instead —
    // same-lane captures fast-reject until contentHash changes (see failedLanes).
    lease?.cancel()
    const err = new MotifError('content', phase + ' threw: ' + JSON.stringify(ev.exceptionDetails))
    if (a.contentHash !== '') failLane(lane, err)
    throw err
  }
  const leased = lease!
  const delivered = timedCapture('outputMs', async () => {
    let frame: MotifOsrFrame
    try { frame = await leased.frame }
    catch (e) {
      // A skipped frame is rendered again; the host is healthy.
      if (!(e instanceof MotifFrameSkippedError)) teardownHost(h)
      throw e
    }
    // The host painted this frame, so an output failure is its consumer's.
    // Tearing the host down here would fail the other frames in flight on it.
    try { return await output(frame) }
    finally { if (frame.kind === 'texture') frame.texture.release() }
  })
  const settled = delivered.then(() => {}, () => {})
  framesInFlight.add(settled)
  void settled.then(() => framesInFlight.delete(settled))
  return { delivered }
}

function enqueueCapture<T>(a: CaptureArgs, coalesceKey: string | undefined, run: () => Promise<Rendered<T>>, high = coalesceKey !== undefined, isCurrent: () => boolean = () => true): Promise<T> {
  // Fast-reject a lane whose content already failed this session: same
  // (motifId, contentHash) means the same throwing script against the same
  // page — don't spend queue slots or CDP round trips proving it again.
  const lane = laneKeyOf(a.motifId, a.contentHash)
  const laneError = failedLanes.get(lane)
  if (laneError) return Promise.reject(laneError)
  const queuedAt = performance.now()
  let resolve!: (value: T) => void, reject!: (e: Error) => void
  const out = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // Renders the frame; its waiter settles with the paint. A frame the
  // compositor skipped goes back to the head of its queue.
  const attempt = async (retries: number): Promise<void> => {
    // The lane may have failed while this ticket sat queued.
    const err = failedLanes.get(lane)
    if (err) { reject(err); return }
    const started = performance.now(), counters = captureCounters
    if (retries === 0) {
      counters.queueMs += started - queuedAt
      counters.captures++
      diagnosticsLane(a.motifId, a.contentHash).captures++
    }
    const finish = (error: unknown | null, value?: T) => {
      counters.captureMs += performance.now() - started
      if (error === null) { counters.completed++; resolve(value as T); return }
      if (error instanceof MotifFrameSkippedError && retries < SKIPPED_FRAME_RETRIES) {
        counters.skippedFrames++
        schedule({ key: undefined, high, queuedAt, stale: false, reject, run: () => attempt(retries + 1) }, true)
        return
      }
      counters.failed++
      reject(error as Error)
    }
    try {
      if (!isCurrent()) throw motifSuperseded()
      const { delivered } = await run()
      delivered.then(value => finish(null, value), finish)
    } catch (e) { finish(e) }
  }
  if (!coalesceKey) {
    // LOW priority: keyless prewarmer/baker/MCP work yields to on-demand
    // sprite frames queued behind it.
    schedule({ key: undefined, high, queuedAt, stale: false, reject, run: () => attempt(0) })
    return out
  }
  // Legacy keyed requests are HIGH; broker jobs explicitly choose their lane.
  // Latest-wins per key: wake the previous queued waiter right away and stale
  // its ticket — its queue slot then does no work when reached (pump skips it).
  const prev = queuedKeys.get(coalesceKey)
  if (prev) {
    prev.stale = true
    prev.reject(motifSuperseded())
  }
  const ticket: Ticket = { key: coalesceKey, high, queuedAt, stale: false, reject, run: () => attempt(0) }
  queuedKeys.set(coalesceKey, ticket)
  schedule(ticket)
  return out
}

/** Broker jobs have a stable identity separate from their subscribers. A preview
 * may promote a background job; cancelling one subscriber need not cancel it. */
export function controlMotifCapture(key: string, action: 'promote' | 'cancel'): void {
  const ticket = queuedKeys.get(key)
  if (!ticket) return // already running: finish safely, receiver retires its result
  if (action === 'cancel') {
    ticket.stale = true
    queuedKeys.delete(key)
    ticket.reject(motifSuperseded())
  } else if (!ticket.high) {
    const i = lowQueue.indexOf(ticket)
    if (i >= 0) lowQueue.splice(i, 1)
    ticket.high = true
    highQueue.push(ticket)
  }
}

/** One frame as a PNG of the picture, scaled by `a.scale` (MCP previews,
 * covers and the renderer's direct capture). */
export function captureMotifFrameB64(a: CaptureArgs, coalesceKey?: string, high?: boolean, isCurrent: () => boolean = () => true): Promise<string> {
  return enqueueCapture(a, coalesceKey, () => doCapture(a, async frame => {
    countFrame(frame)
    const png = frame.kind === 'bitmap'
      ? frame.image.crop({ x: 0, y: 0, width: frame.width, height: frame.height })
      : await texturePng(frame)
    if (a.scale === undefined || a.scale === 1) return (Buffer.isBuffer(png) ? png : png.toPNG()).toString('base64')
    const image = Buffer.isBuffer(png) ? nativeImage.createFromBuffer(png) : png
    return image.resize({ width: Math.max(1, Math.round(a.width * a.scale)), height: Math.max(1, Math.round(a.height * a.scale)), quality: 'best' }).toPNG().toString('base64')
  }), high, isCurrent)
}

async function texturePng(frame: Extract<MotifOsrFrame, { kind: 'texture' }>): Promise<Buffer> {
  const handle = frame.texture.textureInfo.handle.ntHandle
  if (!readTexturePng || !handle) throw new MotifError('device', 'Motif texture PNG readback unavailable')
  return readTexturePng(handle, frame.height)
}

function countFrame(frame: MotifOsrFrame): void {
  if (frame.kind === 'texture') captureCounters.textureCaptures++
  else captureCounters.bitmapCaptures++
}

/** One frame leased to `consume`: a shared texture, released after `consume`
 * settles, or a bitmap. */
export function captureMotifFrame<T>(a: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, coalesceKey?: string, high?: boolean, isCurrent: () => boolean = () => true): Promise<T> {
  return enqueueCapture(a, coalesceKey, () => doCapture(a, frame => {
    countFrame(frame)
    return consume(frame)
  }), high, isCurrent)
}
