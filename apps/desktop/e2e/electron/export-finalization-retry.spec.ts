import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, driveExport, invokeCmd, tmpDir, exportSsimFloor } from './helpers/driver'
import { analyze } from '../lib/analyze.mjs'

const media = fileURLToPath(new URL('../fixtures/media/test_1080p_30fps_audio.mp4', import.meta.url))
const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))

for (const action of ['retry', 'discard'] as const) {
  test(`encoded export survives critical-pressure mux failure and ${action}`, async ({}, testInfo) => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp({ locale: 'zh-CN' })
    try {
      await newProject(page, { parentFolder: tmpDir('weftcut-finalize-project-'), name: 'Finalize retry', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
      await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 2304 } } })
      const output = path.join(tmpDir('weftcut-finalize-output-'), 'finished.mp4')
      writeFileSync(output, 'previous complete output')
      await app.evaluate(({ ipcMain }, addon) => {
        const native = process.getBuiltinModule('module').createRequire(addon)(addon)
        const handler = ipcMain._invokeHandlers.get('backend:invoke')!
        let forcedCritical: boolean | null = null;
        const activity = native.resourcesActivity;
        native.resourcesActivity = (playing: boolean, pressure: boolean, critical: boolean) =>
          activity(playing, forcedCritical === null ? pressure : true, forcedCritical ?? critical)
        const trace = { mux: [] as any[], encodes: 0, audio: 0, releases: [] as string[], memory: [] as unknown[] }
        ;(globalThis as any).__finalizationTrace = trace
        let sampling = false
        const timer = setInterval(async () => {
          if (sampling || trace.memory.length >= 240) return
          sampling = true
          try { trace.memory.push({ at: Date.now(), ledger: JSON.parse(native.resourcesSnapshot()), ...await native.resourcesMemory() }) }
          finally { sampling = false }
        }, 500)
        timer.unref()
        ipcMain.on('resources:release', (_event, id) => trace.releases.push(id))
        ipcMain._invokeHandlers.set('backend:invoke', async (event: any, request: any) => {
          if (request.channel === 'export_video_sink_start') trace.encodes++
          if (request.channel === 'export_project_audio_only') trace.audio++
          if (request.channel !== 'mux_export') return handler(event, request)
          // Exercise the real continuation policy. The first two attempts see
          // critical host pressure; the third retains ordinary RSS pressure.
          forcedCritical = trace.mux.length < 2
          native.resourcesActivity(false, true, forcedCritical)
          const sample: any = { args: request.args, before: JSON.parse(native.resourcesSnapshot()) }
          trace.mux.push(sample)
          try { return await handler(event, request) }
          finally { sample.after = JSON.parse(native.resourcesSnapshot()) }
        })
      }, addon)
      const result = await driveExport(page, { mediaAbsPath: media, outputAbsPath: output,
        settings: { encoderEngine: 'native', decodeEngine: 'webcodecs', audio: { include: true } } })
      await testInfo.attach('initial-export-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
      expect(result.lastKind, result.lastDetail ?? undefined).toBe('error')
      const trace = () => app.evaluate(() => (globalThis as any).__finalizationTrace)
      const initial = await trace()
      await testInfo.attach('initial-finalization-trace', { body: JSON.stringify(initial, null, 2), contentType: 'application/json' })
      expect(initial.mux, result.done.error ?? result.lastDetail ?? undefined).toHaveLength(1)
      const { videoPath, audioPath, finalizationToken, audioRequired } = initial.mux[0].args
      expect(typeof finalizationToken).toBe('string')
      expect(audioRequired).toBe(true)
      expect(statSync(videoPath).size).toBeGreaterThan(0)
      expect(statSync(audioPath).size).toBeGreaterThan(0)
      expect(readFileSync(output, 'utf8')).toBe('previous complete output')
      const panel = page.locator('.export-progress-panel')
      await expect(panel.getByText(/无需重新编码/)).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('recoverable-export.png') })
      // Closing performance settings returns to the same retryable export.
      await panel.getByRole('button', { name: '打开设置', exact: true }).click()
      await expect(page.locator('#settings-panel-performance')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(panel.getByRole('button', { name: '重试完成导出' })).toBeVisible()
      await panel.getByRole('button', { name: '重试完成导出' }).click()
      await expect.poll(async () => (await trace()).mux.length).toBe(2)
      await expect(panel.getByRole('button', { name: '重试完成导出' })).toBeVisible()
      expect(existsSync(videoPath)).toBe(true)
      expect(existsSync(audioPath)).toBe(true)
      if (action === 'retry') {
        await panel.getByRole('button', { name: '重试完成导出' }).click()
        await page.waitForFunction(() => (window as any).__weftcutExportState?.kind === 'complete')
        const report = analyze({ output, source: media, samples: [0, 28, 58], ssimMin: exportSsimFloor() })
        expect(report.pass, JSON.stringify(report)).toBe(true)
        const probe = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', output], { encoding: 'utf8' })
        expect(probe.status, probe.stderr).toBe(0)
        expect(JSON.parse(probe.stdout).streams.map((s: any) => s.codec_type)).toEqual(['video', 'audio'])
      } else {
        await panel.getByRole('button', { name: '放弃导出' }).click()
        await expect(panel).toHaveCount(0)
        expect(readFileSync(output, 'utf8')).toBe('previous complete output')
      }
      const finished = await trace()
      expect(finished.encodes).toBe(1)
      expect(finished.audio).toBe(1)
      expect(finished.mux).toHaveLength(action === 'retry' ? 3 : 2)
      expect(finished.mux.every((m: any) => JSON.stringify(m.args) === JSON.stringify(initial.mux[0].args))).toBe(true)
      expect(finished.releases.filter((id: string) => id === finalizationToken)).toHaveLength(1)
      expect(existsSync(videoPath)).toBe(false)
      expect(existsSync(audioPath)).toBe(false)
      await testInfo.attach('finalization-trace', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' })
    } finally { await app.close() }
  })
}

test('failed stream-copy mux preserves an existing output and removes its staged file', async () => {
  const { app, page } = await launchApp()
  try {
    const folder = tmpDir('weftcut-mux-atomic-')
    const input = path.join(folder, 'invalid.mp4'), output = path.join(folder, 'existing.mp4')
    writeFileSync(input, 'invalid media')
    writeFileSync(output, 'previous complete output')
    await expect(invokeCmd(page, 'mux_export', { videoPath: input, audioPath: path.join(folder, 'none.m4a'), outputPath: output })).rejects.toThrow()
    expect(readFileSync(output, 'utf8')).toBe('previous complete output')
    await expect(invokeCmd(page, 'mux_export', { videoPath: media, audioPath: path.join(folder, 'none.m4a'), outputPath: output, audioRequired: true })).rejects.toThrow(/audio file is missing/)
    expect(readFileSync(output, 'utf8')).toBe('previous complete output')
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(folder).sort()).toEqual(['existing.mp4', 'invalid.mp4'])
  } finally { await app.close() }
})
