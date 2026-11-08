// `electron` can't load under Vitest, so `BrowserWindow` is stubbed down to what
// `buildHost` + `hardenWindow` touch, and the CDP `debugger` to canned replies.
// The fake paints like an offscreen host: after each render, a paint carrying
// the frame's id in its marker row, as a shared texture or a bitmap by the
// host's kind. Behavior flags let each test script the failure it needs (slow
// render, withheld paint, wedged ready-probe); `opened`/`renderCalls` count the
// side effects under test.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PNG } from 'pngjs'
import { FRAME_MARKER_PIXELS, frameMarkerBits } from '../../shared/motifs/frameMarker'

let opened = 0
let lastHost: EventEmitter | null = null
/// The last window built, and whether the code under test destroyed it.
let lastWindow: { destroyed: boolean } | null = null
/// Whether the last host built takes shared textures (else bitmaps).
let lastHostTexture = false
/// The last `__motifRender(tSec, props, meta)` expression sent to the host —
/// the meta.fps assertions parse the third argument out of it.
let lastRenderExpr: string | null = null
/// Total __motifRender evaluations — the lane fast-reject test asserts a
/// same-lane capture never reaches the page.
let renderCalls = 0
/// The URL the fake host last loadURL'd — lets behavior flags key on which
/// motif page is "loaded" (lane tests) and which motif a render served
/// (priority-order test).
let currentUrl = 'about:blank'
/// Motif ids in render order — the priority tests assert a queued keyed
/// capture renders before a queued keyless one.
const renderOrder: string[] = []
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
/// When true, the waitReady probe (Runtime.evaluate of the __motifRender
/// typeof check) never settles — a wedged offscreen renderer.
let hangReadyProbe = false
let hungCommand: string | null = null
/// True from a navigation or resize until the next frame paints: the fake then
/// paints the stale surface first, with no frame id, as a new surface can.
let freshSurface = true
let setupDelayMs = 0
let hangSetup = false
let hangFrame = false
/// The capture host's current content size — the fake paints at it, and a
/// change models a new compositor surface (see setContentSize).
let contentSize = { width: 32, height: 16 }
/// Texture handles released by the code under test.
let released = 0

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/// `${motifId}@${contentHash}` of the page the fake host currently has loaded.
function currentLane(): string | null {
  const m = /motif:\/\/([^/]+)\/(?:\.revisions\/[0-9a-f]+\/)?\.weftcut-capture-host\.html\?v=(.*)$/.exec(currentUrl)
  return m ? `${m[1]}@${decodeURIComponent(m[2]!)}` : null
}

const markerRow = (id: number | null) => {
  const rgba = new Uint8Array(FRAME_MARKER_PIXELS * 4)
  if (id !== null) frameMarkerBits(id).forEach((bit, i) => rgba.set(bit ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4))
  return rgba
}

/// The marker row the fake native reader sees for a paint's handle.
async function readMarker(handle: Buffer): Promise<Uint8Array> {
  return markerRow((JSON.parse(handle.toString()) as { id: number | null }).id)
}

/// A bitmap host's paint: `surface` names the picture, the last row the id.
/// The picture's PNG is the bytes `PNG` (`UE5H` in base64).
function bitmap(id: number | null, surface: number, size: { width: number; height: number }) {
  const picture = (width: number, height: number): any => ({
    surface, size: { width, height },
    toPNG: () => Buffer.from('PNG'),
    resize: (to: { width: number; height: number }) => picture(to.width, to.height),
  })
  return {
    isEmpty: () => false,
    getSize: () => ({ ...size }),
    crop: (rect: { x: number; y: number; width: number; height: number }) => rect.height === 1 && rect.y === size.height - 1
      ? { toBitmap: () => Buffer.from(markerRow(id)) }
      : picture(rect.width, rect.height),
  }
}

vi.mock('electron', () => {
  class FakeBrowserWindow {
    texture: boolean
    webContents = Object.assign(new EventEmitter(), {
      setZoomFactor: () => {},
      setFrameRate: () => {},
      stopPainting: () => {},
      startPainting: () => {},
      paintFrame: (frameId: number, surface: number) => {
        const paints = freshSurface ? [{ id: null, surface: -1 }, { id: frameId, surface }] : [{ id: frameId, surface }]
        freshSurface = false
        const size = { ...contentSize }
        const emit = () => {
          for (const p of paints) {
            if (p.id !== null && skippedPaints.delete(p.id)) continue
            if (p.id !== null) events.push(`paint:${p.id}`)
            if (this.texture) this.webContents.emit('paint', { texture: {
              textureInfo: { codedSize: size, pixelFormat: 'bgra', handle: { ntHandle: Buffer.from(JSON.stringify({ id: p.id, surface: p.surface })) } },
              surface: p.surface, release: () => { released++ },
            } }, {}, null)
            else this.webContents.emit('paint', {}, {}, bitmap(p.id, p.surface, size))
          }
        }
        if (paintDelayMs) setTimeout(emit, paintDelayMs)
        else queueMicrotask(emit)
      },
      setWindowOpenHandler: () => {},
      debugger: {
        attach: () => {},
        detach: () => {},
        sendCommand: (method: string, params?: { expression?: string }) => {
          if (method === hungCommand) return new Promise(() => {})
          if (method === 'Page.captureScreenshot') throw new Error('captures never take screenshots')
          if (method === 'Runtime.evaluate') {
            const expr = params?.expression ?? ''
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
              renderOrder.push(currentLane()?.split('@')[0] ?? currentUrl)
              // The Motif's own script throws; the CDP transport answers fine.
              if (throwingLanes.has(currentLane() ?? '')) {
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
      contentSize = { width: options.width, height: options.height }
      freshSurface = true
      this.texture = typeof options.webPreferences.offscreen === 'object'
      lastHostTexture = this.texture
      lastHost = this.webContents
      lastWindow = this
    }
    destroyed = false
    loadURL = async (url: string): Promise<void> => {
      currentUrl = url; freshSurface = true
      const lane = currentLane()
      if (lane) events.push(`load:${lane.split('@')[0]}`)
    }
    // A new size is a new compositor surface too.
    setContentSize = (width: number, height: number): void => { contentSize = { width, height }; freshSurface = true }
    destroy = (): void => { this.destroyed = true }
  }
  return { BrowserWindow: FakeBrowserWindow, nativeImage: { createFromBuffer: () => { throw new Error('not in these tests') } }, shell: { openExternal: async () => {} } }
})

const { captureMotifFrameB64, captureMotifFrame, setTextureCaptureEnabled, setFrameMarkerReader, setTexturePngReader, setRuntimeSource, setMotifStore, shutdownCaptureHost, controlMotifCapture, captureDiagnostics, resetCaptureFailure } = await import('./capture')
setFrameMarkerReader(readMarker)
type UserMotifStoreT = import('./store').UserMotifStore

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

describe('capture host shutdown', () => {
  // Ordered on purpose: the shutdown latch is permanent, so every live-capture
  // test must run before the refusal test at the bottom.
  it('opens an offscreen host for a live capture', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    await expect(captureMotifFrameB64(args)).resolves.toBe('UE5H')
    expect(opened).toBe(1)
  })

  it('allows a 6s setup but bounds initialization and each frame independently', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    vi.useFakeTimers()
    try {
      setupDelayMs = 6000
      const rendersBefore = renderCalls
      const slow = captureMotifFrameB64({ ...args, motifId: 'slow-setup' })
      await vi.advanceTimersByTimeAsync(5001)
      expect(renderCalls).toBe(rendersBefore)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(slow).resolves.toBe('UE5H')
      setupDelayMs = 0
      hangSetup = true
      const timeout = expect(captureMotifFrameB64({ ...args, motifId: 'hung-setup' })).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/30000ms.*setup/) })
      await vi.advanceTimersByTimeAsync(30_001)
      await timeout
      hangSetup = false
      hangFrame = true
      const frameTimeout = expect(captureMotifFrameB64({ ...args, motifId: 'hung-frame' })).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/5000ms/) })
      await vi.advanceTimersByTimeAsync(5001)
      await frameTimeout
      hangFrame = false
      const beforeRecovery = opened
      const recovered = captureMotifFrameB64({ ...args, motifId: 'recovered' })
      await vi.advanceTimersByTimeAsync(1)
      await expect(recovered).resolves.toBe('UE5H')
      expect(opened).toBe(beforeRecovery + 1)
    } finally {
      setupDelayMs = 0; hangSetup = false; hangFrame = false
      vi.useRealTimers()
    }
  })

  it('supersedes a queued same-key request without executing it', async () => {
    // Occupy the chain with a slow keyless capture; queue two same-key
    // requests behind it. The newer must replace the older IMMEDIATELY, and
    // the older's chain slot must do no render work when reached.
    slowRenders = 1
    const before = renderCalls
    const p0 = captureMotifFrameB64(args)
    const pA = captureMotifFrameB64(args, 'sprite:layer-1')
    const pB = captureMotifFrameB64(args, 'sprite:layer-1')
    await expect(pA).rejects.toMatchObject({ code: 'superseded' })
    await expect(p0).resolves.toBe('UE5H')
    await expect(pB).resolves.toBe('UE5H')
    expect(renderCalls - before).toBe(2) // p0 + pB only — pA never executed
  })

  it('a keyed request that reaches the chain head runs (no self-supersede)', async () => {
    const before = renderCalls
    await expect(captureMotifFrameB64(args, 'sprite:layer-2')).resolves.toBe('UE5H')
    expect(renderCalls - before).toBe(1)
  })

  it('meta.fps is the passed fpsNum/fpsDen', async () => {
    await expect(captureMotifFrameB64({ ...args, fpsNum: 30000, fpsDen: 1001 })).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBeCloseTo(30000 / 1001)
    await expect(captureMotifFrameB64({ ...args, fpsNum: 60, fpsDen: 1 })).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(60)
  })

  it('meta.fps falls back to 30 when fps is absent or invalid', async () => {
    await expect(captureMotifFrameB64(args)).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(30)
    await expect(captureMotifFrameB64({ ...args, fpsNum: 60, fpsDen: 0 })).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(30)
    await expect(captureMotifFrameB64({ ...args, fpsNum: -24, fpsDen: 1 })).resolves.toBe('UE5H')
    expect(lastRenderMeta().fps).toBe(30)
  })

  it('a wedged waitReady probe times out and the next capture rebuilds the host', async () => {
    // A new motif id forces navigation + a fresh ready-probe. The wedged probe
    // must fail by TIMEOUT (bounded), tear the host down, and let the very
    // next capture rebuild and succeed — not hang the serial queue forever.
    hangReadyProbe = true
    const wedged = { ...args, motifId: 'wedged-motif' }
    await expect(captureMotifFrameB64(wedged)).rejects.toThrow(/timed out/)
    const openedAfterWedge = opened
    hangReadyProbe = false
    await expect(captureMotifFrameB64(wedged)).resolves.toBe('UE5H')
    expect(opened).toBe(openedAfterWedge + 1)
  }, 20_000)

  it('a throwing __motifRender fails its lane without tearing the host down', async () => {
    // Content error: the Motif's own script throws while the window and CDP
    // transport answer fine — its window must NOT be rebuilt. Another Motif
    // then gets a window of its own, as every document does.
    throwingLanes.add('broken-motif@v1')
    const openedBefore = opened
    await expect(captureMotifFrameB64({ ...args, motifId: 'broken-motif', contentHash: 'v1' }))
      .rejects.toMatchObject({ code: 'content', message: expect.stringMatching(/__motifRender threw/) })
    expect(opened).toBe(openedBefore + 1)
    expect(lastWindow!.destroyed).toBe(false)
    const broken = lastWindow!
    await expect(captureMotifFrameB64({ ...args, motifId: 'healthy-motif' })).resolves.toBe('UE5H')
    expect(opened).toBe(openedBefore + 2)
    expect(broken.destroyed).toBe(true)
  })

  it.each(['Emulation.setDeviceMetricsOverride', 'Emulation.setDefaultBackgroundColorOverride'])(
    'a wedged %s cannot strand the capture queue', async (method) => {
      vi.useFakeTimers()
      try {
        hungCommand = method
        const request = { ...args, motifId: `emulation-${opened}`, width: 64 }
        const failure = expect(captureMotifFrameB64(request)).rejects.toThrow(/timed out/)
        await vi.advanceTimersByTimeAsync(5001)
        await failure
        const before = opened
        hungCommand = null
        await expect(captureMotifFrameB64(request)).resolves.toBe('UE5H')
        expect(opened).toBe(before + 1)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        hungCommand = null
        vi.useRealTimers()
      }
    },
  )

  it('a failed lane fast-rejects until its contentHash changes', async () => {
    // Same (motifId, contentHash) as the failure above: reject without
    // reaching the page (no __motifRender evaluation) — the per-sprite retry
    // storm against known-bad content is cut off at enqueue time.
    const renderBefore = renderCalls
    await expect(captureMotifFrameB64({ ...args, motifId: 'broken-motif', contentHash: 'v1' }))
      .rejects.toThrow(/__motifRender threw/)
    expect(renderCalls).toBe(renderBefore)
    // A draft edit changes the contentHash → new lane → automatic recovery.
    await expect(captureMotifFrameB64({ ...args, motifId: 'broken-motif', contentHash: 'v2' }))
      .resolves.toBe('UE5H')
  })

  it('a queued keyed capture overtakes queued keyless work', async () => {
    // Occupy the host with a slow keyless capture; queue a second keyless one
    // behind it, then a keyed one. The keyed ticket (HIGH — the frame the user
    // is looking at NOW) must run before the queued keyless ticket (LOW),
    // while the RUNNING capture is never preempted.
    slowRenders = 1
    const orderBefore = renderOrder.length
    const p0 = captureMotifFrameB64({ ...args, motifId: 'low-first' })
    const p1 = captureMotifFrameB64({ ...args, motifId: 'low-second' })
    const p2 = captureMotifFrameB64({ ...args, motifId: 'high-sprite' }, 'sprite:prio')
    await expect(p0).resolves.toBe('UE5H')
    await expect(p1).resolves.toBe('UE5H')
    await expect(p2).resolves.toBe('UE5H')
    expect(renderOrder.slice(orderBefore)).toEqual(['low-first', 'high-sprite', 'low-second'])
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
    setMotifStore({
      getMotif: (id: string) => {
        reads++
        return id === 'cached-motif' ? { manifest, html: '<html/>' } : null
      },
    } as unknown as UserMotifStoreT)
    const at = (contentHash: string, tSec: number) =>
      captureMotifFrameB64({ ...args, motifId: 'cached-motif', contentHash, tSec })
    await expect(at('h1', 0)).resolves.toBe('UE5H')
    await expect(at('h1', 0.5)).resolves.toBe('UE5H')
    expect(reads).toBe(1)
    await expect(at('h2', 0)).resolves.toBe('UE5H')
    expect(reads).toBe(2)
    await expect(at('', 0)).resolves.toBe('UE5H')
    await expect(at('', 1)).resolves.toBe('UE5H')
    expect(reads).toBe(4)
  })

  it('promotes a shared background capture when a preview joins it', async () => {
    slowRenders = 1
    renderOrder.length = 0
    const running = captureMotifFrameB64({ ...args, motifId: 'running' })
    const background = captureMotifFrameB64({ ...args, motifId: 'background' }, 'job-bg', false)
    const joined = captureMotifFrameB64({ ...args, motifId: 'joined' }, 'job-joined', false)
    controlMotifCapture('job-joined', 'promote')
    await Promise.all([running, background, joined])
    expect(renderOrder).toEqual(['running', 'joined', 'background'])
  })

  it('cancels an abandoned broker ticket without capturing it', async () => {
    slowRenders = 1
    const before = renderCalls
    const running = captureMotifFrameB64(args)
    const abandoned = captureMotifFrameB64(args, 'abandoned', false)
    controlMotifCapture('abandoned', 'cancel')
    await expect(abandoned).rejects.toMatchObject({ code: 'superseded' })
    await running
    expect(renderCalls - before).toBe(1)
  })

  it('sizes the host window to the capture plus its marker row', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    const read = (motifId: string, tSec: number, width = 32, height = 16) =>
      captureMotifFrameB64({ ...args, motifId, tSec, width, height })
    try {
      // New document at the host's current size, then a new size on the same
      // page, then another document at that size: the window follows each.
      await expect(read('sized-a', 2)).resolves.toBe('UE5H')
      await expect(read('sized-a', 3, 48, 24)).resolves.toBe('UE5H')
      expect(contentSize).toEqual({ width: 48, height: 25 })
      await expect(read('sized-b', 4, 48, 24)).resolves.toBe('UE5H')
    } finally {
      contentSize = { width: 32, height: 16 }
    }
  })

  it.each([false, true])('leases the frame carrying its id, never a new surface\'s stale first paint (texture host: %s)', async texture => {
    setRuntimeSource('/* clock-takeover runtime */')
    setTextureCaptureEnabled(texture)
    try {
      const read = (motifId: string, tSec: number, width = 32, height = 16) => captureMotifFrame(
        { ...args, motifId, tSec, width, height },
        async frame => ({
          kind: frame.kind,
          surface: frame.kind === 'texture' ? (frame.texture as unknown as { surface: number }).surface : (frame.image.crop({ x: 0, y: 0, width: frame.width, height: frame.height }) as unknown as { surface: number }).surface,
          width: frame.width, height: frame.height,
        }),
      )
      // A new document, the same one again, another, a new size: each new
      // surface paints its stale picture first and is skipped.
      const kind = texture ? 'texture' : 'bitmap'
      expect(await read('surface-a', 2)).toEqual({ kind, surface: 2, width: 32, height: 16 })
      expect(lastHostTexture).toBe(texture)
      expect(await read('surface-a', 3)).toEqual({ kind, surface: 3, width: 32, height: 16 })
      expect(await read('surface-b', 4)).toEqual({ kind, surface: 4, width: 32, height: 16 })
      expect(await read('surface-b', 5, 48, 24)).toEqual({ kind, surface: 5, width: 48, height: 24 })
    } finally {
      setTextureCaptureEnabled(false)
      contentSize = { width: 32, height: 16 }
    }
  })

  it('a texture host serves PNG captures from the leased texture\'s picture, and releases it', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    setTextureCaptureEnabled(true)
    const reads: number[] = []
    setTexturePngReader(async (_handle, height) => {
      reads.push(height)
      return PNG.sync.write(new PNG({ width: 32, height }))
    })
    try {
      const releasedBefore = released
      const png = PNG.sync.read(Buffer.from(await captureMotifFrameB64({ ...args, motifId: 'png-on-texture' }), 'base64'))
      expect([png.width, png.height]).toEqual([32, 16])
      expect(reads).toEqual([16])
      expect(contentSize).toEqual({ width: 32, height: 17 })
      expect(released - releasedBefore).toBeGreaterThanOrEqual(1)
    } finally {
      setTextureCaptureEnabled(false)
      contentSize = { width: 32, height: 16 }
    }
  })

  it('renders the next frame of a page while earlier frames are still on their way to a paint', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    await captureMotifFrameB64({ ...args, motifId: 'pipelined' })
    paintDelayMs = 50
    events.length = 0
    try {
      const frames = [1, 2, 3, 4].map(tSec => captureMotifFrameB64({ ...args, motifId: 'pipelined', tSec }))
      await expect(Promise.all(frames)).resolves.toEqual(['UE5H', 'UE5H', 'UE5H', 'UE5H'])
      const renders = events.filter(e => e.startsWith('render:'))
      // Three frames render before the first paint; the fourth waits for room.
      expect(events.indexOf(renders[2]!)).toBeLessThan(events.findIndex(e => e.startsWith('paint:')))
      expect(events.indexOf(renders[3]!)).toBeGreaterThan(events.findIndex(e => e.startsWith('paint:')))
      // Another page waits until every paint of this one has arrived.
      events.length = 0
      const first = captureMotifFrameB64({ ...args, motifId: 'pipelined', tSec: 5 })
      const other = captureMotifFrameB64({ ...args, motifId: 'pipelined-next' })
      await Promise.all([first, other])
      expect(events.slice(0, 3)).toEqual([expect.stringMatching(/^render:/), expect.stringMatching(/^paint:/), 'load:pipelined-next'])
    } finally { paintDelayMs = 0 }
  })

  it('a consumer\'s failure leaves the host and the other frames in flight alone', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    await captureMotifFrameB64({ ...args, motifId: 'consumer-fails' })
    const before = opened
    paintDelayMs = 20
    try {
      const frames = [1, 2, 3].map(tSec => captureMotifFrame({ ...args, motifId: 'consumer-fails', tSec },
        async () => { if (tSec === 1) throw new Error('consumer gone'); return tSec }))
      const settled = await Promise.allSettled(frames)
      expect(settled.map(s => s.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
      expect(opened).toBe(before)
    } finally { paintDelayMs = 0 }
  })

  it('renders a frame the compositor skipped again', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    await captureMotifFrameB64({ ...args, motifId: 'skipping' })
    captureDiagnostics(true)
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
      const a = captureMotifFrameB64({ ...args, motifId: 'skipping', tSec: 1 })
      skippedPaints.add(await firstRender)
      const b = captureMotifFrameB64({ ...args, motifId: 'skipping', tSec: 2 })
      await expect(Promise.all([a, b])).resolves.toEqual(['UE5H', 'UE5H'])
      expect(renderCalls - rendersBefore).toBe(3)
      expect(captureDiagnostics()).toMatchObject({ completed: 2, failed: 0, skippedFrames: 1 })
    } finally { paintDelayMs = 0; skippedPaints.clear() }
  })

  it('lets the shell\'s frame load only the Motif it was built for', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    await captureMotifFrameB64({ ...args, motifId: 'framed', contentHash: 'v7' })
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
        const hung = expect(captureMotifFrameB64({ ...args, motifId })).rejects.toThrow(/5000ms/)
        await vi.advanceTimersByTimeAsync(5001)
        await hung
        hangFrame = false
      }
      // One timeout: the host is rebuilt and the same lane renders again.
      await timeoutOnce('probation')
      const rebuilt = opened
      const retry = captureMotifFrameB64({ ...args, motifId: 'probation' })
      await vi.advanceTimersByTimeAsync(1)
      await expect(retry).resolves.toBe('UE5H')
      expect(opened).toBe(rebuilt + 1)
      // Success cleared the probation: the next timeout is a first strike again.
      await timeoutOnce('probation')
      const again = captureMotifFrameB64({ ...args, motifId: 'probation' })
      await vi.advanceTimersByTimeAsync(1)
      await expect(again).resolves.toBe('UE5H')
      // Two consecutive timeouts: the lane is latched and never reaches the page.
      await timeoutOnce('verdict')
      await timeoutOnce('verdict')
      const renders = renderCalls, hostsBefore = opened
      await expect(captureMotifFrameB64({ ...args, motifId: 'verdict' })).rejects.toMatchObject({ code: 'content', message: '[motif:content] motif capture timed out after 5000ms: Runtime.evaluate' })
      expect(renderCalls).toBe(renders)
      expect(opened).toBe(hostsBefore)
      // An explicit retry lifts the verdict like any other content latch.
      resetCaptureFailure('verdict', args.contentHash)
      const lifted = captureMotifFrameB64({ ...args, motifId: 'verdict' })
      await vi.advanceTimersByTimeAsync(1)
      await expect(lifted).resolves.toBe('UE5H')
    } finally {
      hangFrame = false
      vi.useRealTimers()
    }
  })

  it('respects explicit foreground priority without a coalescing key', async () => {
    slowRenders = 1
    const before = renderOrder.length
    const running = captureMotifFrameB64({ ...args, motifId: 'keyless-running' })
    const background = captureMotifFrameB64({ ...args, motifId: 'keyless-background' }, undefined, false)
    const foreground = captureMotifFrameB64({ ...args, motifId: 'keyless-foreground' }, undefined, true)
    await Promise.all([running, background, foreground])
    expect(renderOrder.slice(before)).toEqual(['keyless-running', 'keyless-foreground', 'keyless-background'])
  })

  it('checks session currency after waiting in the capture queue, before page IO', async () => {
    slowRenders = 1
    const before = renderCalls
    const running = captureMotifFrameB64({ ...args, motifId: 'session-running' })
    let current = true
    const queued = captureMotifFrameB64({ ...args, motifId: 'stale-session' }, undefined, false, () => current)
    const rejected = expect(queued).rejects.toThrow('superseded')
    current = false
    await running
    await rejected
    expect(renderCalls - before).toBe(1)
    expect(currentUrl).toContain('session-running')
  })

  it('reports page reuse independently of total captures and allows diagnostics reset', async () => {
    captureDiagnostics(true)
    await captureMotifFrameB64({ ...args, motifId: 'diagnostics', tSec: 0 })
    await captureMotifFrameB64({ ...args, motifId: 'diagnostics', tSec: 1 })
    await captureMotifFrameB64({ ...args, motifId: 'diagnostics-next', tSec: 0 })
    const stats = captureDiagnostics()
    expect(stats).toMatchObject({ captures: 3, completed: 3, failed: 0, pageLoads: 2, bitmapCaptures: 3, textureCaptures: 0 })
    expect(stats.captureMs).toBeGreaterThanOrEqual(0)
    expect(stats.loadMs).toBeGreaterThanOrEqual(0)
    expect(captureDiagnostics(true)).toMatchObject({ captures: 0, pageLoads: 0 })
  })

  it('explicit retry clears only the selected content failure latch', async () => {
    throwingLanes.add('retry-content@v1')
    throwingLanes.add('other-failure@v1')
    const retryArgs = { ...args, motifId: 'retry-content' }
    const otherArgs = { ...args, motifId: 'other-failure' }
    await expect(captureMotifFrameB64(retryArgs)).rejects.toThrow('__motifRender threw')
    await expect(captureMotifFrameB64(otherArgs)).rejects.toThrow('__motifRender threw')
    throwingLanes.delete('retry-content@v1')
    throwingLanes.delete('other-failure@v1')
    await expect(captureMotifFrameB64(retryArgs)).rejects.toThrow('__motifRender threw')
    resetCaptureFailure(retryArgs.motifId, retryArgs.contentHash)
    await expect(captureMotifFrameB64(retryArgs)).resolves.toBe('UE5H')
    await expect(captureMotifFrameB64(otherArgs)).rejects.toThrow('__motifRender threw')
  })

  it('ages waiting background frames without letting an old batch monopolize foreground', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      const before = renderOrder.length
      setupDelayMs = 2500
      const running = captureMotifFrameB64({ ...args, motifId: 'age-running' })
      await vi.advanceTimersByTimeAsync(1)
      setupDelayMs = 0
      const lowA = captureMotifFrameB64({ ...args, motifId: 'age-low-a' }, 'age-low-a', false)
      const lowB = captureMotifFrameB64({ ...args, motifId: 'age-low-b' }, 'age-low-b', false)
      const highA = captureMotifFrameB64({ ...args, motifId: 'age-high-a' }, 'age-high-a', true)
      const highB = captureMotifFrameB64({ ...args, motifId: 'age-high-b' }, 'age-high-b', true)
      await vi.advanceTimersByTimeAsync(2501)
      await Promise.all([running, lowA, lowB, highA, highB])
      expect(renderOrder.slice(before)).toEqual(['age-running', 'age-low-a', 'age-high-a', 'age-low-b', 'age-high-b'])
    } finally { setupDelayMs = 0; vi.useRealTimers() }
  })

  it('refuses a capture queued past shutdown instead of reopening the host', async () => {
    const openedBefore = opened
    shutdownCaptureHost()
    await expect(captureMotifFrameB64(args)).rejects.toThrow(/shut down/)
    expect(opened).toBe(openedBefore)
  })
})
