import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, analyzeGradientRow } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport, importAndPlaceMedia, invokeCmd, tmpDir, exportSsimFloor } from './helpers/driver'

const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/media')

test('resource rejection explains recovery and opens performance settings without changing the budget', async ({}, testInfo) => {
  const { app, page } = await launchApp({ locale: 'zh-CN' })
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-budget-help-'), name: 'Budget help', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    const media = await importAndPlaceMedia(page, { mediaAbsPath: path.join(MEDIA, 'test_1080p_30fps_6s.mp4') })
    await page.evaluate(mediaId => (window as any).__weftcutTest.waitMediaExportReady({ mediaId }), media.mediaId)
    const before = await invokeCmd<any>(page, 'app_settings_get')
    // Exercise the real authority and Electron's wrapped rejection, independently
    // of the machine's memory size or other active resource leases.
    await app.evaluate(({ ipcMain }, memoryMiB) => {
      const acquire = ipcMain._invokeHandlers.get('resources:acquire')!
      ipcMain._invokeHandlers.set('resources:acquire', (event: any, request: any) =>
        acquire(event, { ...request, memoryMiB }))
    }, before.resource_allocation.work_mib + 1)
    const result = await driveExport(page, {
      outputAbsPath: path.join(tmpDir('weftcut-budget-help-out-'), 'out.mp4'),
      settings: { audio: { include: false }, decodeEngine: 'webcodecs' },
    }, { hook: 'exportTimeline' })
    expect(result.done.ok).toBe(false)
    const panel = page.locator('.export-progress-panel')
    await expect(panel.locator('.export-progress-status')).toContainText('请等待其他处理任务结束后重试')
    await expect(panel.locator('.export-progress-status')).toContainText('内存使用目标')
    await expect(panel.locator('.export-progress-status')).not.toContainText('resources:acquire')
    await expect(panel.locator('details')).not.toHaveAttribute('open', '')
    await panel.getByText('技术详情', { exact: true }).click()
    await expect(panel.locator('pre')).toContainText('resource-capacity-exceeded')
    await page.screenshot({ path: testInfo.outputPath('resource-recovery.png') })
    await panel.getByRole('button', { name: '打开设置', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.locator('#settings-panel-performance').getByLabel('内存使用目标', { exact: true })).toBeVisible()
    expect((await invokeCmd<any>(page, 'app_settings_get')).resource_policy).toEqual(before.resource_policy)
  } finally { await app.close() }
})

for (const memoryMiB of [2304, 4096]) test(`bounded WebCodecs 10-bit export drains EOS and preserves gradient precision (${memoryMiB} MiB)`, async ({}, testInfo) => {
  test.setTimeout(300_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-bounded10-project-'), name: 'Bounded 10-bit', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: memoryMiB } } })
    const output = path.join(tmpDir('weftcut-bounded10-output-'), 'export.mp4')
    const result = await driveExport(page, {
      mediaAbsPath: path.join(MEDIA, 'test_1080p_gradient10_h264.mp4'), outputAbsPath: output,
      settings: { decodeEngine: 'webcodecs', codec: 'hevc', bitDepth: 10, container: 'mp4', audio: { include: false } },
    })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    await testInfo.attach('export-performance', { body: JSON.stringify(perf), contentType: 'application/json' })
    expect(perf.resourcePlan.memoryMiB).toBeLessThanOrEqual(Math.floor(memoryMiB * .4))
    expect(perf.sources[0].buffer.capacityFrames).toBe(memoryMiB === 2304 ? 12 : 24)
    expect(perf.nativeHandles).toBe(0)
    expect(perf.totalFrames).toBe(30)
    expect(perf.sources[0].buffer.peakFrames).toBeLessThanOrEqual(perf.sources[0].buffer.capacityFrames)
    const ramp = analyzeGradientRow({ output, sample: 10, inMatrix: 'bt709', inRange: 'tv' })
    for (const channel of ramp.banding) {
      expect(channel.distinct_levels).toBeGreaterThan(600)
      expect(channel.max_plateau).toBeLessThanOrEqual(300)
    }
  } finally { await app.close() }
})

test('cancelling bounded production releases export leases and permits a subsequent export', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-bounded-cancel-'), name: 'Cancel bounded export', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 2304 } } })
    const media = await importAndPlaceMedia(page, { mediaAbsPath: path.join(MEDIA, 'test_1080p_30fps_6s.mp4') })
    await page.evaluate(mediaId => (window as any).__weftcutTest.waitMediaExportReady({ mediaId }), media.mediaId)
    await app.evaluate(({ ipcMain }) => {
      const acquire = ipcMain._invokeHandlers.get('resources:acquire')!
      const leases = new Set<string>()
      ;(globalThis as any).__cancelExportLeases = leases
      ipcMain._invokeHandlers.set('resources:acquire', async (event: any, request: any) => {
        const result = await acquire(event, request)
        leases.add(request.id)
        return result
      })
      const plan = ipcMain._invokeHandlers.get('resources:plan-export')!
      ipcMain._invokeHandlers.set('resources:plan-export', async (event: any, request: any) => {
        const selected = await plan(event, request)
        leases.add(request.id)
        return selected
      })
      ipcMain.on('resources:release', (_event, id: string) => leases.delete(id))
    })
    const outDir = tmpDir('weftcut-bounded-cancel-output-')
    await page.evaluate(outputAbsPath => {
      const w = window as any
      w.__cancelExportDone = false
      void w.__weftcutTest.exportTimeline({ outputAbsPath, settings: { decodeEngine: 'webcodecs', audio: { include: false } } })
        .catch(() => {}) // cancellation produces no output file
        .finally(() => { w.__cancelExportDone = true })
    }, path.join(outDir, 'cancelled.mp4'))
    await page.waitForFunction(() => {
      const state = (window as any).__weftcutExportState
      if (state?.kind !== 'progress' || state.progress.frame < 6) return false
      state.onCancel()
      return true
    })
    await page.waitForFunction(() => (window as any).__cancelExportDone)
    await expect.poll(() => app.evaluate(() => (globalThis as any).__cancelExportLeases.size)).toBe(0)
    const result = await driveExport(page, { outputAbsPath: path.join(outDir, 'completed.mp4'), settings: { decodeEngine: 'webcodecs', audio: { include: false } } }, { hook: 'exportTimeline' })
    expect(result.done.ok, result.done.error).toBe(true)
    expect(await page.evaluate(() => (window as any).__weftcutExportPerf.totalFrames)).toBe(180)
  } finally { await app.close() }
})

test('1080p export streams within a 2304 MiB memory target', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-bounded-project-'), name: 'Bounded export', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 2304 } } })
    const source = path.join(MEDIA, 'test_1080p_30fps_6s.mp4')
    const output = path.join(tmpDir('weftcut-bounded-output-'), 'export.mp4')
    const result = await driveExport(page, { mediaAbsPath: source, outputAbsPath: output, settings: { includeAudio: false, decodeEngine: 'webcodecs' } })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    expect(perf.totalFrames).toBe(180)
    expect(perf.totalDispatched).toBeLessThanOrEqual(182)
    expect(perf.sources).toHaveLength(1)
    expect(perf.sources[0].buffer.peakFrames).toBeLessThanOrEqual(perf.sources[0].buffer.capacityFrames)
    const report = analyze({ output, source, samples: [0, 58, 60, 118, 120, 177], ssimMin: exportSsimFloor() })
    expect(report.pass, JSON.stringify(report)).toBe(true)
  } finally { await app.close() }
})

test('trimmed long-GOP export fits the working allowance and preserves source frames', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-preroll-project-'), name: 'Preroll', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 4096 } } })
    const source = path.join(MEDIA, 'test_1080p_30fps_eostail.mp4')
    const outDir = tmpDir('weftcut-preroll-output-')
    const output = path.join(outDir, 'trimmed.mp4')
    // Keyframes are at 0 and 5s: reaching 4.5s requires decoding 135 pictures
    // which should never be retained or charged as an entire resident GOP.
    const result = await driveExport(page, {
      mediaAbsPath: source, outputAbsPath: output,
      range: { startUs: 4_500_000, endUs: 4_800_000 },
      settings: { includeAudio: false },
    })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    expect(perf.totalFrames).toBe(9)
    const reference = path.join(outDir, 'reference.mp4')
    const trimmed = spawnSync(process.env.FFMPEG || 'ffmpeg', [
      // The analyzer also compares the two neighbours after each sample.
      '-v', 'error', '-i', source, '-vf', 'trim=start_frame=135:end_frame=146,setpts=PTS-STARTPTS',
      '-an', '-c:v', 'libx264', '-crf', '0', reference,
    ], { encoding: 'utf8' })
    expect(trimmed.status, trimmed.stderr).toBe(0)
    const report = analyze({ output, source: reference, samples: [0, 4, 8], ssimMin: exportSsimFloor() })
    expect(report.pass, JSON.stringify(report)).toBe(true)
  } finally { await app.close() }
})

for (const { label, memory, stepUs, clips, expectedFrames } of [
  // Six retained 381 MiB windows still exceed the 1638 MiB working allowance.
  // More spaced clips mostly add blank output frames, which consume the
  // software-rendering deadline without strengthening the release assertion.
  { label: 'spaced clips', memory: 4096, stepUs: 2_000_000, clips: 6, expectedFrames: 309 },
  { label: 'rapid cuts', memory: 4096, stepUs: 300_000, clips: 12, expectedFrames: 108 },
]) test(`sequential ${label} release decoder reservations before admitting later clips`, async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-sequential-project-'), name: 'Sequential clips', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: memory } } })
    const source = path.join(MEDIA, 'test_1080p_30fps_6s.mp4')
    const first = await importAndPlaceMedia(page, { mediaAbsPath: source })
    for (let i = 0; i < clips; i++) {
      const startUs = i * stepUs
      const layerId = i === 0 ? first.layerId : (await page.evaluate(
        args => (window as any).__weftcutTest.placeMediaLayer(args),
        { mediaId: first.mediaId, tStartUs: startUs },
      )).layerId
      await invokeCmd(page, 'trim_layer', { layerId, edge: 'out', newTUs: startUs + 300_000 })
    }
    await page.evaluate(id => (window as any).__weftcutTest.waitMediaExportReady({ mediaId: id }), first.mediaId)
    // Track actual decoder leases rather than relying on a process RSS floor
    // that differs between hardware and software rendering. Even six retained
    // decoders still exceed this budget; sequential clips need only one.
    await app.evaluate(({ ipcMain }) => {
      const acquire = ipcMain._invokeHandlers.get('resources:acquire')!
      const leases = new Set<string>()
      const stats = { peak: 0 }
      ;(globalThis as any).__sequentialDecoders = stats
      ipcMain._invokeHandlers.set('resources:acquire', async (event: any, request: any) => {
        const result = await acquire(event, request)
        // WebCodecs export reserves 381 MiB for this 1080p fixture; preview
        // and encoder reservations are smaller.
        if (request.threads === 0 && request.memoryMiB >= 300) {
          leases.add(request.id)
          stats.peak = Math.max(stats.peak, leases.size)
        }
        return result
      })
      ipcMain.on('resources:release', (_event, id: string) => leases.delete(id))
    })
    const outputDir = tmpDir('weftcut-sequential-output-')
    const output = path.join(outputDir, 'sequence.mp4')
    const result = await driveExport(page, { outputAbsPath: output, settings: { audio: { include: false }, decodeEngine: 'webcodecs' } }, { hook: 'exportTimeline' })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    expect(perf.totalFrames).toBe(expectedFrames)
    expect(perf.sources).toHaveLength(clips)
    expect(await app.evaluate(() => (globalThis as any).__sequentialDecoders.peak)).toBe(1)
    if (label === 'rapid cuts') {
      const reference = path.join(outputDir, 'reference.mp4')
      const repeated = spawnSync(process.env.FFMPEG || 'ffmpeg', [
        '-v', 'error', '-i', source, '-vf', 'trim=end_frame=9,loop=loop=11:size=9:start=0,setpts=N/(30*TB)',
        '-frames:v', '108', '-an', '-c:v', 'libx264', '-crf', '0', reference,
      ], { encoding: 'utf8' })
      expect(repeated.status, repeated.stderr).toBe(0)
      const report = analyze({ output, source: reference, samples: [0, 8, 9, 17, 18, 53, 54, 99, 105], ssimMin: exportSsimFloor() })
      expect(report.pass, JSON.stringify(report)).toBe(true)
    }
  } finally { await app.close() }
})


test('Motif and video export reduces in-flight frames to fit the 2304 MiB memory target', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-motif-budget-'), name: 'Motif budget', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 2304 } } })
    const source = await importAndPlaceMedia(page, { mediaAbsPath: path.join(MEDIA, 'test_1080p_30fps_6s.mp4') })
    await invokeCmd(page, 'trim_layer', { layerId: source.layerId, edge: 'out', newTUs: 2_000_000 })
    await page.evaluate(id => (window as any).__weftcutTest.waitMediaExportReady({ mediaId: id }), source.mediaId)
    const output = path.join(tmpDir('weftcut-motif-budget-out-'), 'out.mp4')
    const result = await driveExport(page, { motifId: 'text-fx', outputAbsPath: output, durationUs: 2_000_000,
      settings: { encoderEngine: 'native', audio: { include: false } } }, { hook: 'exportMotifClip' })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    await testInfo.attach('export-performance', { body: JSON.stringify(perf), contentType: 'application/json' })
    expect(perf.totalFrames).toBe(60)
    expect(perf.resourcePlan.memoryMiB).toBeLessThanOrEqual(921)
    expect(perf.resourcePlan.motifFrames).toBeLessThan(3)
    expect(perf.motif.framesRead).toBe(60)
    expect(perf.motif.peakBytes).toBeLessThanOrEqual(perf.resourcePlan.motifBufferBytes)
  } finally { await app.close() }
})
