import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import { supportsMotifSharedTextures } from './helpers/motif-gpu'
import { createMotifDraft, publishMotifDraft } from './helpers/motif'
import type { MotifBakeSnapshot } from '../../src/shared/motifs/baking'
import { hashCacheKey } from '../../src/shared/motifs/cacheKey'

interface CaptureDiagnostics {
  captures: number;
  pageLoads: number;
  lanes: { motifId: string; contentHash: string; captures: number; pageLoads: number }[];
}
const capturesFor = (stats: CaptureDiagnostics, motifId: string) => stats.lanes.filter(lane => lane.motifId === motifId).reduce((n, lane) => n + lane.captures, 0)

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))

test('Pre-bake now moves a clip ahead of unfinished background work @serial', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: 'png' } })
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-bake-order-'), name: 'Ordered preparation',
      canvas: { width: 64, height: 64, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: false } })
    const layers: { layerId: string; key: string }[] = []
    for (let i = 0; i < 3; i++) {
      const draft = await createMotifDraft(page, { id: `ordered-${i}`, name: `Ordered ${i}`, version: 1,
        size: [64, 64], default_duration_s: 2, props_schema: {} },
        `<!doctype html><body><script>motif.define({frame(t){document.body.style.background='rgb(${50+i*50},'+Math.floor(t*60)+',100)'}})</script>`)
      const motifId = await publishMotifDraft(page, draft)
      const layerId = await page.evaluate(motifId => (window as any).__weftcutTest.addMotifLayer({ motifId, durationUs: 2_000_000 }), motifId)
      const key = await page.evaluate(id => (window as any).__weftcutTest.cacheKeyForLayer(id), layerId)
      layers.push({ layerId, key })
    }
    await app.evaluate((_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const original = native.motifEncodePng
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const state = { calls: 0, held: false, release: () => { native.motifEncodePng = original; release() } }
      ;(globalThis as any).__bakeOrderGate = state
      native.motifEncodePng = async (...args: any[]) => {
        if (++state.calls === 4) { state.held = true; await gate }
        return original(...args)
      }
    }, addon)
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: true } })
    await expect.poll(() => app.evaluate(() => (globalThis as any).__bakeOrderGate.held), { timeout: 30_000 }).toBe(true)
    const read = () => invokeCmd<MotifBakeSnapshot>(page, 'motif_bake_snapshot')
    const before = await read()
    const active = layers.find(l => before.statuses[l.key]?.done > 0)!
    const target = layers.findLast(l => before.statuses[l.key]?.done === 0)!
    expect(active).toBeTruthy(); expect(target).toBeTruthy()
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), target.layerId)
    const block = page.locator(`[data-layer-id="${target.layerId}"]`)
    await block.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pre-bake now', exact: true }).click()
    await app.evaluate(() => (globalThis as any).__bakeOrderGate.release())
    await expect.poll(async () => (await read()).statuses[target.key]?.phase, { timeout: 40_000 }).toBe('ready')
    const promoted = await read()
    expect(promoted.statuses[active.key]!.done).toBeLessThan(60)
    expect(promoted.statuses[active.key]!.done).toBeGreaterThanOrEqual(before.statuses[active.key]!.done)
    await expect.poll(async () => Object.values((await read()).statuses).every(s => s.phase === 'ready'), { timeout: 60_000 }).toBe(true)
  } finally {
    await app.evaluate(() => (globalThis as any).__bakeOrderGate?.release()).catch(() => {})
    await app.close()
  }
})

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
    const key = await running.page.evaluate(layerId => (window as any).__weftcutTest.cacheKeyForLayer(layerId), layerId) as string
    await expect.poll(async () => (await invokeCmd<MotifBakeSnapshot>(running.page, 'motif_bake_snapshot')).statuses[key]?.phase,
      { timeout: 30_000 }).toBe('ready')
    const projectPath = await invokeCmd<string>(running.page, 'workspace_dir')
    const baked = { hashDir: path.join(projectPath, 'Cache', 'raster', hashCacheKey(key)) }
    const stamps = await Promise.all(Array.from({ length: 30 }, (_, f) =>
      fs.stat(path.join(baked.hashDir, `${f}.wfrm`)).then(s => s.mtimeMs),
    ))
    await running.app.close()
    if (missingFrame !== null) await fs.unlink(path.join(baked.hashDir, `${missingFrame}.wfrm`))
    running = await launchApp({ userDataDir, env: { WEFTCUT_MOTIF_CAPTURE: 'png' } })
    await waitForHook(running.page, 'motifReopenProject')
    await invokeCmd(running.page, 'motif_capture_diagnostics', { reset: true })
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
    // Observe automatic recovery, without a manual pre-bake that could conceal
    // a broken startup declaration. Seeking must retain persisted completion.
    await expect.poll(async () => (await invokeCmd<MotifBakeSnapshot>(running.page, 'motif_bake_snapshot')).statuses[key]?.phase,
      { timeout: 30_000 }).toBe('ready')
    await running.page.evaluate(layerId => (window as any).__weftcutTest.revealLayer({ layerId }), layerId)
    // The one-second fixture is too narrow for the status dot at default zoom.
    await running.page.locator(`[data-layer-id="${layerId}"]`).hover()
    await running.page.keyboard.down('Control')
    await running.page.mouse.wheel(0, -1200)
    await running.page.keyboard.up('Control')
    // Replay a renderer miss whose reply arrives after background persistence
    // completed. Main must recheck the committed address, not capture again
    // merely because there is no longer an in-flight background receipt.
    await running.app.evaluate(({ ipcMain }, hash) => {
      const read = ipcMain._invokeHandlers.get('motif:read')!
      ;(globalThis as any).__staleMotifMissDelivered = false
      ipcMain._invokeHandlers.set('motif:read', (event: any, args: any) => {
        if (args.hash === hash && args.frame === 0 && !(globalThis as any).__staleMotifMissDelivered) {
          ;(globalThis as any).__staleMotifMissDelivered = true
          return null
        }
        return read(event, args)
      })
    }, hashCacheKey(key))
    await running.page.evaluate(async key => {
      const hook = (window as any).__weftcutTest
      hook.clearMotifCacheKey(key)
      await hook.renderMotifSpriteFrames({
        motifId: 'countdown', fpsNum: 30, fpsDen: 1, durationUs: 1_000_000, props: { seconds: 1 },
        times: [{ tInLayerUs: 0 }],
      })
    }, key)
    const dot = running.page.locator(`[data-layer-id="${layerId}"] .motif-bake-dot`)
    for (const us of [900_000, 100_000, 700_000, 0]) {
      await running.page.evaluate(({ key, us }) => {
        const h = (window as any).__weftcutTest
        h.clearMotifCacheKey(key)
        h.weftcutSeekUs(us)
      }, { key, us })
      await expect(dot).toHaveAttribute('title', 'Pre-baked')
      await running.page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(240, 240))
    }
    expect(await running.app.evaluate(() => (globalThis as any).__staleMotifMissDelivered)).toBe(true)
    const diagnostics = await invokeCmd<CaptureDiagnostics>(running.page, 'motif_capture_diagnostics')
    expect(capturesFor(diagnostics, 'countdown')).toBe(missingFrame === null ? 0 : 1)
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
      await invokeCmd(page, 'motif_capture_diagnostics', { reset: true })
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
      const beforeBake = capturesFor(await invokeCmd<CaptureDiagnostics>(page, 'motif_capture_diagnostics'), 'countdown')
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
        // Renderer L0 is display-owned. A main-owned bake persists directly
        // without requesting ImageBitmaps back across IPC from that cache.
        const backgroundCaptures = capturesFor(await invokeCmd<CaptureDiagnostics>(page, 'motif_capture_diagnostics'), 'countdown') - beforeBake
        expect(backgroundCaptures).toBeGreaterThan(0)
        expect(backgroundCaptures).toBeLessThanOrEqual(30)
      }
      console.log(`[motif-bake:${mode}] ${JSON.stringify(decoded.stats)}`)
    } finally { await app.close() }
  })
}

test('Motif background work survives renderer reload and reuses pages across multiple contents @serial', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: 'png' } })
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-bake-many-'), name: 'Many contents',
      canvas: { width: 64, height: 64, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: false } })
    const layers: { layerId: string; motifId: string; cacheKey: string }[] = []
    for (let i = 0; i < 4; i++) {
      const draft = await createMotifDraft(page, {
        id: `affinity-${i}`, name: `Affinity ${i}`, version: 1,
        size: [64, 64], default_duration_s: 2, props_schema: {},
      }, `<!doctype html><html><body style="margin:0"><script>
        motif.define({ frame(t) { document.body.style.background = 'rgb(${40 + i * 40},' + Math.floor(t * 60) + ',180)'; }});
      </script></body></html>`)
      const motifId = await publishMotifDraft(page, draft)
      const layerId = await page.evaluate(motifId => (window as any).__weftcutTest.addMotifLayer({ motifId, durationUs: 2_000_000 }), motifId) as string
      const cacheKey = await page.evaluate(layerId => (window as any).__weftcutTest.cacheKeyForLayer(layerId), layerId) as string
      layers.push({ layerId, motifId, cacheKey })
    }
    // Clear only measurements; all actual frame artifacts begin cold in this
    // isolated project. Automatic demand survives renderer reconstruction.
    await invokeCmd(page, 'motif_capture_diagnostics', { reset: true })
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: true } })
    const readSnapshot = () => invokeCmd<MotifBakeSnapshot>(page, 'motif_bake_snapshot')
    await expect.poll(async () => {
      const snapshot = await readSnapshot()
      return layers.some(layer => (snapshot.statuses[layer.cacheKey]?.done ?? 0) > 0)
    }, { timeout: 20_000 }).toBe(true)
    const beforeReload = await readSnapshot()
    expect(layers.some(layer => beforeReload.statuses[layer.cacheKey]?.phase !== 'ready')).toBe(true)
    await page.reload()
    await waitForHook(page, 'prebakeLayerAndWait')
    await expect.poll(async () => {
      const snapshot = await readSnapshot()
      return layers.every(layer => snapshot.statuses[layer.cacheKey]?.phase === 'ready' && snapshot.statuses[layer.cacheKey]?.done === 60)
    }, { timeout: 90_000 }).toBe(true)
    const completed = await readSnapshot()
    expect(completed.generation).toBe(beforeReload.generation)
    const stats = await invokeCmd<CaptureDiagnostics>(page, 'motif_capture_diagnostics')
    const selected = stats.lanes.filter(lane => layers.some(layer => layer.motifId === lane.motifId))
    const captures = selected.reduce((n, lane) => n + lane.captures, 0)
    const pageLoads = selected.reduce((n, lane) => n + lane.pageLoads, 0)
    expect(captures).toBeGreaterThanOrEqual(240)
    // A frame-round-robin implementation reloads almost every capture. A
    // bounded content slice must retain meaningful affinity on any hardware.
    expect(pageLoads).toBeLessThan(captures * .75)
    await testInfo.attach('motif-background-affinity.json', {
      body: JSON.stringify({ beforeReload, completed, diagnostics: stats }), contentType: 'application/json',
    })
  } finally { await app.close() }
})

test('Motif background preparation resumes automatically after a failed workspace switch in the same generation @serial', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: 'png' } })
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-bake-failed-open-'), name: 'Preparation recovery',
      canvas: { width: 64, height: 64, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: false } })
    const draft = await createMotifDraft(page, {
      id: 'workspace-recovery-probe', name: 'Workspace recovery probe', version: 1,
      size: [64, 64], default_duration_s: 2, props_schema: {},
    }, `<!doctype html><html><body style="margin:0"><script>
      motif.define({ frame(t) { document.body.style.background = 'rgb(70,' + Math.floor(t * 60) + ',160)'; }});
    </script></body></html>`)
    const motifId = await publishMotifDraft(page, draft)
    await waitForHook(page, 'addMotifLayer')
    const layerId = await page.evaluate(motifId => (window as any).__weftcutTest.addMotifLayer({
      motifId, durationUs: 2_000_000,
    }), motifId) as string
    const cacheKey = await page.evaluate(layerId => (window as any).__weftcutTest.cacheKeyForLayer(layerId), layerId) as string
    const workspace = await invokeCmd<string>(page, 'workspace_dir')

    // Hold one actual encode after three frames have persisted. The workspace
    // transition is therefore guaranteed to interrupt unfinished main-owned
    // preparation even on fast hardware; no production scheduling is mocked.
    await app.evaluate((_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const original = native.motifEncodePng
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const state = { calls: 0, held: false, release: () => { native.motifEncodePng = original; release() } }
      ;(globalThis as any).__failedOpenBakeGate = state
      native.motifEncodePng = async (...args: any[]) => {
        if (++state.calls === 4) { state.held = true; await gate }
        return original(...args)
      }
    }, addon)
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: true } })
    await expect.poll(() => app.evaluate(() => (globalThis as any).__failedOpenBakeGate.held), { timeout: 30_000 }).toBe(true)
    const readSnapshot = () => invokeCmd<MotifBakeSnapshot>(page, 'motif_bake_snapshot')
    const before = await readSnapshot()
    expect(before.statuses[cacheKey]?.done).toBeGreaterThan(0)
    expect(before.statuses[cacheKey]?.done).toBeLessThan(60)
    expect(before.statuses[cacheKey]?.phase).not.toBe('ready')

    const missing = path.join(tmpDir('weftcut-missing-project-'), 'does-not-exist')
    await expect(invokeCmd(page, 'project_open', { path: missing })).rejects.toThrow(/ProjectFolderMissing/)
    expect(await invokeCmd<string>(page, 'workspace_dir')).toBe(workspace)
    const session = await invokeCmd<{ generation: number }>(page, 'motif_bake_session')
    expect(session.generation).toBe(before.generation)
    await app.evaluate(() => (globalThis as any).__failedOpenBakeGate.release())

    // Only observe from here: no project edit, preview seek, settings toggle,
    // reload or second manual pre-bake may restart preparation for this test.
    await expect.poll(async () => {
      const snapshot = await readSnapshot()
      return snapshot.statuses[cacheKey]?.phase === 'ready' && snapshot.statuses[cacheKey]?.done === 60
    }, { timeout: 60_000 }).toBe(true)
    const completed = await readSnapshot()
    expect(completed.generation).toBe(before.generation)
    expect(completed.coverage[cacheKey]).toHaveLength(60)
    await testInfo.attach('motif-failed-workspace-recovery.json', {
      body: JSON.stringify({ before, session, completed }), contentType: 'application/json',
    })
  } finally {
    await app.evaluate(() => (globalThis as any).__failedOpenBakeGate?.release()).catch(() => {})
    await app.close()
  }
})
