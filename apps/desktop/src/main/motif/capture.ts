import { BrowserWindow, nativeImage } from 'electron'
import { OffscreenFrames, type FrameLease, type FrameMarkerReader, type MotifOsrFrame } from './offscreenFrames.js'
import { PNG_CANVAS_RUNTIME_SOURCE } from './pngCanvasRuntime.js'
import { hardenWindow, markInternalWindow } from '../windows'
import { BUILTIN_MANIFESTS, motifCtxDurationS, type Manifest } from '../../shared/motifs/catalog.js'
import { CAPTURE_SUPERSEDED_MESSAGE, MotifCaptureTimeoutError } from '../../shared/motifs/captureErrors.js'
import { resolveMotifMediaProps } from './mediaProps.js'
import { dropPngRows } from './pngRows.js'
import { CAPTURE_HOST_FILE, FRAME_MARKER_ROWS } from '../../shared/motifs/frameMarker.js'
import type { UserMotifStore } from './store.js'

export interface CaptureArgs {
  motifId: string
  tSec: number
  propsJson: string
  width: number
  height: number
  settleRafs: number | null
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

const newCaptureCounters = () => ({ captures: 0, completed: 0, failed: 0, pageLoads: 0, hostBuilds: 0, textureCaptures: 0, pngCaptures: 0, queueMs: 0, captureMs: 0, loadMs: 0, readyMs: 0, setupMs: 0, renderMs: 0, outputMs: 0 })
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

export function isMotifContentFailure(a: CaptureArgs, error: unknown): boolean {
  return failedLanes.get(laneKeyOf(a.motifId, a.contentHash)) === error
    || /__motif(?:Setup|Render) threw:/.test(String(error))
}

interface Host {
  win: BrowserWindow
  send: (method: string, params?: object, timeoutMs?: number, label?: string) => Promise<any>
  loadedId: string | null
  loadedV: string | null
  readyFor: string | null
  lastSize: { w: number; h: number } | null
  frames: OffscreenFrames | null
  /// Rows the surface keeps below the picture: the frame id's, on a host
  /// whose textures are leased by it. A PNG host has none, so its
  /// screenshots need no crop.
  markerRows: number
  /// The one URL the shell's frame may load: the Motif it was built for.
  motifUrl: string | null
}
let host: Host | null = null
let textureCaptureEnabled = false
export function setTextureCaptureEnabled(enabled: boolean): void {
  if (textureCaptureEnabled === enabled) return
  textureCaptureEnabled = enabled
  teardownHost()
}

let readFrameMarker: FrameMarkerReader | null = null
/// Set once at boot where the native marker reader exists; a texture capture
/// without it fails and the capture service falls back to PNG.
export function setFrameMarkerReader(read: FrameMarkerReader): void {
  readFrameMarker = read
}

// Serialize ALL captures (on-demand sprite / prewarmer / baker / MCP) on the
// one host — single-threaded but await-interleaved. Two FIFO queues replace a
// bare promise chain so a HIGH ticket (keyed: the on-demand sprite frame the
// user is looking at NOW) dequeues ahead of any queued LOW ticket (keyless
// prewarmer/baker/MCP): during playback the prewarmer used to hold the chain
// while fresh sprite frames waited behind it (5b7cbaec). A RUNNING capture is
// never preempted. Old LOW work receives one frame between HIGH frames after
// two seconds, so explicitly enabled background work cannot starve forever.
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
  /// Settles the ticket's own waiter; must never throw (a throw would strand
  /// every ticket queued behind it).
  run: () => Promise<void>
}
const highQueue: Ticket[] = []
const lowQueue: Ticket[] = []
let pumping = false

function schedule(t: Ticket): void {
  ;(t.high ? highQueue : lowQueue).push(t)
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
/// replaces the still-queued previous one: its waiter rejects IMMEDIATELY with
/// CAPTURE_SUPERSEDED_MESSAGE and its queue slot no-ops when reached — the one
/// serial queue never spends capture-seconds executing a frame nobody wants
/// anymore. Without this, real-time playback enqueues ~30 requests/s per
/// visible motif against a ~1 s/capture queue, and the unbounded backlog
/// starves the prewarmer AND the L2 baker queued behind it. Keyless requests
/// (prewarmer, baker, MCP) are never superseded: their frames stay wanted.
const queuedKeys = new Map<string, Ticket>()

/// Failed lanes: capture errors attributable to the Motif's OWN content
/// (a throwing or hung __motifRender), keyed by `${motifId}\0${contentHash}`.
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

function failLane(key: string, err: Error): void {
  if (failedLanes.size >= FAILED_LANE_CAP) failedLanes.delete(failedLanes.keys().next().value!)
  failedLanes.set(key, err)
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
        timer = setTimeout(() => rej(new MotifCaptureTimeoutError(ms, label)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function buildHost(): Promise<Host> {
  if (!runtimeSource) throw new Error('motif runtime not registered yet (call motif_register_runtime)')
  const win = new BrowserWindow({
    show: false,
    // The capture host renders untrusted, user-authored Motif content, so it runs
    // at the same isolation baseline as every other window: OS sandbox on, no Node,
    // context isolation, web security. The complementary egress half (no network /
    // no remote code) is the per-document CSP served by `motif://`; see docs/security.md.
    transparent: textureCaptureEnabled,
    webPreferences: {
      offscreen: textureCaptureEnabled ? { useSharedTexture: true } : true, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
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
  const frames = textureCaptureEnabled && readFrameMarker ? new OffscreenFrames(win.webContents, readFrameMarker, CAPTURE_TIMEOUT_MS) : null
  // Navigation lockdown for the untrusted Motif page: deny every `window.open`
  // OUTRIGHT (allowExternalOpen:false — a Motif must not be able to pop the user's
  // browser) and block any page-initiated navigation off the app's content. The
  // main-process `loadURL` calls below are programmatic and don't trip will-navigate.
  hardenWindow(win, { allowExternalOpen: false })
  // hardenWindow guards the top frame; the Motif runs in the shell's frame.
  win.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.url !== host?.motifUrl) event.preventDefault()
  })
  // Destroy the offscreen window if CDP init throws mid-build, else it orphans.
  // Bounded to ≤1 (captures are serialized) but still a leak; never observed green.
  try {
    await withTimeout(win.loadURL('about:blank'), CAPTURE_TIMEOUT_MS, 'about:blank')
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    // Every CDP command is bounded by construction, including Emulation.
    // Callers cannot accidentally wedge the serial queue with an untimed send.
    const send = (method: string, params: object = {}, timeoutMs = CAPTURE_TIMEOUT_MS, label = method) =>
      withTimeout(dbg.sendCommand(method, params), timeoutMs, label)
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: textureCaptureEnabled ? runtimeSource : PNG_CANVAS_RUNTIME_SOURCE + runtimeSource,
    })
    return { win, send, loadedId: null, loadedV: null, readyFor: null, lastSize: null, frames, markerRows: frames ? FRAME_MARKER_ROWS : 0, motifUrl: null }
  } catch (e) {
    try { win.destroy() } catch { /* already gone */ }
    throw e
  }
}

function teardownHost(): void {
  if (host) {
    host.frames?.dispose()
    try { host.win.webContents.debugger.detach() } catch { /* already gone */ }
    try { host.win.destroy() } catch { /* already gone */ }
    host = null
  }
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

async function ensureHost(motifId: string, contentHash: string): Promise<Host> {
  if (!host) host = await buildHost()
  // Reuse only when BOTH id and content version match (the ?v= cache-buster).
  if (host.loadedId === motifId && host.loadedV === contentHash) return host
  const pinned = /^[0-9a-f]{64}$/.test(contentHash) && motifStore?.pinPackage?.(motifId, contentHash)
  // The shell frames the Motif above the surface's marker rows
  // (shared/motifs/frameMarker.ts); the Motif sees only its own size.
  const dir = `motif://${motifId}/${pinned ? `.revisions/${contentHash}/` : ''}`
  const query = `v=${encodeURIComponent(contentHash)}`
  captureCounters.pageLoads++
  diagnosticsLane(motifId, contentHash).pageLoads++
  host.motifUrl = `${dir}index.html?${query}`
  const shell = `${dir}${CAPTURE_HOST_FILE}?rows=${host.markerRows}&${query}`
  await timedCapture('loadMs', () => withTimeout(host!.win.loadURL(shell), CAPTURE_TIMEOUT_MS * 2, 'loadURL motif'))
  host.loadedId = motifId
  host.loadedV = contentHash
  host.readyFor = null // re-probe; navigation re-runs addScriptToEvaluateOnNewDocument
  host.lastSize = null // re-apply setDeviceMetricsOverride for the new page
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
  throw new Error(`motif '${motifId}' never became ready (Motif frame not loaded, __motifRender undefined, or wrong host page loaded)`)
}

/// `texture` captures lease the frame by its id; PNG captures, which a
/// texture host also serves, take a screenshot after the manifest's settle.
async function doCapture<T>(a: CaptureArgs, texture: boolean, output: (h: Host, lease: FrameLease | null) => Promise<T>): Promise<T> {
  // Refuse rather than resurrect — see shutdownCaptureHost.
  if (shuttingDown) throw new Error('motif capture host is shut down (the app is quitting)')
  motifStore?.assertRenderable?.(a.motifId)
  const lane = laneKeyOf(a.motifId, a.contentHash)
  let h: Host
  try {
    h = await ensureHost(a.motifId, a.contentHash)
    if (texture && !h.frames) throw new Error('Motif host has no shared texture output')
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
  const meta = { duration, width: a.width, height: a.height, fps, settleRafs: texture ? 0 : a.settleRafs }
  try {
    if (h.lastSize?.w !== a.width || h.lastSize?.h !== a.height) {
      // BOTH hosts take the capture's size as their window size, not only the
      // shared-texture one. With the window left at its 800×600 default and the
      // page emulated at the capture size, the macOS bitmap OSR host's first
      // committed frame of a new document could be empty — every paint and
      // readback transparent until the page drew again (7% of
      // first-after-navigation captures on the macOS runner); sized to match,
      // 384 of 384 captures were whole
      // (docs/notes/electron-chromium-behavior.md#macos-offscreen-bitmap-host-drops-the-first-commit-when-window-and-emulation-sizes-differ).
      // The emulation override stays: it is what pins deviceScaleFactor to 1
      // for the screenshot.
      h.win.setContentSize(a.width, a.height + h.markerRows)
      await h.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height + h.markerRows, deviceScaleFactor: 1, mobile: false })
      await h.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      h.lastSize = { w: a.width, h: a.height }
    }
  } catch (e) {
    teardownHost() // transport: wedged host — rebuild on next call
    throw e
  }
  let ev: any
  let phase = '__motifSetup'
  let lease: FrameLease | null = null
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
      if (texture) lease = h.frames!.expect(a.width, a.height)
      const frameMeta = lease ? { ...meta, frameId: lease.id } : meta
      const expr = `window.__motifRender(${JSON.stringify(a.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify(frameMeta)})`
      ev = await timedCapture('renderMs', () => h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
    }
  } catch (e) {
    lease?.cancel()
    // A hung __motifSetup/__motifRender wedges the renderer for every other
    // lane, so the host is rebuilt whatever the cause. Whether the LANE is
    // latched depends on the author: a timeout is ambiguous (content or load)
    // and earns one retry on the rebuilt host; anything else, and a second
    // consecutive timeout, latches it so its sprites stop retrying.
    if (a.contentHash !== '' && !(e instanceof MotifCaptureTimeoutError && grantProbation(lane))) failLane(lane, e as Error)
    teardownHost()
    throw e
  }
  probationLanes.delete(lane)
  if (ev?.exceptionDetails) {
    // Content error: the Motif's script threw. The window and CDP transport
    // answered fine, so tearing the host down would punish every other Motif
    // with re-navigation + runtime re-injection. Fail the LANE instead —
    // same-lane captures fast-reject until contentHash changes (see failedLanes).
    lease?.cancel()
    const err = new Error(phase + ' threw: ' + JSON.stringify(ev.exceptionDetails))
    if (a.contentHash !== '') failLane(lane, err)
    throw err
  }
  try {
    return await timedCapture('outputMs', () => output(h, lease))
  } catch (e) {
    lease?.cancel()
    teardownHost() // wedged host: rebuild on next call
    throw e
  }
}

function enqueueCapture<T>(a: CaptureArgs, coalesceKey: string | undefined, run: () => Promise<T>, high = coalesceKey !== undefined, isCurrent: () => boolean = () => true): Promise<T> {
  // Fast-reject a lane whose content already failed this session: same
  // (motifId, contentHash) means the same throwing script against the same
  // page — don't spend queue slots or CDP round trips proving it again.
  const lane = laneKeyOf(a.motifId, a.contentHash)
  const laneError = failedLanes.get(lane)
  if (laneError) return Promise.reject(laneError)
  const queuedAt = performance.now()
  const measured = async () => {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    const started = performance.now(), counters = captureCounters
    counters.queueMs += started - queuedAt
    counters.captures++
    diagnosticsLane(a.motifId, a.contentHash).captures++
    try { const result = await run(); counters.completed++; return result }
    catch (error) { counters.failed++; throw error }
    finally { counters.captureMs += performance.now() - started }
  }
  if (!coalesceKey) {
    // LOW priority: keyless prewarmer/baker/MCP work yields to on-demand
    // sprite frames queued behind it.
    return new Promise<T>((resolve, reject) => {
      schedule({
        key: undefined, high, queuedAt, stale: false, reject,
        run: async () => {
          // The lane may have failed while this ticket sat queued.
          const err = failedLanes.get(lane)
          if (err) { reject(err); return }
          try { resolve(await measured()) } catch (e) { reject(e as Error) }
        },
      })
    })
  }
  // Legacy keyed requests are HIGH; broker jobs explicitly choose their lane.
  // Latest-wins per key: wake the previous queued waiter right away and stale
  // its ticket — its queue slot then does no work when reached (pump skips it).
  const prev = queuedKeys.get(coalesceKey)
  if (prev) {
    prev.stale = true
    prev.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE))
  }
  const ticket: Ticket = { key: coalesceKey, high, queuedAt, stale: false, reject: () => {}, run: async () => {} }
  const out = new Promise<T>((resolve, reject) => {
    ticket.reject = reject
    ticket.run = async () => {
      // The lane may have failed while this ticket sat queued.
      const err = failedLanes.get(lane)
      if (err) { reject(err); return }
      try { resolve(await measured()) } catch (e) { reject(e as Error) }
    }
  })
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
    ticket.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE))
  } else if (!ticket.high) {
    const i = lowQueue.indexOf(ticket)
    if (i >= 0) lowQueue.splice(i, 1)
    ticket.high = true
    highQueue.push(ticket)
  }
}

export function captureMotifFrameB64(a: CaptureArgs, coalesceKey?: string, high?: boolean, isCurrent: () => boolean = () => true): Promise<string> {
  return enqueueCapture(a, coalesceKey, () => {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    captureCounters.pngCaptures++
    return doCapture(a, false, async h => {
    // Cropped after, never by `clip`: a clipped screenshot left a WebGL
    // Motif's later frames blank.
    const shot = await h.send('Page.captureScreenshot', { format: 'png' })
    if (!shot?.data) throw new Error('captureScreenshot returned no data')
    const png = h.markerRows ? dropPngRows(Buffer.from(shot.data as string, 'base64'), h.markerRows) : null
    if (a.scale === undefined || a.scale === 1) return png ? png.toString('base64') : shot.data as string
    // Scaled here, not by the screenshot's clip.scale: on a Windows host that
    // scaled a 1920×1080 page's width alone and returned its left half.
    const full = nativeImage.createFromBuffer(png ?? Buffer.from(shot.data as string, 'base64'))
    return full.resize({ width: Math.max(1, Math.round(a.width * a.scale)), height: Math.max(1, Math.round(a.height * a.scale)), quality: 'best' }).toPNG().toString('base64')
    })
  }, high, isCurrent)
}

export function captureMotifTexture<T>(a: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, coalesceKey?: string, high?: boolean, isCurrent: () => boolean = () => true): Promise<T> {
  if (!textureCaptureEnabled || !readFrameMarker) return Promise.reject(new Error('Motif OSR unavailable'))
  return enqueueCapture(a, coalesceKey, () => {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    captureCounters.textureCaptures++
    return doCapture(a, true, async (_h, lease) => {
    const frame = await lease!.frame
    try { return await consume(frame) } finally { frame.texture.release() }
    })
  }, high, isCurrent)
}
