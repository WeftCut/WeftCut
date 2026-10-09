import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashCacheKey } from '../../src/renderer/render/motifs/frameCache'
import type { E2EHook } from '../../src/renderer/testhook/e2eHook'
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import { createMotifDraft, publishMotifDraft } from './helpers/motif'
import { resourceDiagnostics } from './helpers/resourceDiagnostics'
import type { MotifBakeSnapshot } from '../../src/shared/motifs/baking'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
const TOTAL = 1_800
const SAVED = 900

// The saved prefix itself exceeds L0 capacity (900 × 1080p RGBA > 512 MiB).
// Seed deterministic authored pixels so the gate measures playback/ongoing
// baking, not the time needed to capture a long fixture before the test.
for (const complete of [false, true]) {
  test(`@serial long Motif streams a saved window while baking remains ${complete ? 'complete' : 'partial'}`, async ({}, testInfo) => {
    test.setTimeout(120_000)
    const userDataDir = tmpDir('weftcut-partial-user-')
    let running = await launchApp({ userDataDir })
    try {
      await newProject(running.page, {
        parentFolder: tmpDir('weftcut-partial-project-'), name: 'Partial',
        canvas: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 },
      })
      await invokeCmd(running.page, 'app_settings_set', { patch: {
        prebake_motifs: false, performance_policy: { cache_mib: 512 }, resource_policy: { background_playback: false },
      } })
      const draft = await createMotifDraft(running.page, {
        id: 'partial-bake-probe', name: 'Partial bake probe', version: 1,
        size: [1920, 1080], default_duration_s: 30, props_schema: {},
      }, `<!doctype html><html><body style="margin:0"><script>
        motif.define({ frame(t) {
          document.body.style.background = Math.floor(t * 2) % 2 ? '#a020f0' : '#20d060';
        }});
      </script></body></html>`)
      const motifId = await publishMotifDraft(running.page, draft)
      await waitForHook(running.page, 'addMotifLayer')
      const layerId = await running.page.evaluate(motifId =>
        (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.addMotifLayer({ motifId, durationUs: 30_000_000 }), motifId)
      const cacheKey = await running.page.evaluate(layerId =>
        (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.cacheKeyForLayer(layerId), layerId)
      expect(cacheKey).not.toBeNull()
      const projectPath = await invokeCmd<string>(running.page, 'workspace_dir')
      const pngs = await running.page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 1920; canvas.height = 1080
        const ctx = canvas.getContext('2d')!
        return ['#20d060', '#a020f0'].map(color => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 1920, 1080)
          return canvas.toDataURL('image/png').split(',')[1]!
        })
      })
      const encoded = await running.app.evaluate(async (_electron, { addon, pngs }) => {
        const native = process.getBuiltinModule('module').createRequire(addon)(addon)
        const result: string[] = []
        for (const png of pngs) result.push((await native.motifEncodePng(Buffer.from(png, 'base64'), true)).toString('base64'))
        return result
      }, { addon, pngs })
      await running.app.close()
      const directory = path.join(projectPath, 'Cache', 'raster', hashCacheKey(cacheKey!))
      await fs.mkdir(directory, { recursive: true })
      const buffers = encoded.map(value => Buffer.from(value, 'base64'))
      for (let frame = 0; frame < (complete ? TOTAL : SAVED); frame++) {
        await fs.writeFile(path.join(directory, `${frame}.wfrm`), buffers[Math.floor(frame / 30) % 2]!)
      }

      running = await launchApp({ userDataDir })
      await running.app.evaluate(({ ipcMain }) => {
        const stats = { reads: 0, active: 0, maxActive: 0, captures: [] as number[] }
        ;(globalThis as any).__partialBakeStats = stats
        const read = ipcMain._invokeHandlers.get('motif:read')!
        ipcMain._invokeHandlers.set('motif:read', async (...args: any[]) => {
          stats.reads++; stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active)
          try {
            // Slow storage must preserve progress and concurrent admission.
            await new Promise(resolve => setTimeout(resolve, 250))
            return await read(...args)
          } finally { stats.active-- }
        })
        const capture = ipcMain._invokeHandlers.get('motif:capture')!
        ipcMain._invokeHandlers.set('motif:capture', (...args: any[]) => {
          stats.captures.push(args[1].tSec)
          return capture(...args)
        })
      })
      await waitForHook(running.page, 'motifReopenProject')
      await invokeCmd(running.page, 'motif_capture_diagnostics', { reset: true })
      await running.page.evaluate(path =>
        (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.motifReopenProject({ path }), projectPath)
      await waitForHook(running.page, 'compositorPerfSnapshot')
      await expect.poll(() => running.page.evaluate(() =>
        (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.compositorPerfSnapshot()?.motifs?.[0]?.boundFrame),
      { timeout: 30_000 }).toBe(0)
      await expect.poll(() => running.app.evaluate(() => (globalThis as any).__partialBakeStats.maxActive),
        { timeout: 15_000 }).toBe(3)

      // Starts the real baker; the partial case must keep writing the tail
      // while playback stays entirely within the already saved prefix.
      await running.page.evaluate(({ layerId, expectedFrames }) =>
        (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest.prebakeLayerAndWait({ layerId, expectedFrames }),
      { layerId, expectedFrames: complete ? TOTAL : SAVED })
      const { rows, observedPlaybackPause } = await running.page.evaluate(async () => {
        const hook = (window as unknown as { __weftcutTest: E2EHook }).__weftcutTest
        const rows = []
        let observedPlaybackPause = false
        hook.transportPlay()
        try {
          const deadline = performance.now() + 10_000
          while (performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50))
            const row = hook.compositorPerfSnapshot()?.motifs?.[0]
            rows.push(row)
            if (!observedPlaybackPause) {
              const state = await (window as any).api.backend.invoke('motif_bake_snapshot') as MotifBakeSnapshot
              observedPlaybackPause = Object.values(state.statuses).some(status => status.phase === 'paused' && status.reason === 'playback')
            }
            // Cross the 512 MiB cache (about 64 decoded frames), remaining
            // inside the saved prefix even on a slow software GPU.
            if ((row?.boundFrame ?? -1) >= 180) break
          }
        } finally { hook.transportPause() }
        return { rows, observedPlaybackPause }
      })
      const stats = await running.app.evaluate(() => (globalThis as any).__partialBakeStats as {
        reads: number; maxActive: number; captures: number[];
      })
      const captureDiagnostics = await invokeCmd<{ lanes: { motifId: string; captures: number }[] }>(running.page, 'motif_capture_diagnostics')
      const bakeSnapshot = await invokeCmd<MotifBakeSnapshot>(running.page, 'motif_bake_snapshot')
      // Attach before assertions so a playback failure retains the evidence.
      await testInfo.attach('partial-bake-playback.json', {
        body: JSON.stringify({ complete, stats, rows, observedPlaybackPause, captureDiagnostics, bakeSnapshot, resources: await resourceDiagnostics(running.page) }),
        contentType: 'application/json',
      })
      const frames = rows.map(row => row?.boundFrame).filter((frame): frame is number => frame != null)
      expect(rows.every(row => row?.boundFrame != null), 'every sample must have a displayed frame').toBe(true)
      expect(new Set(frames).size).toBeGreaterThan(3)
      expect(frames.at(-1)!).toBeGreaterThanOrEqual(180)
      expect(frames.every((frame, i) => i === 0 || frame >= frames[i - 1]!)).toBe(true)
      expect(rows.every(row => row?.targetFrame != null && row.targetFrame < SAVED)).toBe(true)
      // Frame rate and hold times depend on raster hardware and disk latency.
      // Gate bounded progress, monotonicity and saved-frame reuse; retain the
      // timing samples above for diagnosis rather than imposing a CI fps floor.
      expect(stats.captures.every(time => time >= SAVED / 60)).toBe(true)
      if (complete) {
        expect(stats.captures).toHaveLength(0)
        expect(captureDiagnostics.lanes.filter(lane => lane.motifId === motifId).reduce((n, lane) => n + lane.captures, 0)).toBe(0)
        expect(bakeSnapshot.statuses[cacheKey!]?.phase).toBe('ready')
      }
      else {
        expect(observedPlaybackPause, 'background work must explain why playback paused it').toBe(true)
        await expect.poll(async () => (await fs.readdir(directory)).filter(name => name.endsWith('.wfrm')).length,
          { timeout: 15_000 }).toBeGreaterThan(SAVED)
        await expect.poll(async () => (await invokeCmd<MotifBakeSnapshot>(running.page, 'motif_bake_snapshot')).statuses[cacheKey!]?.reason,
          { timeout: 15_000 }).not.toBe('playback')
        expect((await fs.readdir(directory)).filter(name => name.endsWith('.wfrm')).length).toBeLessThan(TOTAL)
      }
    } finally { await running.app.close() }
  })
}
