// e2e gate: motif export — countdown baked and present in the output file.
//
// Assertion: two output frames in DIFFERENT seconds differ (self-SSIM well
// below 1.0). The countdown's numeral changes at 1-second boundaries AND its
// progress arc sweeps every frame; a skipped/static motif scores ~1.0 (identical
// black frames) while an animating motif scores far lower. We use frame 10
// (≈0.33 s, numeral 2) vs frame 50 (≈1.67 s, numeral 1).

import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, analyzeSelf } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport, tmpDir } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

for (const source of ['builtin', 'installed'] as const) {
  test(`motif export: ${source} countdown animates in output (frames differ across seconds)`, async () => {
    test.skip(
      process.env.WEFTCUT_E2E_NO_EXPORT === '1',
      'WebCodecs H.264 encode needs a GPU not available on headless CI runners; motif export is verified locally',
    )
    test.setTimeout(300_000)
    const OUTPUT = path.join(tmpDir('weftcut-e2e-motif-out-'), 'motif-out.mp4')
    const PROJECT_PARENT = tmpDir('weftcut-e2e-motif-proj-')
    rmSync(OUTPUT, { force: true })

    const userDataDir = tmpDir('weftcut-e2e-motif-profile-')
    const motifId = source === 'builtin' ? 'countdown' : 'e2e-user-countdown'
    if (source === 'installed') {
      // Same animation, but resolved through the runtime user catalog. The
      // export Worker has only built-in manifests: baked pixels must suffice.
      const motifDir = path.join(userDataDir, 'data', 'motifs', motifId)
      mkdirSync(motifDir, { recursive: true })
      const builtinDir = path.join(__dirname, '../../src/shared/motifs/builtin/countdown')
      const manifest = { ...JSON.parse(readFileSync(path.join(builtinDir, 'manifest.json'), 'utf8')), id: motifId }
      const html = readFileSync(path.join(builtinDir, 'index.html'), 'utf8')
        .replace('<head>', `<head><script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>`)
      writeFileSync(path.join(motifDir, 'index.html'), html)
    }
    const { app, page } = await launchApp({ userDataDir })
    try {
      // 480×480 project matches countdown native size: the motif fills the frame
      // so the self-SSIM threshold has a wide margin.
      const projectName = 'e2e-exp-' + Date.now()
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: projectName,
        canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
      })

      // Cold export captures and persists only frames the worker consumes.
      const r = await driveExport(
        page,
        {
          motifId,
          outputAbsPath: OUTPUT,
          durationUs: 2_000_000,
        },
        { hook: 'exportMotifClip', timeout: 280_000 },
      )
      if (!r.done.ok) throw new Error('exportMotifClip failed: ' + r.done.error)

      expect(existsSync(OUTPUT), 'output file must exist after export').toBe(true)

      const report = analyzeSelf({ output: OUTPUT, samples: [10, 50], ssimMax: 0.99 })
      console.log('[export] motif self-ssim report:', JSON.stringify(report))

      const pair = report.pairs[0]
      if (!pair) throw new Error('no self-ssim pair returned: ' + JSON.stringify(report))
      if (!pair.differ) {
        throw new Error(
          `motif frames did NOT differ (ssim ${pair.ssim.toFixed(4)} >= 0.99) — ` +
            `the motif likely rendered static/black (skipped) in export`,
        )
      }
      expect(report.pass).toBe(true)

      const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
      expect(perf.motif.peakBytes).toBeLessThanOrEqual(128 * 1024 * 1024)
      expect(perf.motif.framesRead).toBe(60)
      const rasterDir = path.join(PROJECT_PARENT, projectName, 'Cache', 'raster')
      const frameDir = path.join(rasterDir, readdirSync(rasterDir)[0]!)
      expect(readdirSync(frameDir).filter(f => f.endsWith('.wfrm')).length).toBeGreaterThanOrEqual(60)

      if (source === 'builtin') {
        // Repair both a missing and a corrupt frame, and compare the output.
        rmSync(path.join(frameDir, '32.wfrm'))
        writeFileSync(path.join(frameDir, '50.wfrm'), 'corrupt')
        const repaired = path.join(path.dirname(OUTPUT), 'repaired.mp4')
        const rerun = await driveExport(page, { outputAbsPath: repaired }, { hook: 'exportTimeline', timeout: 120_000 })
        if (!rerun.done.ok) throw new Error(rerun.done.error)
        expect(existsSync(path.join(frameDir, '32.wfrm'))).toBe(true)
        expect(readFileSync(path.join(frameDir, '50.wfrm')).length).toBeGreaterThan(7)
        expect(analyze({ output: repaired, source: OUTPUT, samples: [0, 32, 50, 59], ssimMin: 0.995, window: 0 }).pass).toBe(true)

        // Cancellation is reachable in the ordinary progress UI, including
        // frame waits. A subsequent export must still complete in this app.
        const cancelled = path.join(path.dirname(OUTPUT), 'cancelled.mp4')
        await page.evaluate(outputAbsPath => {
          const w = window as any
          w.__cancelResult = null
          void w.__weftcutTest.exportTimeline({ outputAbsPath }).then(
            () => { w.__cancelResult = 'unexpected success' },
            () => { w.__cancelResult = 'cancelled' },
          )
        }, cancelled)
        await page.waitForFunction(() => {
          const s = (window as any).__weftcutExportState
          return s?.kind === 'progress' && typeof s.onCancel === 'function'
        })
        await page.evaluate(() => (window as any).__weftcutExportState.onCancel())
        await page.waitForFunction(() => (window as any).__cancelResult !== null)
        expect(await page.evaluate(() => (window as any).__cancelResult)).toBe('cancelled')
        expect(existsSync(cancelled)).toBe(false)
        const resumed = await driveExport(page, { outputAbsPath: path.join(path.dirname(OUTPUT), 'resumed.mp4') }, { hook: 'exportTimeline', timeout: 120_000 })
        expect(resumed.done.ok).toBe(true)
      }
    } finally {
      await app.close()
    }
  })
}
