import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, invokeCmd, tmpDir } from './helpers/driver'

test('reopening adopts audio caches without rebuilding and close ends import admission', async () => {
  const folder = tmpDir('weftcut-import-reopen-')
  const source = path.join(folder, 'source.wav')
  const wav = Buffer.alloc(96044)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(96000, 40); fs.writeFileSync(source, wav)
  const { app, page } = await launchApp()
  try {
    const workspace = await invokeCmd<string>(page, 'project_new_workspace', {
      parentFolder: folder, name: 'reopen', width: 320, height: 240, fpsNum: 30, fpsDen: 1,
    })
    await page.evaluate(() => {
      const state = window as any
      state.__importEvents = []
      for (const event of ['media:job_started', 'media:job_complete', 'media:job_error', 'import:complete']) {
        window.api.on(event, (payload: unknown) => state.__importEvents.push({ event, payload }))
      }
    })
    const mediaId = await invokeCmd<string>(page, 'import_media', { path: source })
    const events = () => page.evaluate(() => (window as any).__importEvents as Array<{ event: string; payload: any }>)
    await expect.poll(async () => (await events()).filter(e => e.event === 'media:job_complete').length).toBe(2)
    await expect.poll(async () => (await events()).some(e => e.event === 'import:complete')).toBe(true)
    expect((await events()).filter(e => e.event === 'media:job_error')).toEqual([])
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'project.json'), 'utf8'))
    const media = saved.media_pool[mediaId]
    expect(media.path_rel).toBeTruthy()
    const before = [media.conform_path, media.waveform_path].map(p => fs.statSync(p).mtimeMs)
    await page.evaluate(() => { (window as any).__importEvents = [] })
    await invokeCmd(page, 'project_open', { path: workspace })
    await expect.poll(async () => (await events()).filter(e => e.event === 'media:job_complete').length).toBe(2)
    expect((await events()).filter(e => e.event === 'media:job_started' || e.event === 'media:job_error')).toEqual([])
    expect([media.conform_path, media.waveform_path].map(p => fs.statSync(p).mtimeMs)).toEqual(before)
    await invokeCmd(page, 'project_close')
    await expect(invokeCmd(page, 'import_media', { path: source })).rejects.toThrow(/cancelled|closed|project/i)
  } finally { await app.close() }
})
