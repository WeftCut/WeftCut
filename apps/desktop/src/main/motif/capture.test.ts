// `electron` can't load under Vitest, so `BrowserWindow` is stubbed down to what
// `buildHost` + `hardenWindow` touch, and the CDP `debugger` to canned replies.
// The fake's behavior flags let each test script the failure it needs (slow
// screenshot, wedged ready-probe); `opened`/`screenshotCalls` count the side
// effects under test.
import { describe, it, expect, vi } from 'vitest'

let opened = 0
let screenshotCalls = 0
/// Upcoming Page.captureScreenshot calls to slow down (occupies the chain).
let slowScreenshots = 0
/// When true, the waitReady probe (Runtime.evaluate of the __motifRender
/// typeof check) never settles — a wedged offscreen renderer.
let hangReadyProbe = false

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
          if (method === 'Page.captureScreenshot') {
            screenshotCalls++
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
            return Promise.resolve({ result: { value: true } })
          }
          return Promise.resolve({})
        },
      },
    }
    constructor() {
      opened++
    }
    loadURL = async (): Promise<void> => {}
    destroy = (): void => {}
  }
  return { BrowserWindow: FakeBrowserWindow, shell: { openExternal: async () => {} } }
})

const { captureMotifFrameB64, setRuntimeSource, shutdownCaptureHost } = await import('./capture')

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

  it('a wedged waitReady probe times out and the next capture rebuilds the host', async () => {
    // A new motif id forces navigation + a fresh ready-probe. The wedged probe
    // must fail by TIMEOUT (bounded), tear the host down, and let the very
    // next capture rebuild and succeed — not hang the serial chain forever.
    hangReadyProbe = true
    const wedged = { ...args, motifId: 'wedged-motif' }
    await expect(captureMotifFrameB64(wedged)).rejects.toThrow(/timed out/)
    const openedAfterWedge = opened
    hangReadyProbe = false
    await expect(captureMotifFrameB64(wedged)).resolves.toBe('UE5H')
    expect(opened).toBe(openedAfterWedge + 1)
  }, 20_000)

  it('refuses a capture queued past shutdown instead of reopening the host', async () => {
    const openedBefore = opened
    shutdownCaptureHost()
    await expect(captureMotifFrameB64(args)).rejects.toThrow(/shut down/)
    expect(opened).toBe(openedBefore)
  })
})
