import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, driveExport, importAndPlaceMedia, invokeCmd, tmpDir } from './helpers/driver'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
const media = process.env.WEFTCUT_TEST_MEDIA || fileURLToPath(new URL('../fixtures/media/', import.meta.url))

for (const audioOnly of [true, false]) test(`export completes with one processing slot (audioOnly=${audioOnly})`, async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-single-slot-'), name: 'One slot', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    const settings = await invokeCmd<any>(page, 'app_settings_get')
    // Pin the native governor to the automatic allocation of a 3-core host,
    // independently of the machine running this regression. Keep real memory
    // admission and the app's import/export implementations enabled.
    await app.evaluate((_electron, { addon, allocation }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      native.resourcesConfigure(JSON.stringify({ ...allocation, cpu_threads: 1, task_threads: 1, background_jobs: 1 }))
    }, { addon, allocation: settings.resource_allocation })
    await page.evaluate(() => {
      const state = window as any
      state.__singleSlotImports = []
      window.api.on('import:complete', payload => state.__singleSlotImports.push(payload))
    })
    const imported = await importAndPlaceMedia(page, {
      mediaAbsPath: path.join(media, audioOnly ? 'test_tones_10s.wav' : 'test_1080p_30fps_audio.mp4'),
    })
    // The real workspace copy must complete, not fail its nested admission
    // timeout and merely unblock the export after releasing the outer lease.
    await expect.poll(() => page.evaluate(() => (window as any).__singleSlotImports.length), { timeout: 10_000 }).toBe(1)
    await page.evaluate(mediaId => (window as any).__weftcutTest.waitMediaExportReady({ mediaId }), imported.mediaId)
    const result = await driveExport(page, {
      outputAbsPath: path.join(tmpDir('weftcut-single-slot-out-'), audioOnly ? 'out.m4a' : 'out.mp4'),
      settings: { includeVideo: !audioOnly, includeAudio: true },
    }, { hook: 'exportTimeline' })
    expect(result.done.ok, result.done.error).toBe(true)
  } finally { await app.close() }
})
