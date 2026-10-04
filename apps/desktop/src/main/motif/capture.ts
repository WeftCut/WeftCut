import { BrowserWindow, type OffscreenSharedTexture } from 'electron'
import { OffscreenFrames } from './offscreenFrames.js'
import { hardenWindow, markInternalWindow } from '../windows'
import { BUILTIN_MANIFESTS, motifCtxDurationS, type Manifest } from '../../shared/motifs/catalog.js'
import { CAPTURE_SUPERSEDED_MESSAGE } from '../../shared/motifs/captureErrors.js'
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
}

const CAPTURE_TIMEOUT_MS = 5000
const SETUP_TIMEOUT_MS = 30_000
const READY_ATTEMPTS = 30
const READY_POLL_MS = 100

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
}
let host: Host | null = null
let textureCaptureEnabled = false
export function setTextureCaptureEnabled(enabled: boolean): void {
  if (textureCaptureEnabled === enabled) return
  textureCaptureEnabled = enabled
  teardownHost()
}

// Serialize ALL captures (on-demand sprite / prewarmer / baker / MCP) on the
// one host — single-threaded but await-interleaved. Two FIFO queues replace a
// bare promise chain so a HIGH ticket (keyed: the on-demand sprite frame the
// user is looking at NOW) dequeues ahead of any queued LOW ticket (keyless
// prewarmer/baker/MCP): during playback the prewarmer used to hold the chain
// while fresh sprite frames waited behind it (5b7cbaec). A RUNNING capture is
// never preempted, FIFO holds within a priority, and LOW starvation during
// continuous playback is the intent — prewarmer work is speculative.
interface Ticket {
  /// Coalesce key when keyed; lets the pump drop the ticket from queuedKeys
  /// the moment it passes the replaceable window.
  key: string | undefined
  high: boolean
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
  try {
    for (;;) {
      const t = highQueue.shift() ?? lowQueue.shift()
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

function failLane(key: string, err: Error): void {
  if (failedLanes.size >= FAILED_LANE_CAP) failedLanes.delete(failedLanes.keys().next().value!)
  failedLanes.set(key, err)
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
        timer = setTimeout(() => rej(new Error(`motif capture timed out after ${ms}ms: ${label}`)), ms)
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
    webPreferences: { offscreen: textureCaptureEnabled ? { useSharedTexture: true } : true, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  // `offscreen: true` is a paint target, not a lifecycle class: unmarked, this
  // window votes in the quit decision and the app stops quitting when the editor
  // closes (windows.ts → quitIfLastUserWindowClosed). Before the awaits, per its
  // same-tick contract.
  markInternalWindow(win)
  const frames = textureCaptureEnabled ? new OffscreenFrames(win.webContents) : null
  // Navigation lockdown for the untrusted Motif page: deny every `window.open`
  // OUTRIGHT (allowExternalOpen:false — a Motif must not be able to pop the user's
  // browser) and block any page-initiated navigation off the app's content. The
  // main-process `loadURL` calls below are programmatic and don't trip will-navigate.
  hardenWindow(win, { allowExternalOpen: false })
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
    await send('Page.addScriptToEvaluateOnNewDocument', { source: runtimeSource })
    return { win, send, loadedId: null, loadedV: null, readyFor: null, lastSize: null, frames }
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
  const url = `motif://${motifId}/${pinned ? `.revisions/${contentHash}/` : ''}index.html?v=${encodeURIComponent(contentHash)}`
  await withTimeout(host.win.loadURL(url), CAPTURE_TIMEOUT_MS * 2, 'loadURL motif')
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
  // motif://<id>/index.html parses with hostname===id, so we verify the loaded
  // page is actually the motif we want (not a stale about:blank or prior motif).
  const probe =
    `(typeof window.__motifRender==='function' && document.readyState==='complete'` +
    ` && location.hostname===${JSON.stringify(motifId)})`
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
  throw new Error(`motif '${motifId}' never became ready (window.__motifRender undefined, document not complete, or wrong host page loaded)`)
}

async function doCapture<T>(a: CaptureArgs, output: (h: Host) => Promise<T>, fenceFirstSurface = false): Promise<T> {
  // Refuse rather than resurrect — see shutdownCaptureHost.
  if (shuttingDown) throw new Error('motif capture host is shut down (the app is quitting)')
  motifStore?.assertRenderable?.(a.motifId)
  const lane = laneKeyOf(a.motifId, a.contentHash)
  let h: Host
  try {
    h = await ensureHost(a.motifId, a.contentHash)
    await waitReady(h, a.motifId)
  } catch (e) {
    // Transport class: no Motif code ran (host build, loadURL, wedged/never-
    // ready probe), so nothing here is attributable to page content — tear
    // down and let the next capture rebuild.
    teardownHost()
    throw e
  }
  const manifest = manifestFor(a)
  const props = JSON.parse(a.propsJson) as Record<string, unknown>
  const duration = manifest ? motifCtxDurationS(manifest, props) : 5
  // meta.fps must be the rate the caller computed tSec on (the composition's
  // fps) — a Motif reading it (or ctx.frame = round(t*fps)) renders wrong when
  // it disagrees. 30 only when no rate arrived (MCP without a project, legacy).
  const fps =
    a.fpsNum != null && a.fpsDen != null && a.fpsNum > 0 && a.fpsDen > 0
      ? a.fpsNum / a.fpsDen
      : 30
  const meta = { duration, width: a.width, height: a.height, fps, settleRafs: h.frames ? 2 : a.settleRafs }
  const expr = `window.__motifRender(${JSON.stringify(a.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify(meta)})`
  const firstPaint = h.lastSize === null
  try {
    if (h.lastSize?.w !== a.width || h.lastSize?.h !== a.height) {
      if (h.frames) h.win.setContentSize(a.width, a.height)
      await h.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height, deviceScaleFactor: 1, mobile: false })
      await h.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      if (h.frames) {
        h.win.webContents.startPainting()
        await h.send('Runtime.evaluate', { expression: 'window.__motifPaintReady()', awaitPromise: true })
      }
      h.lastSize = { w: a.width, h: a.height }
    }
  } catch (e) {
    teardownHost() // transport: wedged host — rebuild on next call
    throw e
  }
  let ev: any
  let phase = '__motifSetup'
  try {
    const setup = await h.send('Runtime.evaluate', {
      expression: `window.__motifSetup(${JSON.stringify(props)}, ${JSON.stringify(meta)})`,
      awaitPromise: true, returnByValue: true,
    }, SETUP_TIMEOUT_MS, 'setup (model loading / decoder initialization)')
    // Setup failures use the same lane handling as frame failures; the runtime
    // has already retired its workers. A timeout tears down the entire host.
    if (setup?.exceptionDetails) ev = setup
    else {
      phase = '__motifRender'
      h.frames?.prepare()
      ev = await h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    }
  } catch (e) {
    // A hung __motifRender is the Motif's own script (e.g. an infinite loop) —
    // content — but it also wedges the renderer for every other lane: mark the
    // lane failed so its sprites stop retrying AND rebuild the host.
    if (a.contentHash !== '') failLane(lane, e as Error)
    teardownHost()
    throw e
  }
  if (ev?.exceptionDetails) {
    // Content error: the Motif's script threw. The window and CDP transport
    // answered fine, so tearing the host down would punish every other Motif
    // with re-navigation + runtime re-injection. Fail the LANE instead —
    // same-lane captures fast-reject until contentHash changes (see failedLanes).
    const err = new Error(phase + ' threw: ' + JSON.stringify(ev.exceptionDetails))
    if (a.contentHash !== '') failLane(lane, err)
    throw err
  }
  try {
    if (h.frames && firstPaint && fenceFirstSurface) {
      // A newly navigated OSR surface may still contain the pre-setup document.
      // Native rAFs settle layout, but don't fence the compositor's raster work.
      // Read the whole surface: a clipped readback only fences its raster tiles.
      // This is paid once per navigation, not for subsequent animation frames.
      await h.send('Page.captureScreenshot', { format: 'png' })
    }
    return await output(h)
  } catch (e) {
    teardownHost() // wedged host: rebuild on next call
    throw e
  }
}

function enqueueCapture<T>(a: CaptureArgs, coalesceKey: string | undefined, run: () => Promise<T>, high = coalesceKey !== undefined): Promise<T> {
  // Fast-reject a lane whose content already failed this session: same
  // (motifId, contentHash) means the same throwing script against the same
  // page — don't spend queue slots or CDP round trips proving it again.
  const lane = laneKeyOf(a.motifId, a.contentHash)
  const laneError = failedLanes.get(lane)
  if (laneError) return Promise.reject(laneError)
  if (!coalesceKey) {
    // LOW priority: keyless prewarmer/baker/MCP work yields to on-demand
    // sprite frames queued behind it.
    return new Promise<T>((resolve, reject) => {
      schedule({
        key: undefined, high: false, stale: false, reject,
        run: async () => {
          // The lane may have failed while this ticket sat queued.
          const err = failedLanes.get(lane)
          if (err) { reject(err); return }
          try { resolve(await run()) } catch (e) { reject(e as Error) }
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
  const ticket: Ticket = { key: coalesceKey, high, stale: false, reject: () => {}, run: async () => {} }
  const out = new Promise<T>((resolve, reject) => {
    ticket.reject = reject
    ticket.run = async () => {
      // The lane may have failed while this ticket sat queued.
      const err = failedLanes.get(lane)
      if (err) { reject(err); return }
      try { resolve(await run()) } catch (e) { reject(e as Error) }
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

export function captureMotifFrameB64(a: CaptureArgs, coalesceKey?: string, high?: boolean): Promise<string> {
  return enqueueCapture(a, coalesceKey, () => doCapture(a, async h => {
    const shot = await h.send('Page.captureScreenshot', { format: 'png' })
    if (!shot?.data) throw new Error('captureScreenshot returned no data')
    return shot.data as string
  }), high)
}

export function captureMotifTexture<T>(a: CaptureArgs, consume: (t: OffscreenSharedTexture) => Promise<T>, coalesceKey?: string, high?: boolean): Promise<T> {
  if (!textureCaptureEnabled) return Promise.reject(new Error('Motif OSR unavailable'))
  return enqueueCapture(a, coalesceKey, () => doCapture(a, async h => {
    if (!h.frames) throw new Error('Motif host has no shared texture output')
    const texture = await h.frames.capture(a.width, a.height)
    try { return await consume(texture) } finally { texture.release() }
  }, true), high)
}
