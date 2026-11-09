import { BrowserWindow } from 'electron'
import { MotifFrameSkippedError, OffscreenFrames, type MotifOsrFrame } from './offscreenFrames.js'
import type { MotifMarkerReader } from './native.js'
import { BITMAP_CANVAS_RUNTIME_SOURCE } from './bitmapCanvasRuntime.js'
import { hardenWindow, markInternalWindow } from '../windows'
import { MotifError, motifErrorCode } from '../../shared/motifs/errors.js'
import { CAPTURE_HOST_FILE, frameMarkerRows } from '../../shared/motifs/frameMarker.js'
import { MOTIF_DEADLINES, type MotifTuning } from '../../shared/motifs/tuning.js'
import type { Rendered } from './captureQueue.js'
import type { HostKey, PooledHost } from './hostPool.js'
import type { PinnedPackage } from './store.js'

/** The capture phases whose time the capturer accumulates. */
export type CapturePhase = 'loadMs' | 'readyMs' | 'setupMs' | 'renderMs' | 'outputMs'

export interface CaptureHostEnv {
  /// The clock-takeover runtime, injected into every document of the window.
  runtime: string
  /// Read only on a texture host.
  markerReader: Pick<MotifMarkerReader, 'read'> | null
  tuning: Pick<MotifTuning, 'framesInFlight' | 'captureFrameRate' | 'stallNudgeMs'>
  timed<T>(phase: CapturePhase, run: () => Promise<T>): Promise<T>
}

/** One frame's render step: the frame's time and size, and the props and
 * meta its setup and render receive. */
export interface RenderStep {
  tSec: number
  width: number
  height: number
  props: Record<string, unknown>
  meta: { duration: number; width: number; height: number; fps: number }
}

/** Why a step failed. `threw`: the Motif's script threw in its served page,
 * the host is healthy. `hung`: setup or render ran past its deadline.
 * `transport`: the window or CDP failed mid-step. `unready`: the Motif's frame
 * holds no served page (an error status) or never finished loading. Every
 * kind but `threw` retires the host. */
export class HostRenderError extends Error {
  constructor(readonly kind: 'transport' | 'hung' | 'threw' | 'unready', readonly error: unknown) {
    super(String((error as Error | undefined)?.message ?? error), { cause: error })
  }
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

/// The Motif page a host's frame shows: its pinned revision's, else the
/// Motif's own.
function motifFrameUrl(key: HostKey, pinned: boolean): string {
  const dir = `motif://${key.motifId}/${pinned ? `.revisions/${key.contentHash}/` : ''}`
  return `${dir}index.html?v=${encodeURIComponent(key.contentHash)}`
}

/** An offscreen window showing one Motif content version (`key`), and the
 * frames rendered on it that are still on their way to a paint. One render
 * step at a time; its owner (`HostPool`) serializes them. Another content
 * version of the same Motif replaces the document in the window's frame
 * (`swap`). */
export class CaptureHost implements PooledHost {
  private readyFor = false
  private lastSize: { width: number; height: number }
  private retiredFlag = false
  /// Paints still to arrive for frames already rendered (ADR 0159). Settled
  /// whatever the outcome; tracked only to bound and drain the pipeline.
  private readonly inFlight = new Set<Promise<void>>()
  private readonly settledListeners: (() => void)[] = []

  /// The Motif page the window's frame may navigate to.
  private frameUrl: string

  private constructor(
    private currentKey: HostKey,
    private readonly win: BrowserWindow,
    private readonly frames: OffscreenFrames,
    private readonly env: CaptureHostEnv,
    size: { width: number; height: number },
    /// The revision snapshot its page and companion URLs come from, held until
    /// the host retires or shows another version.
    private pin: PinnedPackage | null,
  ) {
    this.lastSize = size
    this.frameUrl = motifFrameUrl(currentKey, pin !== null)
  }

  get key(): HostKey { return this.currentKey }

  /** The window's renderer process, null once it is gone. */
  get pid(): number | null {
    try { return this.win.webContents.getOSProcessId() || null } catch { return null }
  }

  /// Builds the host of one Motif. The shell page, which runs no scripts of
  /// its own, is the window's only top-level navigation: a bitmap host paints
  /// real alpha only for a window's first document
  /// (docs/notes/electron-chromium-behavior.md#a-bitmap-osr-window-paints-alpha-only-for-its-first-document),
  /// so another Motif gets a new window, and another content version only a
  /// new document in the shell's frame (`swap`). The runtime is
  /// registered once the shell has loaded, and the shell then loads the Motif
  /// into its frame, whose documents the runtime reaches before their scripts.
  /// `pin`: the content version is served from its pinned revision, which the
  /// host releases when it retires, the failed build included.
  static async open(key: HostKey, size: { width: number; height: number }, pin: PinnedPackage | null, env: CaptureHostEnv): Promise<CaptureHost> {
    const { motifId, texture } = key
    const { width, height } = size
    const surfaceHeight = height + frameMarkerRows(width)
    // The shell frames the Motif above the surface's marker rows
    // (shared/motifs/frameMarker.ts); the Motif sees only its own size.
    // Sized to the capture before its document loads: the macOS bitmap host
    // drops a new document's first commit while the window and the page's
    // emulated size differ
    // (docs/notes/electron-chromium-behavior.md#macos-offscreen-bitmap-host-drops-the-first-commit-when-window-and-emulation-sizes-differ).
    const win = new BrowserWindow({
      show: false,
      width, height: surfaceHeight, useContentSize: true,
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
    // `offscreen: true` is a paint target, not a lifecycle class: unmarked, this
    // window votes in the quit decision and the app stops quitting when the editor
    // closes (windows.ts → quitIfLastUserWindowClosed). Before the awaits, per its
    // same-tick contract.
    markInternalWindow(win)
    const frames = new OffscreenFrames(win.webContents, texture ? env.markerReader : null, MOTIF_DEADLINES.captureCommandMs, env.tuning.stallNudgeMs)
    // Navigation lockdown for the untrusted Motif page: deny every `window.open`
    // OUTRIGHT (allowExternalOpen:false — a Motif must not be able to pop the user's
    // browser) and block any page-initiated navigation off the app's content. The
    // main-process `loadURL` calls below are programmatic and don't trip will-navigate.
    hardenWindow(win, { allowExternalOpen: false })
    const host = new CaptureHost(key, win, frames, env, { width, height }, pin)
    // hardenWindow guards the top frame; the Motif runs in the shell's frame,
    // which goes only to the version the host shows.
    win.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame && event.url !== host.frameUrl) event.preventDefault()
    })
    // A CDP init that throws mid-build must not orphan the window.
    try {
      win.webContents.debugger.attach('1.3')
      await env.timed('loadMs', () => withTimeout(win.loadURL(`motif://${motifId}/${CAPTURE_HOST_FILE}`), MOTIF_DEADLINES.captureLoadMs, 'loadURL motif'))
      await host.send('Page.enable')
      await host.send('Runtime.enable')
      await host.send('Page.addScriptToEvaluateOnNewDocument', {
        source: texture ? env.runtime : BITMAP_CANVAS_RUNTIME_SOURCE + env.runtime,
      })
      // The emulation pins deviceScaleFactor to 1; the default background keeps
      // `background: transparent` real alpha.
      await host.send('Emulation.setDeviceMetricsOverride', { width, height: surfaceHeight, deviceScaleFactor: 1, mobile: false })
      await host.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      const shell = await env.timed('loadMs', () => host.send('Runtime.evaluate', {
        expression: `${env.runtime};window.__motifShellFit(${width}, ${height}, ${frameMarkerRows(width)});window.__motifShellLoad(${JSON.stringify(host.frameUrl)})`,
        awaitPromise: true, returnByValue: true,
      }, MOTIF_DEADLINES.captureLoadMs, 'load Motif frame'))
      if (shell?.exceptionDetails) throw new Error('capture host shell failed: ' + JSON.stringify(shell.exceptionDetails))
      win.webContents.setFrameRate(env.tuning.captureFrameRate)
      return host
    } catch (e) {
      host.retire()
      throw e
    }
  }

  get retired(): boolean { return this.retiredFlag }
  get framesInFlight(): number { return this.inFlight.size }
  get hasRoom(): boolean { return this.inFlight.size < this.env.tuning.framesInFlight }
  get size(): { width: number; height: number } { return { ...this.lastSize } }

  /** Gets the host ready for a frame at `width` × `height`: room in the
   * pipeline, the Motif ready, the window at that size. A failure here is the
   * host's, never the Motif's content: the host retires and the error is
   * rethrown.
   *
   * Returns with the host retired, and nothing thrown, when it retired under
   * the step (a frame in flight failed, every host retired) before the step
   * touched the page: the caller renders on another host. The waits wake
   * exactly then, since a failing frame retires its host before it settles. */
  async prepare(width: number, height: number): Promise<void> {
    const resize = this.lastSize.width !== width || this.lastSize.height !== height
    // A resize replaces the surface the paints in flight come from.
    if (resize) await this.drain()
    while (this.inFlight.size >= this.env.tuning.framesInFlight) await Promise.race(this.inFlight)
    if (this.retiredFlag) return
    try {
      await this.env.timed('readyMs', () => this.waitReady())
      if (resize) {
        // Another size for the same document; the window and the shell's
        // layout follow, as at build.
        const rows = frameMarkerRows(width)
        this.win.setContentSize(width, height + rows)
        await this.send('Emulation.setDeviceMetricsOverride', { width, height: height + rows, deviceScaleFactor: 1, mobile: false })
        const fit = await this.send('Runtime.evaluate', { expression: `window.__motifShellFit(${width}, ${height}, ${rows})`, returnByValue: true })
        if (fit?.exceptionDetails) throw new Error('capture host shell fit failed: ' + JSON.stringify(fit.exceptionDetails))
        this.lastSize = { width, height }
      }
    } catch (e) {
      // Retired by another frame or the pool mid-probe: the window went away,
      // the step did not fail on its own.
      if (this.retiredFlag) return
      this.retire()
      throw e
    }
  }

  /** Runs the Motif's setup and render for one frame and leases the paint
   * carrying its id; returns once the frame has committed, so the next one can
   * render while this one is still on its way to the capture. `output` runs
   * inside the lease. Throws `HostRenderError`. */
  async render<T>(step: RenderStep, output: (frame: MotifOsrFrame) => Promise<T>): Promise<Rendered<T>> {
    const { props, meta } = step
    let ev: any
    let phase = '__motifSetup'
    let lease: ReturnType<OffscreenFrames['expect']> | null = null
    try {
      const setup = await this.env.timed('setupMs', () => this.send('Runtime.evaluate', {
        expression: `window.__motifSetup(${JSON.stringify(props)}, ${JSON.stringify(meta)})`,
        awaitPromise: true, returnByValue: true,
      }, MOTIF_DEADLINES.captureSetupMs, 'setup (model loading / decoder initialization)'))
      // A throwing setup is answered like a throwing render; the runtime has
      // already retired its workers.
      if (setup?.exceptionDetails) ev = setup
      else {
        phase = '__motifRender'
        lease = this.frames.expect(step.width, step.height)
        const expr = `window.__motifRender(${JSON.stringify(step.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify({ ...meta, frameId: lease.id })})`
        ev = await this.env.timed('renderMs', () => this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
      }
    } catch (e) {
      lease?.cancel()
      // A hung __motifSetup/__motifRender wedges the renderer, so the host goes
      // whatever the cause.
      this.retire()
      throw new HostRenderError(motifErrorCode(e) === 'timeout' ? 'hung' : 'transport', e)
    }
    if (ev?.exceptionDetails) {
      // The window and CDP transport answered fine: the host stays for the
      // next Motif frame.
      lease?.cancel()
      throw new HostRenderError('threw', new MotifError('content', phase + ' threw: ' + JSON.stringify(ev.exceptionDetails)))
    }
    const leased = lease!
    const delivered = this.env.timed('outputMs', async () => {
      let frame: MotifOsrFrame
      try { frame = await leased.frame }
      catch (e) {
        // A skipped frame is rendered again; the host is healthy.
        if (!(e instanceof MotifFrameSkippedError)) this.retire()
        throw e
      }
      // The host painted this frame, so an output failure is its consumer's.
      // Retiring the host here would fail the other frames in flight on it.
      try { return await output(frame) }
      finally { if (frame.kind === 'texture') frame.texture.release() }
    })
    const settled = delivered.then(() => {}, () => {})
    this.inFlight.add(settled)
    void settled.then(() => {
      this.inFlight.delete(settled)
      for (const listener of this.settledListeners) listener()
    })
    return { delivered }
  }

  onFrameSettled(listener: () => void): void {
    this.settledListeners.push(listener)
  }

  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all(this.inFlight)
  }

  /** Shows `key`, another content version of this host's Motif on its lane,
   * served from `pin`'s revision: the shell's frame loads its page, and the
   * next step waits for it to be ready as at build. The window, its shell and
   * the frame ids stay; a frame navigation keeps a bitmap host's alpha
   * (docs/notes/electron-chromium-behavior.md#a-bitmap-osr-window-paints-alpha-only-for-its-first-document).
   * The caller drained the frames in flight. False, with the host retired:
   * the frame did not load, or `key` is not this host's Motif and lane. */
  async swap(key: HostKey, pin: PinnedPackage | null): Promise<boolean> {
    if (this.retiredFlag || key.motifId !== this.currentKey.motifId || key.texture !== this.currentKey.texture || this.inFlight.size > 0) {
      pin?.release()
      this.retire()
      return false
    }
    const url = motifFrameUrl(key, pin !== null)
    this.frameUrl = url
    this.readyFor = false
    try {
      const loaded = await this.env.timed('loadMs', () => this.send('Runtime.evaluate', {
        expression: `window.__motifShellLoad(${JSON.stringify(url)})`,
        awaitPromise: true, returnByValue: true,
      }, MOTIF_DEADLINES.captureLoadMs, 'load Motif frame'))
      if (loaded?.exceptionDetails) throw new Error('capture host frame load failed: ' + JSON.stringify(loaded.exceptionDetails))
    } catch {
      pin?.release()
      this.retire()
      return false
    }
    this.pin?.release()
    this.pin = pin
    this.currentKey = key
    return true
  }

  retire(): void {
    if (this.retiredFlag) return
    this.retiredFlag = true
    this.frames.dispose()
    try { this.win.webContents.debugger.detach() } catch { /* already gone */ }
    try { this.win.destroy() } catch { /* already gone */ }
    this.pin?.release()
  }

  /// Every CDP command is bounded by construction, including Emulation: an
  /// untimed send to a wedged renderer would hold its render step forever.
  private send(method: string, params: object = {}, timeoutMs = MOTIF_DEADLINES.captureCommandMs, label = method): Promise<any> {
    return withTimeout(this.win.webContents.debugger.sendCommand(method, params), timeoutMs, label)
  }

  private async waitReady(): Promise<void> {
    if (this.readyFor) return
    const motifId = this.currentKey.motifId
    // The shell answers `ready` only once the Motif's frame has finished
    // loading the page the protocol served for it with a success status, so
    // setup never runs against an error body. The hostname guard closes the
    // navigate→stale-page race: with `standard:true` motif://<id>/… parses
    // with hostname===id.
    const probe =
      `(typeof window.__motifHostReady==='function' ? window.__motifHostReady(${JSON.stringify(motifId)}) : 'loading')`
    for (let i = 0; i < MOTIF_DEADLINES.readyAttempts; i++) {
      // Timed like every send: a wedged page does not unwedge between polls,
      // so the throw also skips the remaining attempts (they exist for a
      // LOADING page, which fails fast).
      const r = await this.send('Runtime.evaluate', { expression: probe, returnByValue: true })
      const state: unknown = r?.result?.value
      if (state === 'ready') { this.readyFor = true; return }
      if (typeof state === 'string' && state.startsWith('unserved')) {
        throw new HostRenderError('unready', new MotifError('transient', `motif '${motifId}' page was not served (status ${state.slice('unserved '.length)})`))
      }
      await delay(MOTIF_DEADLINES.readyPollMs)
    }
    throw new HostRenderError('unready', new MotifError('transient', `motif '${motifId}' never became ready (Motif frame not loaded, or wrong host page loaded)`))
  }
}
