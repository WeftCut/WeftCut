import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, driveExport, invokeCmd, tmpDir, forceCloseApp, importAndPlaceMedia } from './helpers/driver'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
const media = fileURLToPath(new URL('../fixtures/media/test_1080p_30fps_6s.mp4', import.meta.url))

test('export decoder waits for transient working memory to drain', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-decode-admission-'), name: 'Decode admission', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 2304 } } })
    await app.evaluate(({ ipcMain }, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const handler = ipcMain._invokeHandlers.get('resources:acquire')!
      const trace = { attempts: 0, before: null as any, released: false }
      ;(globalThis as any).__decodeAdmissionTrace = trace
      ipcMain._invokeHandlers.set('resources:acquire', (event: any, request: any) => {
        if (request.memoryMiB === 381) {
          if (trace.attempts++ === 0) {
            // Replay CI's 651 + 381 > 921 MiB rejection using a real lease.
            const before = JSON.parse(native.resourcesSnapshot())
            const lease = native.resourcesReserve(0, Math.max(1, 651 - before.reserved_mib))
            trace.before = JSON.parse(native.resourcesSnapshot())
            setTimeout(() => { native.resourcesRelease(lease); trace.released = true }, 250)
          }
        }
        return handler(event, request)
      })
    }, addon)
    const result = await driveExport(page, { mediaAbsPath: media,
      outputAbsPath: path.join(tmpDir('weftcut-decode-admission-out-'), 'out.mp4'),
      settings: { encoderEngine: 'native', decodeEngine: 'webcodecs', audio: { include: false } } })
    const trace = await app.evaluate(() => (globalThis as any).__decodeAdmissionTrace)
    await testInfo.attach('decoder-admission', { body: JSON.stringify({ result, trace }), contentType: 'application/json' })
    expect(result.done.ok, result.done.error).toBe(true)
    expect(trace.attempts).toBeGreaterThan(1)
    expect(trace.before.reserved_mib).toBeGreaterThanOrEqual(651)
    expect(trace.released).toBe(true)
    expect(await page.evaluate(() => (window as any).__weftcutExportPerf.totalFrames)).toBe(180)
  } finally { await app.close() }
})

test('completed encoding waits for the occupied processing slot before mux', async ({}, testInfo) => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-mux-slot-'), name: 'Mux slot', canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    const trackId = await invokeCmd<string>(page, 'add_track')
    await invokeCmd(page, 'add_color_layer', { trackId, color: { r: 255, g: 0, b: 0, a: 1 }, tStartUs: 0, durationUs: 1_000_000 })
    const settings = await invokeCmd<any>(page, 'app_settings_get')
    await app.evaluate(({ ipcMain }, { addon, allocation }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      native.resourcesConfigure(JSON.stringify({ ...allocation, cpu_threads: 1, task_threads: 1, background_jobs: 1 }))
      const handler = ipcMain._invokeHandlers.get('backend:invoke')!
      ipcMain._invokeHandlers.set('backend:invoke', async (event: any, request: any) => {
        if (request.channel !== 'mux_export') return handler(event, request)
        const slot = native.resourcesReserve(1, 64)
        setTimeout(() => native.resourcesRelease(slot), 250)
        return handler(event, request)
      })
    }, { addon, allocation: settings.resource_allocation })
    const result = await driveExport(page, { outputAbsPath: path.join(tmpDir('weftcut-mux-slot-out-'), 'out.mp4'), settings: { audio: { include: false } } }, { hook: 'exportTimeline' })
    await testInfo.attach('slot-export', { body: JSON.stringify(result), contentType: 'application/json' })
    expect(result.done.ok, result.done.error).toBe(true)
  } finally { await app.close() }
})

test('test cleanup bounds a blocked graceful quit and reaps descendants', async () => {
  const { app } = await launchApp()
  try {
    await app.evaluate(({ app }) => app.on('before-quit', (event: any) => event.preventDefault()))
    const closing = app.close()
    const outcome = await Promise.race([
      closing.then(() => 'closed', error => String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve('close remained pending'), 15_000)),
    ])
    expect(outcome).not.toBe('close remained pending')
    expect(outcome).toContain('graceful close timed out')
  } finally { forceCloseApp(app) }
})

test('the minimum target rejects an unfit 1080p export and recovers after a settings edit', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-minimum-target-'), name: 'Minimum target', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    const imported = await importAndPlaceMedia(page, { mediaAbsPath: media })
    await page.evaluate(mediaId => (window as any).__weftcutTest.waitMediaExportReady({ mediaId }), imported.mediaId)
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 1024 } } })
    const output = path.join(tmpDir('weftcut-minimum-out-'), 'out.mp4')
    const settings = { encoderEngine: 'native', decodeEngine: 'webcodecs', audio: { include: false } }
    const start = Date.now()
    const rejected = await driveExport(page, { outputAbsPath: output, settings }, { hook: 'exportTimeline' })
    await testInfo.attach('minimum-target-rejection', { body: JSON.stringify({ elapsedMs: Date.now() - start, ...rejected }), contentType: 'application/json' })
    expect(rejected.done.ok).toBe(false)
    expect(rejected.done.error).toContain('resource-capacity-exceeded')
    expect(Date.now() - start).toBeLessThan(30_000)
    expect((await invokeCmd<any>(page, 'app_settings_get')).resource_policy.memory_mib).toBe(1024)
    // The user changes the target explicitly; rejection itself never edits it.
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 3072 } } })
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).pressure).toBe('normal')
    const recovered = await driveExport(page, { outputAbsPath: output, settings }, { hook: 'exportTimeline' })
    expect(recovered.done.ok, recovered.done.error).toBe(true)
    expect(await page.evaluate(() => (window as any).__weftcutExportPerf.totalFrames)).toBe(180)
  } finally { await app.close() }
})

test('native admission timeout offers resource recovery instead of a generic encoder error', async ({}, testInfo) => {
  const { app, page } = await launchApp({ locale: 'zh-CN' })
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-native-busy-'), name: 'Native busy', canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    const trackId = await invokeCmd<string>(page, 'add_track')
    await invokeCmd(page, 'add_color_layer', { trackId, color: { r: 255, g: 0, b: 0, a: 1 }, tStartUs: 0, durationUs: 1_000_000 })
    const settings = await invokeCmd<any>(page, 'app_settings_get')
    await app.evaluate((_electron, { addon, allocation }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      native.resourcesConfigure(JSON.stringify({ ...allocation, cpu_threads: 1, task_threads: 1, background_jobs: 1 }))
      ;(globalThis as any).__busyProcessingReservation = native.resourcesReserve(1, 64)
    }, { addon, allocation: settings.resource_allocation })
    const result = await driveExport(page, { outputAbsPath: path.join(tmpDir('weftcut-native-busy-out-'), 'out.mp4'), settings: { encoderEngine: 'native', audio: { include: false } } }, { hook: 'exportTimeline' })
    await testInfo.attach('native-admission-timeout', { body: JSON.stringify(result), contentType: 'application/json' })
    expect(result.done.ok).toBe(false)
    expect(result.done.error).toContain('resource-capacity-exceeded')
    await expect(page.locator('.export-progress-status')).toContainText('请等待其他处理任务结束后重试')
    await expect(page.locator('.export-progress-panel').getByRole('button', { name: '打开设置', exact: true })).toBeVisible()
  } finally {
    try {
      await app.evaluate((_electron, addon) => {
        const native = process.getBuiltinModule('module').createRequire(addon)(addon)
        const id = (globalThis as any).__busyProcessingReservation
        if (Number.isInteger(id)) native.resourcesRelease(id)
      }, addon)
    } finally { await app.close() }
  }
})
