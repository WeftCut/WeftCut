import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { createHash } from 'node:crypto'
import type { E2EHook } from '../../src/renderer/testhook/e2eHook'
import { launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'

declare global {
  interface Window { __previewRecoveryCaptureBlocked?: boolean }
}

const probe = (page: Page) => page.evaluate(() =>
  (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.previewResourceProbe())

// Compare authored content independent of CSS canvas size. Averaging accent
// coverage in a small grid tolerates display resampling while distinguishing
// the actual numeral/arc at the requested time from any earlier valid frame.
function accentGrid(png: PNG): number[] {
  const grid = Array<number>(24 * 24).fill(0)
  const counts = Array<number>(24 * 24).fill(0)
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const cell = Math.floor(y * 24 / png.height) * 24 + Math.floor(x * 24 / png.width)
      const i = (y * png.width + x) * 4
      counts[cell]++
      if (png.data[i]! > 180 && png.data[i + 1]! < 150 && png.data[i + 2]! < 150 && png.data[i + 3]! > 128) grid[cell]++
    }
  }
  return grid.map((value, i) => value / counts[i]!)
}

// Read the actually presented canvas via Chromium, with no forced Pixi render
// or composite. A dead ticker cannot be repaired by the assertion itself.
async function picture(page: Page) {
  const bytes = await page.locator('canvas.pixi-preview-canvas').screenshot({ timeout: 5_000 })
  const png = PNG.sync.read(bytes)
  let accent = 0
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i]! > 180 && png.data[i + 1]! < 150 && png.data[i + 2]! < 150) accent++
  }
  return { accent, hash: createHash('sha256').update(png.data).digest('hex'), grid: accentGrid(png), bytes }
}

async function setup(page: Page) {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-recovery-project-'), name: 'Recovery',
    canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
  })
  await waitForHook(page, 'previewRecovery')
}

test('@serial motif preview survives LRU eviction, GPU unload and a failed present', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    await setup(page)
    await page.evaluate(async () => {
      const hook = (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest
      // Sibling sprites must keep their shared canonical bitmap alive.
      await hook.motifAddCountdown()
      await hook.motifAddCountdown()
    })
    await expect.poll(() => probe(page), { timeout: 30_000 }).not.toBeNull()
    await expect.poll(async () => (await picture(page)).accent, { timeout: 30_000 }).toBeGreaterThan(200)
    const baseline = await picture(page)
    const gpu = await app.evaluate(async ({ app }) => ({
      status: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic'),
    }))
    await testInfo.attach('gpu.json', { body: JSON.stringify(gpu, null, 2), contentType: 'application/json' })

    for (let round = 0; round < 3; round++) {
      const before = (await probe(page))!
      const pressure = await page.evaluate(() =>
        (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.previewRecovery('evict-and-unload'))
      console.log('[preview-recovery] pressure', round, pressure)
      expect(pressure.sources).toBe(2)
      expect(pressure.liveBitmaps).toBe(1)
      await expect.poll(async () => (await probe(page))!.ownerCompositeCount).toBeGreaterThan(before.ownerCompositeCount + 3)
      await expect.poll(async () => (await picture(page)).hash).toBe(baseline.hash)
    }
    expect(errors).toEqual([])

    // A real low-priority ticker callback consumes the injected exception.
    await page.evaluate(() => {
      const hook = (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest
      hook.transportPlay()
      return hook.previewRecovery('throw-next-present')
    })
    await expect.poll(async () => (await probe(page))!.positionUs).toBeGreaterThan(500_000)
    await expect.poll(() => errors.filter((error) => error.includes('[e2e] one failed preview present')).length).toBe(1)
    await page.evaluate(() => (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.transportPause())
    const paused = (await probe(page))!
    await page.waitForTimeout(200)
    expect((await probe(page))!.positionUs).toBe(paused.positionUs)
    await page.evaluate(() => (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.transportPlay())
    await expect.poll(async () => (await probe(page))!.positionUs).toBeGreaterThan(paused.positionUs + 500_000)
    await page.evaluate(() => {
      const hook = (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest
      hook.transportPause()
      hook.weftcutSeekUs(2_500_000)
    })
    const reference = await page.evaluate(() =>
      (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.captureMotifFrame({
        motifId: 'countdown', tSec: 2.5, props: { seconds: 5, accent: '#ff4d4d' }, width: 480, height: 480,
      }))
    const expected = accentGrid(PNG.sync.read(Buffer.from(reference, 'base64')))
    const distance = (grid: number[]) => grid.reduce((sum, value, i) => sum + Math.abs(value - expected[i]!), 0) / grid.length
    expect(distance(baseline.grid), 'reference must distinguish the initial frame').toBeGreaterThan(0.04)
    await expect.poll(async () => distance((await picture(page)).grid), { timeout: 20_000 }).toBeLessThan(0.025)
    expect(errors.filter((error) => !error.includes('[e2e] one failed preview present'))).toEqual([])
    await testInfo.attach('recovered-preview.png', { body: (await picture(page)).bytes, contentType: 'image/png' })
  } finally {
    await app.close()
  }
})

test('@serial paused motif recovers after a real capture decode rejection without seeking', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  const failures: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('MotifSprite')) failures.push(message.text())
  })
  try {
    await setup(page)
    await page.evaluate(() => {
      // Reject the real producer's PNG decode after the CDP capture returns.
      // This also blocks the prewarmer, so it cannot hide the initial failure.
      const decode = window.createImageBitmap.bind(window)
      window.__previewRecoveryCaptureBlocked = true
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        if (window.__previewRecoveryCaptureBlocked && args[0] instanceof Blob && args[0].type === 'image/png') {
          return Promise.reject(new Error('[e2e] temporary PNG decode failure'))
        }
        return Reflect.apply(decode, window, args)
      }) as typeof createImageBitmap
    })
    await page.evaluate(() => (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.motifAddCountdown())
    await expect.poll(() => probe(page), { timeout: 30_000 }).not.toBeNull()
    // Keep the outage past the first two retries. A finite three-attempt budget
    // would strand this paused target after the producer becomes healthy.
    await expect.poll(() => failures.length, { timeout: 30_000, intervals: [25] }).toBe(3)
    expect((await picture(page)).accent).toBe(0)
    await page.evaluate(() => { window.__previewRecoveryCaptureBlocked = false })
    await expect.poll(async () => (await picture(page)).accent, { timeout: 20_000 }).toBeGreaterThan(200)
    const recovered = (await probe(page))!
    expect(recovered.positionUs).toBe(0)
    expect(recovered.playing).toBe(false)
    expect(pageErrors).toEqual([])
    expect(failures.every((failure) => failure.includes('[e2e] temporary PNG decode failure'))).toBe(true)
    await testInfo.attach('paused-recovered-preview.png', { body: (await picture(page)).bytes, contentType: 'image/png' })
  } finally {
    await app.close()
  }
})
