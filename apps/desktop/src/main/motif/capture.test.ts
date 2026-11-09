// `electron` can't load under Vitest, so `BrowserWindow` is stubbed down to what
// `buildHost` + `hardenWindow` touch, and the CDP `debugger` to canned replies.
// The fake paints like an offscreen host: after each render, a paint carrying
// the frame's id and canvas witness in its marker row, as a shared texture or a bitmap by the
// host's kind. Like Electron's, a destroyed window paints no more and throws
// "Object has been destroyed" from every call into it. Behavior flags let each test script the failure it needs (slow
// render, withheld paint, wedged ready-probe); `opened`/`renderCalls` count the
// side effects under test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PNG } from 'pngjs'
import { FRAME_MARKER_PIXELS, FRAME_MARKER_READ_PIXELS, frameMarkerBits, frameMarkerRows, frameWitnessBits } from '../../shared/motifs/frameMarker'

let opened = 0
let lastHost: EventEmitter | null = null
/// The last window built, and whether the code under test destroyed it.
/// `silent`: the window paints no more, like a host gone silent.
let lastWindow: { destroyed: boolean; silent: boolean } | null = null
/// Whether the last host built takes shared textures (else bitmaps).
let lastHostTexture = false
/// The last `__motifRender(tSec, props, meta)` expression sent to the host —
/// the meta.fps assertions parse the third argument out of it.
let lastRenderExpr: string | null = null
/// Total __motifRender evaluations — the lane fast-reject test asserts a
/// same-lane capture never reaches the page.
let renderCalls = 0
/// The arguments of each `__motifShellFit(width, height, rows)` sent, in order.
const fits: string[] = []
/// Page events in order (`load:<motif>`, `render:<frameId>`, `paint:<frameId>`).
const events: string[] = []
/// Lanes (`motifId@contentHash`) whose __motifRender throws — a Motif's own
/// script raising, with the transport otherwise healthy.
const throwingLanes = new Set<string>()
/// Upcoming __motifRender calls to slow down (occupies the queue).
let slowRenders = 0
/// Delay before a frame's paint arrives, ms.
let paintDelayMs = 0
/// Frame ids whose paint never comes: the compositor skipped them.
const skippedPaints = new Set<number>()
/// Lanes whose windows never paint again: a host gone silent.
const silentLanes = new Set<string>()
/// Windows built while set paint their first frame without its canvases, as a
/// new window's first commit can.
let firstFrameWithoutCanvases = false
/// When true, the waitReady probe (Runtime.evaluate of the __motifRender
/// typeof check) never settles — a wedged offscreen renderer.
let hangReadyProbe = false
let hungCommand: string | null = null
let setupDelayMs = 0
let hangSetup = false
let hangFrame = false
/// The content size a fake host was last given; each window paints at its own.
let contentSize = { width: 32, height: 16 }
/// Texture handles released by the code under test.
let released = 0

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/// `${motifId}@${contentHash}` of the page loaded at `url`.
function laneOf(url: string): string | null {
  const m = /motif:\/\/([^/]+)\/(?:\.revisions\/[0-9a-f]+\/)?\.weftcut-capture-host\.html\?v=(.*)$/.exec(url)
  return m ? `${m[1]}@${decodeURIComponent(m[2]!)}` : null
}

const markerRow = (id: number | null, canvases = true) => {
  const rgba = new Uint8Array(FRAME_MARKER_READ_PIXELS * 4)
  const write = (bits: number[], at: number) => bits.forEach((bit, i) => rgba.set(bit ? [255, 255, 255, 255] : [0, 0, 0, 255], (at + i) * 4))
  if (id !== null) write(frameMarkerBits(id), 0)
  if (id !== null && canvases) write(frameWitnessBits(id), FRAME_MARKER_PIXELS)
  return rgba
}

/// The marker rows the fake native reader sees for a paint's handle.
async function readMarker(handle: Buffer): Promise<Uint8Array> {
  const { id, canvases } = JSON.parse(handle.toString()) as { id: number | null; canvases: boolean }
  return markerRow(id, canvases)
}

/// A bitmap host's paint: `surface` names the picture, the rows below it the id.
/// The picture's PNG is the bytes `PNG` (`UE5H` in base64).
function bitmap(id: number | null, surface: number, size: { width: number; height: number }, canvases = true) {
  const picture = (width: number, height: number): any => ({
    surface, size: { width, height },
    toPNG: () => Buffer.from('PNG'),
    resize: (to: { width: number; height: number }) => picture(to.width, to.height),
  })
  return {
    isEmpty: () => false,
    getSize: () => ({ ...size }),
    crop: (rect: { x: number; y: number; width: number; height: number }) => rect.y === size.height - frameMarkerRows(size.width)
      ? { toBitmap: () => Buffer.from(markerRow(id, canvases)) }
      : picture(rect.width, rect.height),
  }
}

vi.mock('electron', () => {
  class FakeBrowserWindow {
    texture: boolean
    /// The page loaded last; behavior flags key on its lane.
    url = 'about:blank'
    /// The window's content size: it paints at it, and a change models a new
    /// compositor surface (see setContentSize).
    size: { width: number; height: number }
    /// True from a navigation or resize until the next frame paints: the fake then
    /// paints the stale surface first, with no frame id, as a new surface can.
    fresh = true
    /// Its first frame's paint comes without the canvases (`firstFrameWithoutCanvases`).
    canvasless = firstFrameWithoutCanvases
    destroyed = false
    silent = false
    /// Throws as Electron does for a call into a destroyed window.
    alive = (): void => { if (this.destroyed) throw new TypeError('Object has been destroyed') }
    webContents = Object.assign(new EventEmitter(), {
      setZoomFactor: () => {},
      setFrameRate: () => { this.alive() },
      stopPainting: () => {},
      startPainting: () => {},
      paintFrame: (frameId: number, surface: number) => {
        const canvases = !this.canvasless
        const paints = this.fresh ? [{ id: null, surface: -1 }, { id: frameId, surface }] : [{ id: frameId, surface }]
        this.fresh = false
        this.canvasless = false
        const size = { ...this.size }
        const emit = () => {
          if (this.destroyed || this.silent || silentLanes.has(laneOf(this.url) ?? '')) return
          for (const p of paints) {
            if (p.id !== null && skippedPaints.delete(p.id)) continue
            if (p.id !== null) events.push(`paint:${p.id}`)
            if (this.texture) this.webContents.emit('paint', { texture: {
              textureInfo: { codedSize: size, pixelFormat: 'bgra', handle: { ntHandle: Buffer.from(JSON.stringify({ id: p.id, surface: p.surface, canvases })) } },
              surface: p.surface, release: () => { released++ },
            } }, {}, null)
            else this.webContents.emit('paint', {}, {}, bitmap(p.id, p.surface, size, canvases))
          }
        }
        if (paintDelayMs) setTimeout(emit, paintDelayMs)
        else queueMicrotask(emit)
      },
      setWindowOpenHandler: () => {},
      debugger: {
        attach: () => { this.alive() },
        detach: () => { this.alive() },
        sendCommand: (method: string, params?: { expression?: string }) => {
          this.alive()
          if (method === hungCommand) return new Promise(() => {})
          if (method === 'Page.captureScreenshot') throw new Error('captures never take screenshots')
          if (method === 'Runtime.evaluate') {
            const expr = params?.expression ?? ''
            const fit = /__motifShellFit\(([^)]*)\)/.exec(expr)
            if (fit) fits.push(fit[1]!)
            if (expr.startsWith('window.__motifSetup(')) {
              if (hangSetup) return new Promise(() => {})
              return (setupDelayMs ? delay(setupDelayMs) : Promise.resolve()).then(() => ({ result: { value: true } }))
            }
            if (hangReadyProbe && expr.includes('__motifHostReady')) {
              return new Promise(() => {})
            }
            if (expr.startsWith('window.__motifRender(')) {
              if (hangFrame) return new Promise(() => {})
              lastRenderExpr = expr
              renderCalls++
              // The Motif's own script throws; the CDP transport answers fine.
              if (throwingLanes.has(laneOf(this.url) ?? '')) {
                return Promise.resolve({ exceptionDetails: { text: 'boom' } })
              }
              const frameId = lastRenderMeta().frameId as number
              events.push(`render:${frameId}`)
              this.webContents.paintFrame(frameId, JSON.parse(expr.slice('window.__motifRender('.length).split(',')[0]!))
              if (slowRenders > 0) {
                slowRenders--
                return delay(250).then(() => ({ result: { value: true } }))
              }
            }
            return Promise.resolve({ result: { value: true } })
          }
          return Promise.resolve({})
        },
      },
    })
    constructor(options: { width: number; height: number; webPreferences: { offscreen: unknown } }) {
      opened++
      this.size = contentSize = { width: options.width, height: options.height }
      this.texture = typeof options.webPreferences.offscreen === 'object'
      lastHostTexture = this.texture
      lastHost = this.webContents
      lastWindow = this
    }
    loadURL = async (url: string): Promise<void> => {
      this.alive()
      this.url = url; this.fresh = true
      const lane = laneOf(url)
      if (lane) events.push(`load:${lane.split('@')[0]}`)
    }
    // A new size is a new compositor surface too.
    setContentSize = (width: number, height: number): void => { this.alive(); this.size = contentSize = { width, height }; this.fresh = true }
    destroy = (): void => { this.alive(); this.destroyed = true }
  }
  return { BrowserWindow: FakeBrowserWindow, nativeImage: { createFromBuffer: () => { throw new Error('not in these tests') } }, shell: { openExternal: async () => {} } }
})

const { MotifCapturer } = await import('./capture')
const { MOTIF_TUNING_DEFAULTS } = await import('../../shared/motifs/tuning')
type MotifCapturerDeps = import('./capture').MotifCapturerDeps

/// A store that knows no user Motif: the default duration, nothing pinned.
const emptyStore: MotifCapturerDeps['store'] = { getMotif: () => null, assertRenderable: () => {}, pinPackage: () => false }

/// A capturer of its own per test, with the runtime registered and the native
/// marker reader present; `deps` replaces any of its seams.
function newCapturer(deps: Partial<MotifCapturerDeps> = {}) {
  return new MotifCapturer({
    tuning: MOTIF_TUNING_DEFAULTS,
    store: emptyStore,
    runtimeSource: () => '/* clock-takeover runtime */',
    markerReader: { read: readMarker },
    textureReader: null,
    ...deps,
  })
}
/** For tests whose subject is the only host being replaced. */
const ONE_HOST = { ...MOTIF_TUNING_DEFAULTS, captureHosts: 1 }
let capturer = newCapturer()
beforeEach(() => { capturer = newCapturer() })
afterEach(() => { capturer.shutdown() })

/// The third (`meta`) argument of the recorded `__motifRender(...)` call. The
/// expression is `window.__motifRender(<tSec>, <propsJson>, <metaJson>)` with
/// JSON args — split on top-level commas (props may itself contain braces).
function lastRenderMeta(): Record<string, unknown> {
  const inner = lastRenderExpr!.slice('window.__motifRender('.length, -1)
  const args: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i))
      start = i + 1
    }
  }
  args.push(inner.slice(start))
  return JSON.parse(args[2]!) as Record<string, unknown>
}

// An unknown motif id keeps the catalog out of it: no manifest means the default
// duration, which is all doCapture needs to reach the paint.
const args = {
  motifId: 'not-a-builtin',
  tSec: 0,
  propsJson: '{}',
  width: 32,
  height: 16,
  contentHash: 'v1',
}
const bg = { priority: 'background' } as const

describe('MotifCapturer', () => {
  it('opens an offscreen host for a live capture', async () => {
    const before = opened
    await expect(capturer.capturePng(args, bg)).resolves.toBe('UE5H')
    expect(opened).toBe(before + 1)
  })

  it('allows a 6s setup but bounds initialization and each frame independently', async () => {
    vi.useFakeTimers()
    try {
      setupDelayMs = 6000
      const rendersBefore = renderCalls
      const slow = capturer.capturePng({ ...args, motifId: 'slow-setup' }, bg)
      await vi.advanceTimersByTimeAsync(5001)
      expect(renderCalls).toBe(rendersBefore)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(slow).resolves.toBe('UE5H')
      setupDelayMs = 0
      hangSetup = true
      const timeout = expect(capturer.capturePng({ ...args, motifId: 'hung-setup' }, bg)).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/30000ms.*setup/) })
      await vi.advanceTimersByTimeAsync(30_001)
      await timeout
      hangSetup = false
      hangFrame = true
      const frameTimeout = expect(capturer.capturePng({ ...args, motifId: 'hung-frame' }, bg)).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/5000ms/) })
      await vi.advanceTimersByTimeAsync(5001)
      await frameTimeout
      hangFrame = false
      const beforeRecovery = opened
      const recovered = capturer.capturePng({ ...args, motifId: 'recovered' }, bg)
      await vi.advanceTimersByTimeAsync(1)
      await expect(recovered).resolves.toBe('UE5H')
      expect(opened).toBe(beforeRecovery + 1)
    } finally {
      setupDelayMs = 0; hangSetup = false; hangFrame = false
      vi.useRealTimers()
    }
  })

  it('meta.fps is the passed fpsNum/fpsDen', async () => {
    await expect(capturer.capturePng({ ...args, fpsNum: 30000, fpsDen: 1001 }, bg)).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBeCloseTo(30000 / 1001)
    await expect(capturer.capturePng({ ...args, fpsNum: 60, fpsDen: 1 }, bg)).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(60)
  })

  it('meta.fps falls back to 30 when fps is absent or invalid', async () => {
    await expect(capturer.capturePng(args, bg)).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(30)
    await expect(capturer.capturePng({ ...args, fpsNum: 60, fpsDen: 0 }, bg)).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(30)
    await expect(capturer.capturePng({ ...args, fpsNum: -24, fpsDen: 1 }, bg)).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(30)
  })

  it('a wedged waitReady probe times out and the next capture rebuilds the host', async () => {
    // A new motif id forces navigation + a fresh ready-probe. The wedged probe
    // must fail by TIMEOUT (bounded), tear the host down, and let the very
    // next capture rebuild and succeed — not hang the serial queue forever.
    hangReadyProbe = true
    const wedged = { ...args, motifId: 'wedged-motif' }
    await expect(capturer.capturePng(wedged, bg)).rejects.toThrow(/timed out/)
    const openedAfterWedge = opened
    hangReadyProbe = false
    await expect(capturer.capturePng(wedged, bg)).resolves.toBe('UE5H')
    expect(opened).toBe(openedAfterWedge + 1)
  }, 20_000)

  it('a throwing __motifRender fails its lane without tearing the host down', async () => {
    // Content error: the Motif's own script throws while the window and CDP
    // transport answer fine — its window must NOT be rebuilt. Another Motif
    // then gets a window of its own, as every document does.
    capturer = newCapturer({ tuning: ONE_HOST })
    throwingLanes.add('broken-motif@v1')
    const openedBefore = opened
    await expect(capturer.capturePng({ ...args, motifId: 'broken-motif', contentHash: 'v1' }, bg))
      .rejects.toMatchObject({ code: 'content', message: expect.stringMatching(/__motifRender threw/) })
    expect(opened).toBe(openedBefore + 1)
    expect(lastWindow!.destroyed).toBe(false)
    const broken = lastWindow!
    await expect(capturer.capturePng({ ...args, motifId: 'healthy-motif' }, bg)).resolves.toBe('UE5H')
    expect(opened).toBe(openedBefore + 2)
    expect(broken.destroyed).toBe(true)
  })

  it.each(['Emulation.setDeviceMetricsOverride', 'Emulation.setDefaultBackgroundColorOverride'])(
    'a wedged %s cannot strand the capture queue', async (method) => {
      vi.useFakeTimers()
      try {
        hungCommand = method
        const request = { ...args, motifId: `emulation-${opened}`, width: 64 }
        const failure = expect(capturer.capturePng(request, bg)).rejects.toThrow(/timed out/)
        await vi.advanceTimersByTimeAsync(5001)
        await failure
        const before = opened
        hungCommand = null
        await expect(capturer.capturePng(request, bg)).resolves.toBe('UE5H')
        expect(opened).toBe(before + 1)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        hungCommand = null
        vi.useRealTimers()
      }
    },
  )

  it('a failed lane fast-rejects until its contentHash changes', async () => {
    throwingLanes.add('broken-motif@v1')
    await expect(capturer.capturePng({ ...args, motifId: 'broken-motif', contentHash: 'v1' }, bg))
      .rejects.toThrow(/__motifRender threw/)
    // Same (motifId, contentHash) as that failure: reject without reaching the
    // page (no __motifRender evaluation) — the per-sprite retry storm against
    // known-bad content is cut off at enqueue time.
    const renderBefore = renderCalls
    await expect(capturer.capturePng({ ...args, motifId: 'broken-motif', contentHash: 'v1' }, bg))
      .rejects.toThrow(/__motifRender threw/)
    expect(renderCalls).toBe(renderBefore)
    // A draft edit changes the contentHash → new lane → automatic recovery.
    await expect(capturer.capturePng({ ...args, motifId: 'broken-motif', contentHash: 'v2' }, bg))
      .resolves.toBe('UE5H')
  })

  it('reads the manifest once per (motifId, contentHash), not per frame', async () => {
    // getMotif is readFileSync + parse on the capture hot path; the content
    // hash is the invalidation signal, so repeat captures of one lane resolve
    // the manifest once. Empty hash (MCP) has no signal → never cached.
    let reads = 0
    const manifest = {
      id: 'cached-motif', name: 'Cached', version: 1,
      size: [32, 16] as [number, number], default_duration_s: 5, props_schema: {},
    }
    capturer = newCapturer({
      store: {
        ...emptyStore,
        getMotif: (id: string) => {
          reads++
          return id === 'cached-motif' ? { manifest, html: '<html/>' } as unknown as ReturnType<MotifCapturerDeps['store']['getMotif']> : null
        },
      },
    })
    const at = (contentHash: string, tSec: number) =>
      capturer.capturePng({ ...args, motifId: 'cached-motif', contentHash, tSec }, bg)
    await expect(at('h1', 0)).resolves.toBe('UE5H')
    await expect(at('h1', 0.5)).resolves.toBe('UE5H')
    expect(reads).toBe(1)
    await expect(at('h2', 0)).resolves.toBe('UE5H')
    expect(reads).toBe(2)
    await expect(at('', 0)).resolves.toBe('UE5H')
    await expect(at('', 1)).resolves.toBe('UE5H')
    expect(reads).toBe(4)
  })

  it('sizes the host window to the capture plus its marker rows', async () => {
    const read = (motifId: string, tSec: number, width = 32, height = 16) =>
      capturer.capturePng({ ...args, motifId, tSec, width, height }, bg)
    // New document at the host's current size, then a new size on the same
    // page, then another document at that size: the window and the shell's
    // layout follow each.
    fits.length = 0
    await expect(read('sized-a', 2)).resolves.toBe('UE5H')
    await expect(read('sized-a', 3, 48, 24)).resolves.toBe('UE5H')
    expect(contentSize).toEqual({ width: 48, height: 26 }) // two marker rows below 48 pixels
    await expect(read('sized-b', 4, 48, 24)).resolves.toBe('UE5H')
    expect(fits).toEqual(['32, 16, 2', '48, 24, 2', '48, 24, 2'])
  })

  it.each([false, true])('leases the frame carrying its id, never a new surface\'s stale first paint (texture host: %s)', async texture => {
    capturer.setTextureEnabled(texture)
    const read = (motifId: string, tSec: number, width = 32, height = 16) => capturer.captureFrame(
      { ...args, motifId, tSec, width, height },
      async frame => ({
        kind: frame.kind,
        surface: frame.kind === 'texture' ? (frame.texture as unknown as { surface: number }).surface : (frame.image.crop({ x: 0, y: 0, width: frame.width, height: frame.height }) as unknown as { surface: number }).surface,
        width: frame.width, height: frame.height,
      }),
      bg,
    ).result
    // A new document, the same one again, another, a new size: each new
    // surface paints its stale picture first and is skipped.
    const kind = texture ? 'texture' : 'bitmap'
    expect(await read('surface-a', 2)).toEqual({ kind, surface: 2, width: 32, height: 16 })
    expect(lastHostTexture).toBe(texture)
    expect(await read('surface-a', 3)).toEqual({ kind, surface: 3, width: 32, height: 16 })
    expect(await read('surface-b', 4)).toEqual({ kind, surface: 4, width: 32, height: 16 })
    expect(await read('surface-b', 5, 48, 24)).toEqual({ kind, surface: 5, width: 48, height: 24 })
  })

  it.each([false, true])('a new host\'s first frame painted without its canvases renders again (texture host: %s)', async texture => {
    capturer.setTextureEnabled(texture)
    firstFrameWithoutCanvases = true
    events.length = 0
    try {
      const surface = await capturer.captureFrame({ ...args, motifId: 'canvasless', tSec: 2 },
        async frame => frame.kind === 'texture' ? (frame.texture as unknown as { surface: number }).surface : (frame.image.crop({ x: 0, y: 0, width: frame.width, height: frame.height }) as unknown as { surface: number }).surface,
        bg).result
      expect(surface).toBe(2)
      expect(events.filter(e => e.startsWith('render:'))).toHaveLength(2)
      expect(capturer.diagnostics().skippedFrames).toBe(1)
    } finally { firstFrameWithoutCanvases = false }
  })

  it('a frame whose surface exceeds the texture limit gets a bitmap host; a smaller one the texture host again', async () => {
    capturer = newCapturer({ tuning: ONE_HOST })
    capturer.setTextureEnabled(true)
    const kind = (width: number, height: number, tSec: number) => capturer.captureFrame(
      { ...args, motifId: 'over-the-limit', tSec, width, height }, async frame => frame.kind, bg).result
    // 8192 × (4096 + the marker row) × 4 bytes is just over 128 MiB.
    const before = opened
    expect(await kind(8192, 4096, 1)).toBe('bitmap')
    expect(lastHostTexture).toBe(false)
    expect(await kind(8192, 4095, 2)).toBe('texture')
    expect(lastHostTexture).toBe(true)
    expect(await kind(8192, 4096, 3)).toBe('bitmap')
    expect(opened - before).toBe(3)
  })

  it('a texture host serves PNG captures from the leased texture\'s picture, and releases it', async () => {
    const reads: number[] = []
    capturer = newCapturer({
      textureReader: {
        read: async (_handle, height) => {
          reads.push(height)
          return { finish: async to => { expect(to).toBe('png'); return PNG.sync.write(new PNG({ width: 32, height })) } }
        },
      },
    })
    capturer.setTextureEnabled(true)
    const releasedBefore = released
    const png = PNG.sync.read(Buffer.from(await capturer.capturePng({ ...args, motifId: 'png-on-texture' }, bg), 'base64'))
    expect([png.width, png.height]).toEqual([32, 16])
    expect(reads).toEqual([16])
    expect(contentSize).toEqual({ width: 32, height: 18 })
    expect(released - releasedBefore).toBeGreaterThanOrEqual(1)
  })

  it('renders the next frame of a page while earlier frames are still on their way to a paint', async () => {
    capturer = newCapturer({ tuning: ONE_HOST })
    await capturer.capturePng({ ...args, motifId: 'pipelined' }, bg)
    paintDelayMs = 50
    events.length = 0
    try {
      const frames = [1, 2, 3, 4].map(tSec => capturer.capturePng({ ...args, motifId: 'pipelined', tSec }, bg))
      await expect(Promise.all(frames)).resolves.toEqual(['UE5H', 'UE5H', 'UE5H', 'UE5H'])
      const renders = events.filter(e => e.startsWith('render:'))
      // Three frames render before the first paint; the fourth waits for room.
      expect(events.indexOf(renders[2]!)).toBeLessThan(events.findIndex(e => e.startsWith('paint:')))
      expect(events.indexOf(renders[3]!)).toBeGreaterThan(events.findIndex(e => e.startsWith('paint:')))
      // Another page waits until every paint of this one has arrived.
      events.length = 0
      const first = capturer.capturePng({ ...args, motifId: 'pipelined', tSec: 5 }, bg)
      const other = capturer.capturePng({ ...args, motifId: 'pipelined-next' }, bg)
      await Promise.all([first, other])
      expect(events.slice(0, 3)).toEqual([expect.stringMatching(/^render:/), expect.stringMatching(/^paint:/), 'load:pipelined-next'])
    } finally { paintDelayMs = 0 }
  })

  it('with one host, two Motifs asking for current frames switch hosts once per hostAffinityMs, not every frame', async () => {
    vi.useFakeTimers()
    // Each Motif keeps more current captures in main than its host has room
    // for in flight, so some always wait in the queue, for one second.
    const run = async (hostAffinityMs: number) => {
      capturer.shutdown()
      capturer = newCapturer({ tuning: { ...ONE_HOST, hostAffinityMs } })
      let running = true
      const done = { a: 0, b: 0 }
      const lane = async (id: 'a' | 'b') => {
        for (let t = 0; running; t++) {
          await capturer.capturePng({ ...args, motifId: `alternating-${id}`, tSec: t }, { priority: 'current' })
          done[id]++
        }
      }
      const outstanding = MOTIF_TUNING_DEFAULTS.framesInFlight + 1
      const lanes = (['a', 'b'] as const).flatMap(id => Array.from({ length: outstanding }, () => lane(id)))
      await vi.advanceTimersByTimeAsync(1000)
      running = false
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.all(lanes)
      return { ...capturer.diagnostics(), done }
    }
    paintDelayMs = 10
    try {
      const arrival = await run(0)
      const affinity = await run(250)
      // Both Motifs keep being served either way.
      for (const stats of [arrival, affinity]) expect(Math.min(stats.done.a, stats.done.b)).toBeGreaterThan(10)
      expect(arrival.hostBuilds).toBeGreaterThan(20)
      // One build per 250 ms window, the last one draining the queue.
      expect(affinity.hostBuilds).toBeLessThanOrEqual(1000 / 250 + 2)
      expect(affinity.affinityPicks).toBeGreaterThan(0)
    } finally {
      paintDelayMs = 0
      vi.useRealTimers()
    }
  })

  it('a consumer\'s failure leaves the host and the other frames in flight alone', async () => {
    await capturer.capturePng({ ...args, motifId: 'consumer-fails' }, bg)
    const before = opened
    paintDelayMs = 20
    try {
      const frames = [1, 2, 3].map(tSec => capturer.captureFrame({ ...args, motifId: 'consumer-fails', tSec },
        async () => { if (tSec === 1) throw new Error('consumer gone'); return tSec }, bg).result)
      const settled = await Promise.allSettled(frames)
      expect(settled.map(s => s.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
      expect(opened).toBe(before)
    } finally { paintDelayMs = 0 }
  })

  it('renders a frame the compositor skipped again', async () => {
    await capturer.capturePng({ ...args, motifId: 'skipping' }, bg)
    capturer.diagnostics(true)
    paintDelayMs = 20
    try {
      const rendersBefore = renderCalls
      // The next frame id the host will take is unknown here; skip whichever
      // frame renders first.
      const firstRender = new Promise<number>(resolve => {
        const check = setInterval(() => {
          const r = events.findLast(e => e.startsWith('render:'))
          if (r && renderCalls > rendersBefore) { clearInterval(check); resolve(Number(r.slice(7))) }
        }, 0)
      })
      events.length = 0
      const a = capturer.capturePng({ ...args, motifId: 'skipping', tSec: 1 }, bg)
      skippedPaints.add(await firstRender)
      const b = capturer.capturePng({ ...args, motifId: 'skipping', tSec: 2 }, bg)
      await expect(Promise.all([a, b])).resolves.toEqual(['UE5H', 'UE5H'])
      expect(renderCalls - rendersBefore).toBe(3)
      expect(capturer.diagnostics()).toMatchObject({ completed: 2, failed: 0, skippedFrames: 1 })
    } finally { paintDelayMs = 0; skippedPaints.clear() }
  })

  it('lets the shell\'s frame load only the Motif it was built for', async () => {
    await capturer.capturePng({ ...args, motifId: 'framed', contentHash: 'v7' }, bg)
    const navigate = (url: string, isMainFrame = false) => {
      const event = { url, isMainFrame, preventDefault: vi.fn() }
      lastHost!.emit('will-frame-navigate', event)
      return event.preventDefault.mock.calls.length > 0
    }
    expect(navigate('motif://framed/index.html?v=v7')).toBe(false)
    expect(navigate('motif://other/index.html?v=v7')).toBe(true)
    expect(navigate('motif://framed/assets/x.html')).toBe(true)
    expect(navigate('https://example.com/')).toBe(true)
    expect(navigate('motif://framed/.weftcut-capture-host.html?v=v7', true)).toBe(false) // the top frame is hardenWindow's
  })

  it('a render timeout is probation: one retry on the rebuilt host, a second timeout latches the lane', async () => {
    vi.useFakeTimers()
    try {
      const timeoutOnce = async (motifId: string) => {
        hangFrame = true
        const hung = expect(capturer.capturePng({ ...args, motifId }, bg)).rejects.toThrow(/5000ms/)
        await vi.advanceTimersByTimeAsync(5001)
        await hung
        hangFrame = false
      }
      // One timeout: the host is rebuilt and the same lane renders again.
      await timeoutOnce('probation')
      const rebuilt = opened
      const retry = capturer.capturePng({ ...args, motifId: 'probation' }, bg)
      await vi.advanceTimersByTimeAsync(1)
      await expect(retry).resolves.toBe('UE5H')
      expect(opened).toBe(rebuilt + 1)
      // Success cleared the probation: the next timeout is a first strike again.
      await timeoutOnce('probation')
      const again = capturer.capturePng({ ...args, motifId: 'probation' }, bg)
      await vi.advanceTimersByTimeAsync(1)
      await expect(again).resolves.toBe('UE5H')
      // Two consecutive timeouts: the lane is latched and never reaches the page.
      await timeoutOnce('verdict')
      await timeoutOnce('verdict')
      const renders = renderCalls, hostsBefore = opened
      await expect(capturer.capturePng({ ...args, motifId: 'verdict' }, bg)).rejects.toMatchObject({ code: 'content', message: '[motif:content] motif capture timed out after 5000ms: Runtime.evaluate' })
      expect(renderCalls).toBe(renders)
      expect(opened).toBe(hostsBefore)
      // An explicit retry lifts the verdict like any other content latch.
      capturer.resetFailure('verdict', args.contentHash)
      const lifted = capturer.capturePng({ ...args, motifId: 'verdict' }, bg)
      await vi.advanceTimersByTimeAsync(1)
      await expect(lifted).resolves.toBe('UE5H')
    } finally {
      hangFrame = false
      vi.useRealTimers()
    }
  })

  it('reports page reuse independently of total captures and allows diagnostics reset', async () => {
    capturer = newCapturer({ tuning: ONE_HOST })
    await capturer.capturePng({ ...args, motifId: 'diagnostics', tSec: 0 }, bg)
    await capturer.capturePng({ ...args, motifId: 'diagnostics', tSec: 1 }, bg)
    await capturer.capturePng({ ...args, motifId: 'diagnostics-next', tSec: 0 }, bg)
    const stats = capturer.diagnostics()
    expect(stats).toMatchObject({ captures: 3, completed: 3, failed: 0, pageLoads: 2, hostEvictions: 1, bitmapCaptures: 3, textureCaptures: 0, queued: 0, rendering: 0 })
    expect(stats.hosts).toEqual([expect.objectContaining({ motifId: 'diagnostics-next', contentHash: 'v1', texture: false, width: 32, height: 16, rendering: false, captures: 1 })])
    expect(stats.captureMs).toBeGreaterThanOrEqual(0)
    expect(stats.loadMs).toBeGreaterThanOrEqual(0)
    expect(capturer.diagnostics(true)).toMatchObject({ captures: 0, pageLoads: 0, hostEvictions: 0 })
  })

  it('with two capture hosts, two Motifs render at once on a host each, and the least recently used one is replaced', async () => {
    capturer = newCapturer({ tuning: { ...MOTIF_TUNING_DEFAULTS, captureHosts: 2 } })
    const before = opened
    slowRenders = 2
    const a = capturer.capturePng({ ...args, motifId: 'pool-a' }, bg)
    const b = capturer.capturePng({ ...args, motifId: 'pool-b', width: 48, height: 24 }, bg)
    await vi.waitFor(() => expect(capturer.diagnostics()).toMatchObject({ rendering: 2, hosts: [{ motifId: 'pool-a', rendering: true }, { motifId: 'pool-b', rendering: true }] }))
    await expect(Promise.all([a, b])).resolves.toEqual(['UE5H', 'UE5H'])
    await capturer.capturePng({ ...args, motifId: 'pool-b', tSec: 1, width: 48, height: 24 }, bg)
    await capturer.capturePng({ ...args, motifId: 'pool-a', tSec: 1 }, bg)
    expect(opened - before).toBe(2)
    expect(capturer.diagnostics()).toMatchObject({
      captures: 4, completed: 4, hostBuilds: 2, hostEvictions: 0, rendering: 0, queued: 0,
      hosts: [
        { motifId: 'pool-a', texture: false, width: 32, height: 16, rendering: false, captures: 2 },
        { motifId: 'pool-b', texture: false, width: 48, height: 24, rendering: false, captures: 2 },
      ],
    })
    // `pool-b` rendered less recently: a third Motif replaces it.
    await capturer.capturePng({ ...args, motifId: 'pool-c' }, bg)
    const stats = capturer.diagnostics()
    expect(stats).toMatchObject({ hostBuilds: 3, hostEvictions: 1 })
    expect(stats.hosts.map(host => host.motifId)).toEqual(['pool-a', 'pool-c'])
    expect(stats.hosts[0]!.idleMs).toBeGreaterThanOrEqual(0)
  })

  it('with two capture hosts, a host that stops painting fails only its own frames', async () => {
    vi.useFakeTimers()
    try {
      capturer = newCapturer({ tuning: { ...MOTIF_TUNING_DEFAULTS, captureHosts: 2 } })
      const warm = (motifId: string) => {
        const done = capturer.capturePng({ ...args, motifId }, bg)
        return vi.advanceTimersByTimeAsync(1).then(() => done)
      }
      await warm('pool-healthy')
      const healthyWindow = lastWindow!
      await warm('pool-silent')
      const silentWindow = lastWindow!
      silentLanes.add('pool-silent@v1')
      const lost = expect(capturer.capturePng({ ...args, motifId: 'pool-silent', tSec: 1 }, bg)).rejects.toThrow(/paint timed out/)
      const healthy = [1, 2].map(tSec => capturer.capturePng({ ...args, motifId: 'pool-healthy', tSec }, bg))
      await vi.advanceTimersByTimeAsync(1)
      await expect(Promise.all(healthy)).resolves.toEqual(['UE5H', 'UE5H'])
      expect(capturer.diagnostics().hosts.find(host => host.motifId === 'pool-silent')?.framesInFlight).toBe(1)
      await vi.advanceTimersByTimeAsync(5001)
      await lost
      expect(silentWindow.destroyed).toBe(true)
      expect(healthyWindow.destroyed).toBe(false)
      expect(capturer.diagnostics().hosts.map(host => host.motifId)).toEqual(['pool-healthy'])
    } finally {
      silentLanes.clear()
      vi.useRealTimers()
    }
  })

  it('a step waiting for room renders on a rebuilt host when a frame in flight times out, and its lane stays open', async () => {
    vi.useFakeTimers()
    try {
      const capture = (tSec: number) => capturer.capturePng({ ...args, motifId: 'timeout-in-flight', tSec }, bg)
      const warm = capture(0)
      await vi.advanceTimersByTimeAsync(1)
      await expect(warm).resolves.toBe('UE5H')
      const silent = lastWindow!
      silent.silent = true
      const before = { opened, renders: renderCalls }
      const lost = Promise.allSettled([1, 2, 3].map(capture))
      const waiting = capture(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(renderCalls - before.renders).toBe(3)
      await vi.advanceTimersByTimeAsync(5001)
      expect((await lost).map(s => s.status)).toEqual(['rejected', 'rejected', 'rejected'])
      await expect(waiting).resolves.toBe('UE5H')
      expect(silent.destroyed).toBe(true)
      expect(opened).toBe(before.opened + 1)
      const next = capture(5)
      await vi.advanceTimersByTimeAsync(1)
      await expect(next).resolves.toBe('UE5H')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a texture switch while a step waits for room renders it on a bitmap host, and its lane stays open', async () => {
    vi.useFakeTimers()
    try {
      capturer.setTextureEnabled(true)
      const capture = (tSec: number) => capturer.captureFrame({ ...args, motifId: 'switch-in-flight', tSec }, async frame => frame.kind, bg).result
      const warm = capture(0)
      await vi.advanceTimersByTimeAsync(1)
      await expect(warm).resolves.toBe('texture')
      const textureWindow = lastWindow!
      paintDelayMs = 50
      const before = { opened, renders: renderCalls }
      const lost = Promise.allSettled([1, 2, 3].map(capture))
      const waiting = capture(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(renderCalls - before.renders).toBe(3)
      capturer.setTextureEnabled(false)
      await vi.advanceTimersByTimeAsync(100)
      expect((await lost).map(s => s.status)).toEqual(['rejected', 'rejected', 'rejected'])
      await expect(waiting).resolves.toBe('bitmap')
      expect(textureWindow.destroyed).toBe(true)
      expect(lastHostTexture).toBe(false)
      // The host it opened serves the lane's next frame.
      const next = capture(5)
      await vi.advanceTimersByTimeAsync(100)
      await expect(next).resolves.toBe('bitmap')
      expect(opened).toBe(before.opened + 1)
      expect(capturer.diagnostics().hosts).toEqual([expect.objectContaining({ motifId: 'switch-in-flight', texture: false })])
    } finally {
      paintDelayMs = 0
      vi.useRealTimers()
    }
  })

  it('a resize waiting for its host\'s frames renders on a rebuilt host when that host retires', async () => {
    vi.useFakeTimers()
    try {
      const capture = (tSec: number, width = 32, height = 16) => capturer.capturePng({ ...args, motifId: 'resize-retired', tSec, width, height }, bg)
      const warm = capture(0)
      await vi.advanceTimersByTimeAsync(1)
      await expect(warm).resolves.toBe('UE5H')
      const silent = lastWindow!
      silent.silent = true
      const before = { opened, renders: renderCalls }
      const lost = expect(capture(1)).rejects.toThrow(/paint timed out/)
      const resized = capture(2, 48, 24)
      await vi.advanceTimersByTimeAsync(1)
      expect(renderCalls - before.renders).toBe(1)
      await vi.advanceTimersByTimeAsync(5001)
      await lost
      await expect(resized).resolves.toBe('UE5H')
      expect(silent.destroyed).toBe(true)
      expect(opened).toBe(before.opened + 1)
      expect(contentSize).toEqual({ width: 48, height: 26 }) // two marker rows below 48 pixels
      const next = capture(3, 48, 24)
      await vi.advanceTimersByTimeAsync(1)
      await expect(next).resolves.toBe('UE5H')
    } finally {
      vi.useRealTimers()
    }
  })

  it('explicit retry clears only the selected content failure latch', async () => {
    throwingLanes.add('retry-content@v1')
    throwingLanes.add('other-failure@v1')
    const retryArgs = { ...args, motifId: 'retry-content' }
    const otherArgs = { ...args, motifId: 'other-failure' }
    await expect(capturer.capturePng(retryArgs, bg)).rejects.toThrow('__motifRender threw')
    await expect(capturer.capturePng(otherArgs, bg)).rejects.toThrow('__motifRender threw')
    throwingLanes.delete('retry-content@v1')
    throwingLanes.delete('other-failure@v1')
    await expect(capturer.capturePng(retryArgs, bg)).rejects.toThrow('__motifRender threw')
    capturer.resetFailure(retryArgs.motifId, retryArgs.contentHash)
    await expect(capturer.capturePng(retryArgs, bg)).resolves.toBe('UE5H')
    await expect(capturer.capturePng(otherArgs, bg)).rejects.toThrow('__motifRender threw')
  })

  it('refuses a capture queued past shutdown instead of reopening the host', async () => {
    const openedBefore = opened
    capturer.shutdown()
    await expect(capturer.capturePng(args, bg)).rejects.toThrow(/shut down/)
    expect(opened).toBe(openedBefore)
  })
})
