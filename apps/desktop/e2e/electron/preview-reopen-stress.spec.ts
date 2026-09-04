import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir } from './helpers/driver'

// The committed gate for ADR 0059 (a WebGPU device dies with its Application):
// with a live hardware-decode session, close and reopen the Preview Panel N
// times, and separately crash the GPU process, and assert the renderer never
// freezes — each close must release every session, each reopen must re-engage
// the HARDWARE lane rather than the sticky software fallback, and the app must
// close without hanging. Before ADR 0059 this froze the renderer main thread
// 30-45 s on Chromium 152 (Electron 44) whenever the closed Preview's WebGPU
// device died out of order.
//
// Lane per platform, like preview-hw-color / preview-hw-conformance: d3d11va on
// Windows (the shared-texture path where the freeze was first found),
// videotoolbox on macOS, nvdec/vaapi on Linux. Each leg pins its lane with
// WEFTCUT_FORCE_HW_LANE and SKIPS CLEANLY when that lane did not engage on this
// machine, so one spec covers every host with no per-machine config.
//
// LOCAL-ONLY, like the rest of the hardware-lane family: it needs a
// VITE_WEFTCUT_E2E=1 build, the native-decode addon, and a real HW-decode lane,
// none of which the hosted CI runners have — so it self-skips there behind
// WEFTCUT_DECODE_E2E. The gate runs on a shared-texture-capable Windows box or a
// videotoolbox Mac. CI at one worker never exercised the freeze; this spec and
// the four-worker export set on a real-GPU host are what guard the regression.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const H264 = path.resolve(MEDIA_DIR, 'test_1080p_h264.mp4')
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const REOPEN_ROUNDS = 8

type HwLane = 'nvdec' | 'vaapi' | 'd3d11va' | 'videotoolbox'

// Read HERE, not inside a test: launchApp spreads a spec's env last, so an
// operator's outer WEFTCUT_FORCE_HW_LANE (the skip-path audit seam the other
// hardware specs document) must be picked up before the app launches.
const OUTER_LANE_PIN = process.env.WEFTCUT_FORCE_HW_LANE as HwLane | undefined

// Only the host's own lanes, because a leg costs a full app launch even when it
// ends in a clean skip. The three desktop platforms are exhaustive, so `?? []`
// is unreachable rather than a silent hole.
const PLATFORM_LANES: Partial<Record<NodeJS.Platform, readonly HwLane[]>> = {
  win32: ['d3d11va'],
  darwin: ['videotoolbox'],
  linux: ['nvdec', 'vaapi'],
}
const LANES: readonly HwLane[] = OUTER_LANE_PIN ? [OUTER_LANE_PIN] : (PLATFORM_LANES[process.platform] ?? [])

interface Probe {
  sourceKind: string
  hwLane: string | null
  ringLastPtsUs: number | null
  ringSize: number
  spriteBound: boolean
}
interface Budget {
  sessions: { used: number; max: number }
  codedPixelArea: { used: number; max: number }
  slotVram?: { usedBytes: number }
}

const probe = (page: Page, layerId: string): Promise<Probe | null> =>
  page.evaluate((id) => {
    try {
      return (window as unknown as { __weftcutTest: { activeClipProbe(id: string): Probe } }).__weftcutTest.activeClipProbe(id)
    } catch {
      return null
    }
  }, layerId)

const budget = (page: Page): Promise<Budget> =>
  page.evaluate(() => (window as unknown as { api: { previewGpu: { budget(): Budget } } }).api.previewGpu.budget())

const resourceGen = (page: Page): Promise<unknown> =>
  page.evaluate(() => (window as unknown as { __weftcutTest?: { previewResourceProbe?: () => { generation: unknown } | undefined } }).__weftcutTest?.previewResourceProbe?.()?.generation ?? null)

const seek = (page: Page, us: number) =>
  page.evaluate((t) => (window as unknown as { __weftcutTest: { weftcutSeekUs(t: number): unknown } }).__weftcutTest.weftcutSeekUs(t), us)

const previewPanel = (page: Page) => page.locator('.weft-dock-panel[data-panel-kind="preview"]')

async function closePreviewPanel(page: Page): Promise<void> {
  const viewMenu = page.locator('.menu-trigger').nth(2)
  await viewMenu.click()
  await page.locator('.app-menu-item').filter({ hasText: /^Preview$/ }).click()
  await viewMenu.click()
  await page.locator('.app-menu-item').filter({ hasText: /Close Active Panel|关闭活动面板/ }).click()
  await expect(previewPanel(page)).toHaveCount(0)
}

async function openPreviewPanel(page: Page): Promise<void> {
  const viewMenu = page.locator('.menu-trigger').nth(2)
  await viewMenu.click()
  await page.locator('.app-menu-item').filter({ hasText: /^Preview$/ }).click()
  await expect(previewPanel(page)).toHaveCount(1)
}

/// Seek into the clip and wait until the HARDWARE lane has bound the seeked frame.
/// Every renderer round-trip is timed: a single call taking seconds is a frozen
/// renderer main thread, which is the ADR-0059 regression, distinct from an
/// empty ring. Returns the bound probe.
async function expectHardwareBound(
  page: Page,
  layerId: string,
  lane: HwLane,
  targetUs: number,
  timeout: number,
  where: string,
): Promise<Probe> {
  await expect
    .poll(() => resourceGen(page), { timeout: 30_000, message: `${where}: preview bridge never registered` })
    .not.toBeNull()
  await seek(page, targetUs)
  let worstMs = 0
  let last = ''
  const t0 = Date.now()
  await expect
    .poll(
      async () => {
        // A seek issued while the new preview's transport is still opening is
        // dropped silently (reference_e2e_transport_seek_readiness): re-issue it
        // on every poll until the frame is bound.
        const c0 = Date.now()
        await seek(page, targetUs).catch(() => {})
        const p = await probe(page, layerId)
        const took = Date.now() - c0
        if (took > worstMs) worstMs = took
        if (took > 3_000) console.log(`[reopen-stress] ${where}: renderer round-trip took ${took} ms at t+${Date.now() - t0} ms — main thread frozen`)
        if (!p) return (last = 'no-probe')
        if (p.sourceKind !== 'native-gpu') return (last = `lane=${p.sourceKind}/${p.hwLane}`)
        if (!p.spriteBound || p.ringLastPtsUs === null || p.ringLastPtsUs < targetUs) return (last = `ring=${p.ringLastPtsUs} size=${p.ringSize} bound=${p.spriteBound}`)
        return (last = 'ok')
      },
      { timeout, message: `${where}: hardware lane never bound the seeked frame (last=${last}, worst renderer round-trip ${worstMs} ms)` },
    )
    .toBe('ok')
  if (worstMs > 3_000) console.log(`[reopen-stress] ${where}: bound OK but worst renderer round-trip was ${worstMs} ms`)
  const p = (await probe(page, layerId))!
  expect(p.hwLane, `${where}: lane`).toBe(lane)
  return p
}

/// Play for `ms` and require the ring's newest PTS to advance.
async function expectFramesAdvance(page: Page, layerId: string, ms: number, where: string) {
  const before = (await probe(page, layerId))?.ringLastPtsUs ?? -1
  await page.evaluate(() => (window as unknown as { __weftcutTest: { transportPlay(): void } }).__weftcutTest.transportPlay())
  await page.waitForTimeout(ms)
  await page.evaluate(() => (window as unknown as { __weftcutTest: { transportPause(): void } }).__weftcutTest.transportPause())
  const after = (await probe(page, layerId))?.ringLastPtsUs ?? -1
  expect(after, `${where}: frames did not advance during playback (before=${before} after=${after})`).toBeGreaterThan(before)
  return { before, after }
}

async function closeWithin(app: ElectronApplication, ms: number, where: string) {
  const t0 = Date.now()
  const outcome = await Promise.race([
    app.close().then(() => 'closed' as const),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms)),
  ])
  expect(outcome, `${where}: app.close() did not settle within ${ms} ms`).toBe('closed')
  return Date.now() - t0
}

interface Harness {
  app: ElectronApplication
  page: Page
  layerId: string
  rendererErrors: string[]
  engaged: boolean
}

/// Launch, place the fixture on the given lane, and bind the first frame — or
/// report `engaged: false` when the lane did not come up on this machine, so the
/// caller can skip cleanly (preview-hw-conformance model) rather than fail.
async function setupHardwareSession(lane: HwLane, where: string): Promise<Harness> {
  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: lane } })
  const rendererErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') rendererErrors.push(`[${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => rendererErrors.push(`[pageerror] ${String(e)}`))

  await newProject(page, { parentFolder: tmpDir('weftcut-reopen-stress-'), name: `reopen-${lane}-${Date.now()}`, canvas: CANVAS })
  const after = (await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'ffmpeg' } })) as { decode_engine: string }
  expect(after.decode_engine).toBe('ffmpeg')
  const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: H264 })
  expect(kind).toBe('Video')

  // Clean-skip when the pinned lane did not engage: probe once, and only assert
  // the reopen invariants when the hardware path is actually live.
  await expect
    .poll(() => resourceGen(page), { timeout: 30_000, message: `${where}: preview bridge never registered` })
    .not.toBeNull()
  await seek(page, 500_000)
  let p: Probe | null = null
  await expect
    .poll(async () => {
      await seek(page, 500_000).catch(() => {})
      p = await probe(page, layerId)
      return p?.sourceKind ?? 'no-probe'
    }, { timeout: 30_000 })
    .not.toBe('no-probe')
  const engaged = p !== null && (p as Probe).sourceKind === 'native-gpu' && (p as Probe).hwLane === lane
  return { app, page, layerId, rendererErrors, engaged }
}

test.describe('Preview reopen + GPU-crash stress on the hardware lane (ADR 0059)', () => {
  test.skip(process.env.WEFTCUT_DECODE_E2E !== '1', 'needs the native-decode component (WEFTCUT_DECODE_E2E=1)')
  test.skip(!existsSync(H264), `fixture missing: ${H264}`)

  for (const lane of LANES) {
    const transport = lane === 'd3d11va' ? 'shared-texture' : 'copy-back'

    test(`reopen stress: ${REOPEN_ROUNDS}× close/reopen Preview with a live ${lane} ${transport} session @serial`, async () => {
      test.setTimeout(300_000)
      const h = await setupHardwareSession(lane, 'reopen')
      const { app, page, layerId } = h
      test.skip(!h.engaged, `${lane} did not engage on this machine — lane unavailable`)
      const rounds: string[] = []
      try {
        let gen = await resourceGen(page)
        for (let i = 1; i <= REOPEN_ROUNDS; i++) {
          const t0 = Date.now()
          await closePreviewPanel(page)
          await expect.poll(() => resourceGen(page), { timeout: 15_000 }).toBeNull()
          // Every hardware session (and its persistent imports) must be gone.
          await expect
            .poll(async () => (await budget(page)).sessions.used, { timeout: 15_000, message: `round ${i}: sessions not released after close` })
            .toBe(0)
          const bClosed = await budget(page)
          expect(bClosed.codedPixelArea.used, `round ${i}: coded-area reservation leaked`).toBe(0)
          if (bClosed.slotVram) expect(bClosed.slotVram.usedBytes, `round ${i}: slot VRAM accounting leaked`).toBe(0)

          await openPreviewPanel(page)
          await expect.poll(() => resourceGen(page), { timeout: 30_000 }).not.toBe(gen)
          gen = await resourceGen(page)
          // Stay well inside the fixture: a target past the media end can never bind.
          const target = 300_000 + i * 100_000
          const p = await expectHardwareBound(page, layerId, lane, target, 45_000, `round ${i}`)
          const bOpen = await budget(page)
          rounds.push(`round ${i}: ${Date.now() - t0} ms, lane=${p.hwLane} ring=${p.ringSize} sessions=${bOpen.sessions.used}/${bOpen.sessions.max}`)
        }
        await expectFramesAdvance(page, layerId, 2_000, 'after reopen stress')
      } finally {
        for (const r of rounds) console.log('[reopen-stress] ' + r)
        const closeMs = await closeWithin(app, 30_000, 'reopen stress')
        console.log(`[reopen-stress] app.close() settled in ${closeMs} ms`)
      }
      expect(h.rendererErrors.filter((l) => l.startsWith('[pageerror]')), 'uncaught renderer exceptions').toEqual([])
    })

    test(`GPU-process crash under a live ${lane} session: app survives, Preview reopen recovers the lane @serial`, async () => {
      test.setTimeout(300_000)
      const h = await setupHardwareSession(lane, 'gpucrash')
      const { app, page, layerId } = h
      test.skip(!h.engaged, `${lane} did not engage on this machine — lane unavailable`)
      try {
        await expectFramesAdvance(page, layerId, 1_000, 'before crash')

        // Crash the GPU process from a hidden window; observe child-process-gone.
        const gone = (await app.evaluate(
          ({ app, BrowserWindow }) =>
            new Promise<{ type: string; reason?: string; exitCode?: number }>((resolve) => {
              const timer = setTimeout(() => {
                app.removeListener('child-process-gone', onGone)
                resolve({ type: 'timeout' })
              }, 12_000)
              const onGone = (_e: unknown, d: { type: string; reason: string; exitCode: number }) => {
                if (d.type !== 'GPU') return
                clearTimeout(timer)
                app.removeListener('child-process-gone', onGone)
                resolve({ type: d.type, reason: d.reason, exitCode: d.exitCode })
              }
              app.on('child-process-gone', onGone)
              const win = new BrowserWindow({ show: false })
              win.loadURL('chrome://gpucrash').catch(() => {})
              setTimeout(() => {
                try {
                  if (!win.isDestroyed()) win.destroy()
                } catch {
                  /* already gone */
                }
              }, 11_000)
            }),
        )) as { type: string; reason?: string; exitCode?: number }
        console.log('[reopen-stress] child-process-gone:', JSON.stringify(gone))
        const crashed = gone.type === 'GPU'
        if (!crashed) test.info().annotations.push({ type: 'note', description: 'chrome://gpucrash did not produce a GPU child-process-gone event' })

        // The app must be alive on both sides.
        expect(await page.evaluate(() => 1 + 1)).toBe(2)
        expect(await app.evaluate(() => typeof process.pid)).toBe('number')
        await page.waitForTimeout(2_000)

        // User-level recovery: close + reopen Preview, then the hardware lane
        // must come back on the NEW GPU process and frames must flow.
        await closePreviewPanel(page)
        await expect
          .poll(async () => (await budget(page)).sessions.used, { timeout: 20_000, message: 'sessions not released after post-crash close' })
          .toBe(0)
        await openPreviewPanel(page)
        await expectHardwareBound(page, layerId, lane, 900_000, 60_000, 'post-crash reopen')
        const adv = await expectFramesAdvance(page, layerId, 2_000, 'post-crash playback')
        console.log(`[reopen-stress] post-crash playback advanced ${adv.before} → ${adv.after}`)
        expect(crashed, 'the GPU process was not actually crashed — this run did not test context loss').toBe(true)
      } finally {
        const closeMs = await closeWithin(app, 30_000, 'gpucrash')
        console.log(`[reopen-stress] app.close() settled in ${closeMs} ms`)
      }
    })
  }
})
