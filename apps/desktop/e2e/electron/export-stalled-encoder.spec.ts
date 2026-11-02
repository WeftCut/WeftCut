import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launchApp, newProject, driveExport, invokeCmd, tmpDir, forceCloseApp } from './helpers/driver'

// An encoder that stops responding (docs/export.md § Failure messages): the
// watchdog stops it, the export fails with its own message, and nothing is
// left to hold up quitting. The encoder is the E2E build's stand-in
// (WEFTCUT_E2E_STALLED_ENCODER_MS, src/main/exportE2EStall.ts): it never reads
// a frame, so the first frame write blocks until the watchdog fires at
// STALL_MS instead of the production limit.
const STALL_MS = 2000

test('a stalled encoder fails the export with its own message and the app still quits', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_E2E_STALLED_ENCODER_MS: String(STALL_MS) } })
  let closed = false
  try {
    // 640×360 frames are larger than any pipe buffer, so the write blocks.
    await newProject(page, { parentFolder: tmpDir('weftcut-stalled-encoder-'), name: 'Stalled encoder', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    const trackId = await invokeCmd<string>(page, 'add_track')
    await invokeCmd(page, 'add_color_layer', { trackId, color: { r: 1, g: 0, b: 0, a: 1 }, tStartUs: 0, durationUs: 1_000_000 })
    const started = Date.now()
    const result = await driveExport(page, {
      outputAbsPath: path.join(tmpDir('weftcut-stalled-encoder-out-'), 'out.mp4'),
      settings: { encoderEngine: 'native', audio: { include: false } },
    }, { hook: 'exportTimeline', timeout: 60_000 })
    const elapsedMs = Date.now() - started
    await testInfo.attach('stalled-encoder', { body: JSON.stringify({ elapsedMs, ...result }), contentType: 'application/json' })
    expect(result.done.ok).toBe(false)
    expect(result.done.error).toContain('ffmpeg-stalled')
    expect(elapsedMs).toBeLessThan(30_000)

    const panel = page.locator('.export-progress-panel')
    await expect(panel.locator('.export-progress-status')).toHaveText('The encoder stopped responding, so the export was stopped.')
    await expect(panel.locator('.export-progress-detail')).toContainText('set Video encoder to Software on the Video tab')
    await panel.getByText('Technical details', { exact: true }).click()
    await expect(panel.locator('pre')).toContainText('ffmpeg-stalled')

    // No export is left unfinished, so a graceful quit goes straight through
    // (a blocked one rejects with "graceful close timed out").
    await app.close()
    closed = true
  } finally {
    if (!closed) {
      forceCloseApp(app)
      await app.close().catch(() => {})
    }
  }
})
