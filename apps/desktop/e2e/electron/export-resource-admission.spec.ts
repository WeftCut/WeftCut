import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, analyzeGradientRow } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport, importAndPlaceMedia, invokeCmd, tmpDir, exportSsimFloor, dockPanel, waitForHook } from './helpers/driver'
import { exportDecoderMiB } from '../../src/shared/export-resources'
import { mergeSettings } from '../../src/shared/exportSettings'
import { exportTerminal, type ExportJob } from '../../src/shared/exportJob'

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
    await expect(panel.locator('.export-error-details')).not.toHaveAttribute('open', '')
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
      const log: { id: string; memoryMiB?: number; threads?: number }[] = []
      ;(globalThis as any).__sequentialLeases = log
      ipcMain._invokeHandlers.set('resources:acquire', async (event: any, request: any) => {
        const result = await acquire(event, request)
        log.push({ id: request.id, memoryMiB: request.memoryMiB, threads: request.threads })
        return result
      })
      ipcMain.on('resources:release', (_event, id: string) => log.push({ id }))
    })
    const outputDir = tmpDir('weftcut-sequential-output-')
    const output = path.join(outputDir, 'sequence.mp4')
    const result = await driveExport(page, { outputAbsPath: output, settings: { audio: { include: false }, decodeEngine: 'webcodecs' } }, { hook: 'exportTimeline' })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    expect(perf.totalFrames).toBe(expectedFrames)
    expect(perf.sources).toHaveLength(clips)
    // A decoder's lease is the one sized by the export's own formula for this
    // source and the frame window the plan admitted. The fixture is 1920 wide;
    // its coded height is 1080 or, padded to whole macroblocks, 1088.
    const decoderMiB = new Set((Object.values(perf.resourcePlan.frameWindows) as number[])
      .flatMap(frames => [1080, 1088].map(height => exportDecoderMiB(1920, height, false, frames))))
    const live = new Set<string>()
    let peak = 0
    for (const entry of await app.evaluate(() => (globalThis as any).__sequentialLeases as { id: string; memoryMiB?: number; threads?: number }[])) {
      if (entry.memoryMiB === undefined) live.delete(entry.id)
      else if (entry.threads === 0 && decoderMiB.has(entry.memoryMiB)) live.add(entry.id)
      peak = Math.max(peak, live.size)
    }
    expect(peak, 'decoder leases live at once').toBe(1)
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
    const { resource_allocation: { work_mib: workMiB } } = await invokeCmd<{ resource_allocation: { work_mib: number } }>(page, 'app_settings_get')
    // What main was offered and which plan it admitted, largest first.
    await app.evaluate(({ ipcMain }) => {
      const plan = ipcMain._invokeHandlers.get('resources:plan-export')!
      const admissions: { options: number[]; index: number }[] = []
      ;(globalThis as any).__motifBudgetAdmissions = admissions
      ipcMain._invokeHandlers.set('resources:plan-export', async (event: any, request: any) => {
        const index = await plan(event, request)
        admissions.push({ options: request.options, index })
        return index
      })
    })
    const output = path.join(tmpDir('weftcut-motif-budget-out-'), 'out.mp4')
    const result = await driveExport(page, { motifId: 'text-fx', outputAbsPath: output, durationUs: 2_000_000,
      settings: { encoderEngine: 'native', audio: { include: false } } }, { hook: 'exportMotifClip' })
    expect(result.done.ok, result.done.error).toBe(true)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    await testInfo.attach('export-performance', { body: JSON.stringify(perf), contentType: 'application/json' })
    expect(perf.totalFrames).toBe(60)
    const admissions = await app.evaluate(() => (globalThis as any).__motifBudgetAdmissions as { options: number[]; index: number }[])
    await testInfo.attach('export-admissions', { body: JSON.stringify({ workMiB, admissions }), contentType: 'application/json' })
    const working = admissions.find(admission => admission.options[admission.index] === perf.resourcePlan.memoryMiB)
    expect(working, 'no admission matches the plan the export ran with').toBeDefined()
    expect(working!.index, 'the full plan fitted, so nothing was reduced').toBeGreaterThan(0)
    expect(perf.resourcePlan.memoryMiB).toBeLessThanOrEqual(workMiB)
    expect(perf.motif.framesRead).toBe(60)
    expect(perf.motif.peakBytes).toBeLessThanOrEqual(perf.resourcePlan.motifBufferBytes)
  } finally { await app.close() }
})

test('background export keeps review available and preserves output across Preview remounts', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  let jobId: string | undefined
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-background-export-project-'), name: 'Background export',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'webcodecs' } })
    const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: path.join(MEDIA, 'test_1080p_30fps_6s.mp4') })
    await waitForHook(page, 'addMotifLayer')
    await page.evaluate(id => window.__weftcutTest!.waitMediaExportReady({ mediaId: id }), mediaId)
    await page.evaluate(() => window.__weftcutTest!.addMotifLayer({
      motifId: 'countdown', durationUs: 2_000_000, props: { seconds: 2 },
    }))

    // A real native encode waits for its first frame acknowledgment. Inject a
    // capacity refusal for editor decoder opens while leaving export leases
    // attached to their admitted plan.
    await app.evaluate(({ ipcMain }) => {
      const write = ipcMain._invokeHandlers.get('export:videosink_write')!
      const acquire = ipcMain._invokeHandlers.get('resources:acquire')!
      let barrier: Promise<void> | undefined
      let release: (() => void) | undefined
      let frameHeld = false
      let refusePreview = false
      Object.assign(globalThis, {
        holdExportFrames: () => { frameHeld = false; barrier = new Promise<void>(resolve => { release = resolve; }); },
        releaseExportFrames: () => { release?.(); barrier = undefined; },
        exportFrameHeld: () => frameHeld,
        refusePreviewResources: () => { refusePreview = true; },
        allowPreviewResources: () => { refusePreview = false; },
      })
      ipcMain._invokeHandlers.set('export:videosink_write', async (event, frame) => {
        if (barrier) { frameHeld = true; await barrier; }
        return write(event, frame)
      })
      ipcMain._invokeHandlers.set('resources:acquire', (event, request) => {
        if (refusePreview && !request.finalizationToken) throw new Error('resource-capacity-exceeded: synthetic preview refusal')
        return acquire(event, request)
      })
    })

    const outDir = tmpDir('weftcut-background-export-output-')
    const baseline = path.join(outDir, 'foreground.mp4')
    const output = path.join(outDir, 'background.mp4')
    const status = () => invokeCmd<ExportJob>(page, 'export_job_status', { job_id: jobId })
    const startHeld = async (output_path: string) => {
      await app.evaluate(() => Reflect.get(globalThis, 'holdExportFrames')())
      const job = await invokeCmd<ExportJob>(page, 'export_job_start', {
        output_path, on_conflict: 'fail',
        settings: mergeSettings({ encoderEngine: 'native', hwAccel: 'software', includeAudio: false }),
      })
      jobId = job.job_id
      await expect.poll(async () => {
        const active = await status()
        if (active.error) throw new Error(active.error.message)
        return app.evaluate(() => Reflect.get(globalThis, 'exportFrameHeld')())
      }, { timeout: 30_000 }).toBe(true)
    }
    const finish = async (file: string) => {
      await app.evaluate(() => Reflect.get(globalThis, 'releaseExportFrames')())
      await expect.poll(async () => (await status()).state, { timeout: 30_000 }).toBe('completed')
      expect(statSync(file).size).toBeGreaterThan(100)
      await expect(page.getByRole('dialog')).toContainText(path.basename(file))
      await page.getByRole('button', { name: 'Dismiss' }).click()
    }

    await startHeld(baseline)
    const foreground = page.getByRole('dialog')
    await expect(foreground.locator('.export-progress-status')).toContainText('Encoding')
    // A foreground export shows its own dialog, never the work pill's ring.
    const pill = page.locator('.status-bar').getByTestId('status-bar-work')
    await expect(pill.locator('[role="progressbar"]')).toHaveCount(0)
    await expect(page.getByTestId('preview-suspended')).toHaveText('Exporting')
    await finish(baseline)

    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { preview_during_export: true } } })
    await startHeld(output)
    // A background export leads the work pill (its ring and label) and its
    // popover's first group, with Cancel in the export's row.
    await expect(pill.locator('[role="progressbar"]')).toBeVisible()
    await expect(pill).toHaveText(/^Export/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await pill.click()
    const details = page.locator('.work-pill-details')
    await expect(details.locator('.work-group').first()).toHaveAttribute('aria-label', 'Export')
    const exportRow = details.getByRole('group', { name: 'Export', exact: true }).locator('[data-work="export"]')
    await expect(exportRow).toContainText(path.basename(output))
    await expect(exportRow.getByRole('button', { name: 'Cancel export', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    const lane = page.getByTestId('track-lane').first()
    const laneIsInert = () => lane.evaluate(el => !!el.closest('[inert]'))
    await expect.poll(laneIsInert).toBe(true)
    const view = page.getByText('View', { exact: true })
    const openPanel = async (name: string) => {
      await view.click()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    await openPanel('Media Pool')
    const media = dockPanel(page, 'media')
    await expect(media).toHaveAttribute('inert', '')
    const mediaLock = page.locator('.weft-dock-panel-frame').filter({ has: media }).locator('.weft-dock-panel-lock')
    await expect(mediaLock).toBeVisible()
    await expect(invokeCmd(page, 'add_track', {})).rejects.toThrow(/export is active/i)

    const transport = () => page.evaluate(() => window.__weftcutTest!.audioTransportSnapshot())
    await page.getByTestId('timeline-ruler').click({ position: { x: 40, y: 10 } })
    const scrubbed = (await transport())!.positionUs
    expect(scrubbed).toBeGreaterThan(0)
    const play = page.getByRole('button', { name: 'Play / pause', exact: true })
    await play.click()
    await expect.poll(async () => (await transport())?.phase).toBe('playing')
    await expect.poll(async () => (await transport())?.positionUs).toBeGreaterThan(scrubbed)
    await expect.poll(() => page.evaluate(() =>
      window.__weftcutTest!.compositorPerfSnapshot()?.sync.videoLateMs ?? null)).not.toBeNull()
    await play.click()
    await expect.poll(async () => (await transport())?.phase).toBe('paused')
    const capture = () => page.screenshot({
      mask: [page.locator('.status-bar-message')], maskColor: '#101418', scale: 'css',
    })
    await testInfo.attach('background-export', { body: await capture(), contentType: 'image/png' })

    await openPanel('Preview')
    await view.click()
    await page.getByRole('menuitem', { name: 'Close Active Panel', exact: true }).click()
    await expect(dockPanel(page, 'preview')).toHaveCount(0)
    await app.evaluate(() => Reflect.get(globalThis, 'refusePreviewResources')())
    await openPanel('Preview')
    await expect(dockPanel(page, 'preview')).toBeVisible()
    const resourceNotice = page.getByText('Preview is waiting for resources while the export runs.')
    await expect(resourceNotice).toBeVisible()
    await testInfo.attach('preview-capacity', { body: await capture(), contentType: 'image/png' })
    expect((await status()).state).toBe('rendering')
    const remounted = await page.evaluate(() => window.__weftcutTest!.previewResourceProbe()!.generation)
    await app.evaluate(() => Reflect.get(globalThis, 'allowPreviewResources')())
    // Whether the preview fits beside the held export depends on the host's
    // memory target (a 7 GiB runner's does not), so its recovery is checked
    // after the export ends: the same Preview decodes again by retrying.
    await finish(output)
    await expect(pill.locator('[role="progressbar"]')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__weftcutTest!.activeClipProbe()?.ringSize ?? 0)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__weftcutTest!.previewResourceProbe()!.generation)).toBe(remounted)
    await expect.poll(laneIsInert).toBe(false)
    await expect(media).not.toHaveAttribute('inert', '')
    await expect(mediaLock).toHaveCount(0)
    expect(await invokeCmd(page, 'add_track', {})).toBeTruthy()

    const frameHashes = (file: string) => execFileSync('ffmpeg',
      ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' })
    expect(frameHashes(output)).toBe(frameHashes(baseline))
  } finally {
    try {
      await app.evaluate(() => Reflect.get(globalThis, 'releaseExportFrames')?.())
      if (jobId) {
        const args = { job_id: jobId }
        await invokeCmd(page, 'export_job_cancel', args)
        await expect.poll(async () => exportTerminal((await invokeCmd<ExportJob>(page, 'export_job_status', args)).state)).toBe(true)
      }
    } finally {
      await app.close()
    }
  }
})
