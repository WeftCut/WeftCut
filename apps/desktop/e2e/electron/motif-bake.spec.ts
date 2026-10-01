import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import { supportsMotifSharedTextures } from './helpers/motif-gpu'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))

for (const missingFrame of [null, 7] as const) {
test(`Motif pre-bake survives a cold app restart and captures only missing frames (${missingFrame ?? 'complete'}) @serial`, async () => {
  test.setTimeout(120_000)
  const userDataDir = tmpDir('weftcut-bake-reopen-user-')
  let running = await launchApp({ userDataDir, env: { WEFTCUT_MOTIF_CAPTURE: 'png' } })
  try {
    await newProject(running.page, {
      parentFolder: tmpDir('weftcut-bake-reopen-project-'), name: 'persistent-bake',
      canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(running.page, 'app_settings_set', { patch: { prebake_motifs: true } })
    await waitForHook(running.page, 'prebakeLayerAndWait')
    const layerId = await running.page.evaluate(() => (window as any).__weftcutTest.addMotifLayer({
      motifId: 'countdown', durationUs: 1_000_000, props: { seconds: 1 },
    })) as string
    const baked = await running.page.evaluate(layerId =>
      (window as any).__weftcutTest.prebakeLayerAndWait({ layerId, expectedFrames: 30 }), layerId,
    ) as { hashDir: string }
    const projectPath = await invokeCmd<string>(running.page, 'workspace_dir')
    const stamps = await Promise.all(Array.from({ length: 30 }, (_, f) =>
      fs.stat(path.join(baked.hashDir, `${f}.wfrm`)).then(s => s.mtimeMs),
    ))
    await running.app.close()
    if (missingFrame !== null) await fs.unlink(path.join(baked.hashDir, `${missingFrame}.wfrm`))
    running = await launchApp({ userDataDir, env: { WEFTCUT_MOTIF_CAPTURE: 'png' } })
    await waitForHook(running.page, 'motifReopenProject')
    await running.page.evaluate(() => { (window as any).__weftcutMotifPerf = { renders: 0 } })
    await running.page.evaluate(path => (window as any).__weftcutTest.motifReopenProject({ path }), projectPath)
    await waitForHook(running.page, 'weftcutSampleComposite')
    await expect.poll(() => running.page.evaluate(async () => {
      try { await (window as any).__weftcutTest.weftcutSampleComposite(240, 240); return true }
      catch { return false }
    }), { timeout: 15_000 }).toBe(true)
    await waitForHook(running.page, 'renderMotifSpriteFrames')
    // Exercise the real reader for every frame with a new renderer/L0 cache.
    await running.page.evaluate(async () => {
      await (window as any).__weftcutTest.renderMotifSpriteFrames({
        motifId: 'countdown', fpsNum: 30, fpsDen: 1, durationUs: 1_000_000, props: { seconds: 1 },
        times: Array.from({ length: 30 }, (_, i) => ({ tInLayerUs: Math.round(i * 1_000_000 / 30) })),
      })
    })
    await running.page.evaluate(layerId =>
      (window as any).__weftcutTest.prebakeLayerAndWait({ layerId, expectedFrames: 30 }), layerId)
    expect(await running.page.evaluate(() => (window as any).__weftcutMotifPerf.renders)).toBe(missingFrame === null ? 0 : 1)
    const after = await Promise.all(Array.from({ length: 30 }, (_, f) =>
      fs.stat(path.join(baked.hashDir, `${f}.wfrm`)).then(s => s.mtimeMs),
    ))
    for (let f = 0; f < 30; f++) {
      if (f !== missingFrame) expect(after[f]).toBe(stamps[f])
    }
  } finally { await running.app.close() }
})
}

for (const mode of ['native', 'png', 'readback-failure', 'warm-cache'] as const) {
  test(`Motif bake persists readable transparent frames (${mode}) @serial`, async () => {
    const needsGpu = mode === 'native' || mode === 'readback-failure'
    test.skip(needsGpu && process.platform !== 'win32', 'D3D11 capture is Windows-only')
    test.setTimeout(120_000)
    const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: needsGpu ? 'texture' : 'png' } })
    try {
      if (needsGpu) {
        test.skip(!await supportsMotifSharedTextures(app), 'Chromium cannot share D3D textures; PNG compatibility cases still run')
        const available = await app.evaluate((_electron, addon) => {
          const native = process.getBuiltinModule('module').createRequire(addon)(addon)
          try { const encoder = new native.MotifTextureEncoder(); encoder.close(); return true }
          catch { return false }
        }, addon)
        test.skip(!available, 'No D3D11 hardware device; PNG compatibility cases still run')
      }
      await app.evaluate((_electron, { addon, mode }) => {
        const native = process.getBuiltinModule('module').createRequire(addon)(addon)
        const stats = { native: 0, png: 0 }
        ;(globalThis as any).__motifBakeStats = stats
        const encodePng = native.motifEncodePng
        native.motifEncodePng = (...args: any[]) => { stats.png++; return encodePng(...args) }
        if (native.MotifTextureEncoder) {
          const encode = native.MotifTextureEncoder.prototype.encode
          native.MotifTextureEncoder.prototype.encode = function (...args: any[]) {
            stats.native++
            if (mode === 'readback-failure') return Promise.reject(new Error('injected readback failure'))
            return encode.apply(this, args)
          }
        }
      }, { addon, mode })
      await newProject(page, {
        parentFolder: tmpDir('weftcut-bake-'), name: `bake-${mode}`,
        canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
      })
      await waitForHook(page, 'prebakeLayerAndWait')
      await page.evaluate(() => { (window as any).__weftcutMotifPerf = { renders: 0 } })
      const layerId = await page.evaluate(() => (window as any).__weftcutTest.addMotifLayer({
        motifId: 'countdown', durationUs: 1_000_000, props: { seconds: 1 },
      })) as string
      await expect.poll(() => page.evaluate(async () => {
        try { await (window as any).__weftcutTest.weftcutSampleComposite(240, 240); return true }
        catch (error) { return String(error) }
      }), { timeout: 15_000, intervals: [25] }).toBe(true)
      if (mode === 'warm-cache') {
        await page.evaluate(async () => {
          await (window as any).__weftcutTest.renderMotifSpriteFrames({
            motifId: 'countdown', fpsNum: 30, fpsDen: 1, durationUs: 1_000_000, props: { seconds: 1 },
            times: Array.from({ length: 30 }, (_, i) => ({ tInLayerUs: Math.round(i * 1_000_000 / 30) })),
          })
        })
      }
      const beforeBake = await page.evaluate(() => (window as any).__weftcutMotifPerf.renders)
      const baked = await page.evaluate(async layerId => {
        const hook = (window as any).__weftcutTest
        return hook.prebakeLayerAndWait({ layerId, expectedFrames: 30 })
      }, layerId) as { hashDir: string; frameCount: number }
      const files = await fs.readdir(baked.hashDir)
      expect(files.filter(f => f.endsWith('.wfrm'))).toHaveLength(30)
      expect(files.some(f => f.endsWith('.png'))).toBe(false)
      const decoded = await app.evaluate(async (_electron, { addon, file }) => {
        const native = process.getBuiltinModule('module').createRequire(addon)(addon)
        const { width, height, rgba } = await native.motifReadFrame(file)
        let clear = 0, visible = 0, partial = 0
        for (let i = 3; i < rgba.length; i += 4) {
          if (rgba[i] === 0) clear++
          else { visible++; if (rgba[i] < 255) partial++ }
        }
        return { width, height, clear, visible, partial, stats: (globalThis as any).__motifBakeStats }
      }, { addon, file: path.join(baked.hashDir, '0.wfrm') })
      expect(decoded).toMatchObject({ width: 480, height: 480 })
      expect(decoded.clear).toBeGreaterThan(100_000)
      expect(decoded.visible).toBeGreaterThan(100)
      expect(decoded.partial).toBeGreaterThan(0)
      if (mode === 'native') {
        expect(decoded.stats.native).toBeGreaterThan(0)
        expect(decoded.stats.native + decoded.stats.png).toBe(30)
      } else {
        expect(decoded.stats.native).toBe(mode === 'readback-failure' ? 1 : 0)
        expect(decoded.stats.png).toBe(30)
      }
      if (mode === 'warm-cache') {
        expect(await page.evaluate(() => (window as any).__weftcutMotifPerf.renders)).toBe(beforeBake)
      }
      console.log(`[motif-bake:${mode}] ${JSON.stringify(decoded.stats)}`)
    } finally { await app.close() }
  })
}
