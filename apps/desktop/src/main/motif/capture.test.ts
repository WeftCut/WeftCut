// `electron` can't load under Vitest, so `BrowserWindow` is stubbed down to what
// `buildHost` + `hardenWindow` touch, and the CDP `debugger` to canned replies.
// The fake's behavior flags let each test script the failure it needs (slow
// screenshot, wedged ready-probe); `opened`/`screenshotCalls` count the side
// effects under test.
import { describe, it, expect, vi } from 'vitest'

let opened = 0
let screenshotCalls = 0
/// The last `__motifRender(tSec, props, meta)` expression sent to the host —
/// the meta.fps assertions parse the third argument out of it.
let lastRenderExpr: string | null = null
/// Total __motifRender evaluations — the lane fast-reject test asserts a
/// same-lane capture never reaches the page.
let renderCalls = 0
/// The URL the fake host last loadURL'd — lets behavior flags key on which
/// motif page is "loaded" (lane tests) and which motif a screenshot served
/// (priority-order test).
let currentUrl = 'about:blank'
/// Motif ids in screenshot order — the priority test asserts a queued keyed
/// capture runs before a queued keyless one.
const shotOrder: string[] = []
/// Lanes (`motifId@contentHash`) whose __motifRender throws — a Motif's own
/// script raising, with the transport otherwise healthy.
const throwingLanes = new Set<string>()
/// Upcoming Page.captureScreenshot calls to slow down (occupies the queue).
let slowScreenshots = 0
/// When true, the waitReady probe (Runtime.evaluate of the __motifRender
/// typeof check) never settles — a wedged offscreen renderer.
let hangReadyProbe = false
let hungCommand: string | null = null

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/// `${motifId}@${contentHash}` of the page the fake host currently has loaded.
function currentLane(): string | null {
  const m = /motif:\/\/([^/]+)\/index\.html\?v=(.*)$/.exec(currentUrl)
  return m ? `${m[1]}@${decodeURIComponent(m[2]!)}` : null
}

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = {
      setZoomFactor: () => {},
      on: () => {},
      setWindowOpenHandler: () => {},
      debugger: {
        attach: () => {},
        detach: () => {},
        sendCommand: (method: string, params?: { expression?: string }) => {
          if (method === hungCommand) return new Promise(() => {})
          if (method === 'Page.captureScreenshot') {
            screenshotCalls++
            shotOrder.push(currentLane()?.split('@')[0] ?? currentUrl)
            if (slowScreenshots > 0) {
              slowScreenshots--
              return delay(250).then(() => ({ data: 'UE5H' }))
            }
            return Promise.resolve({ data: 'UE5H' })
          }
          if (method === 'Runtime.evaluate') {
            const expr = params?.expression ?? ''
            if (hangReadyProbe && expr.includes('typeof window.__motifRender')) {
              return new Promise(() => {})
            }
            if (expr.startsWith('window.__motifRender(')) {
              lastRenderExpr = expr
              renderCalls++
              // The Motif's own script throws; the CDP transport answers fine.
              if (throwingLanes.has(currentLane() ?? '')) {
                return Promise.resolve({ exceptionDetails: { text: 'boom' } })
              }
            }
            return Promise.resolve({ result: { value: true } })
          }
          return Promise.resolve({})
        },
      },
    }
    constructor() {
      opened++
    }
    loadURL = async (url: string): Promise<void> => { currentUrl = url }
    destroy = (): void => {}
  }
  return { BrowserWindow: FakeBrowserWindow, shell: { openExternal: async () => {} } }
})

const { captureMotifFrameB64, setRuntimeSource, setMotifStore, shutdownCaptureHost } = await import('./capture')
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
// duration, which is all doCapture needs to reach the screenshot.
const args = {
  motifId: 'not-a-builtin',
  tSec: 0,
  propsJson: '{}',
  width: 32,
  height: 16,
  settleRafs: null,
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

  it('supersedes a queued same-key request without executing it', async () => {
    // Occupy the chain with a slow keyless capture; queue two same-key
    // requests behind it. The newer must replace the older IMMEDIATELY, and
    // the older's chain slot must do no screenshot work when reached.
    slowScreenshots = 1
    const before = screenshotCalls
    const p0 = captureMotifFrameB64(args)
    const pA = captureMotifFrameB64(args, 'sprite:layer-1')
    const pB = captureMotifFrameB64(args, 'sprite:layer-1')
    await expect(pA).rejects.toThrow(/superseded by a newer request/)
    await expect(p0).resolves.toBe('UE5H')
    await expect(pB).resolves.toBe('UE5H')
    expect(screenshotCalls - before).toBe(2) // p0 + pB only — pA never executed
  })

  it('a keyed request that reaches the chain head runs (no self-supersede)', async () => {
    const before = screenshotCalls
    await expect(captureMotifFrameB64(args, 'sprite:layer-2')).resolves.toBe('UE5H')
    expect(screenshotCalls - before).toBe(1)
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
    // transport answer fine — the host must NOT be rebuilt, and a DIFFERENT
    // motif's next capture reuses it (no new window).
    throwingLanes.add('broken-motif@v1')
    const openedBefore = opened
    await expect(captureMotifFrameB64({ ...args, motifId: 'broken-motif', contentHash: 'v1' }))
      .rejects.toThrow(/__motifRender threw/)
    expect(opened).toBe(openedBefore)
    await expect(captureMotifFrameB64({ ...args, motifId: 'healthy-motif' })).resolves.toBe('UE5H')
    expect(opened).toBe(openedBefore)
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
    slowScreenshots = 1
    const orderBefore = shotOrder.length
    const p0 = captureMotifFrameB64({ ...args, motifId: 'low-first' })
    const p1 = captureMotifFrameB64({ ...args, motifId: 'low-second' })
    const p2 = captureMotifFrameB64({ ...args, motifId: 'high-sprite' }, 'sprite:prio')
    await expect(p0).resolves.toBe('UE5H')
    await expect(p1).resolves.toBe('UE5H')
    await expect(p2).resolves.toBe('UE5H')
    expect(shotOrder.slice(orderBefore)).toEqual(['low-first', 'high-sprite', 'low-second'])
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

  it('refuses a capture queued past shutdown instead of reopening the host', async () => {
    const openedBefore = opened
    shutdownCaptureHost()
    await expect(captureMotifFrameB64(args)).rejects.toThrow(/shut down/)
    expect(opened).toBe(openedBefore)
  })
})
