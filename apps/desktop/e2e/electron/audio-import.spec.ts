import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, invokeCmd, newProject, rootSummary, tmpDir, type ProjectSummary } from './helpers/driver'

// Real codecs through the full import/copy/derivative path. In particular,
// MPEG-4 audio and attached cover pictures must never create video media.
test('audio imports retain their files and produce playable audio caches', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const folder = tmpDir('weftcut-audio-import-')
  const encode = (args: string[], destination: string) => execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', ...args, destination,
  ], { windowsHide: true })
  const cases: Array<[string, string]> = [
    ['tone.wav', 'pcm_s16le'], ['tone.mp3', 'libmp3lame'],
    ['tone.flac', 'flac'], ['tone.aac', 'aac'], ['tone.m4a', 'aac'],
    ['lossless.M4A', 'alac'], ['tone.ogg', 'libvorbis'], ['tone.opus', 'libopus'],
    ['audio-only.mp4', 'aac'],
  ]
  for (const [name, codec] of cases) encode([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-ar', codec === 'libopus' ? '48000' : '44100', '-ac', '2', '-c:a', codec,
  ], path.join(folder, name))
  const cover = path.join(folder, 'cover.jpg')
  encode(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1'], cover)
  for (const ext of ['m4a', 'mp3']) {
    const name = `covered.${ext}`
    encode(['-i', path.join(folder, `tone.${ext}`), '-i', cover,
      '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v:0', 'attached_pic'], path.join(folder, name))
    cases.push([name, ''])
  }
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: folder, name: 'Audio import', canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 },
    })
    const workspace = await invokeCmd<string>(page, 'workspace_dir')
    const root = await rootSummary<ProjectSummary>(page)
    // Derivative paths are runtime state, not project.wcpr fields (ADR 0175):
    // each one is read from the job that produced it.
    await page.evaluate(() => {
      const state = window as any
      state.__landed = {}
      window.api.on('media:job_complete', (payload: any) => {
        if (payload?.path) state.__landed[`${payload.media_id}:${payload.kind}`] = payload.path
      })
    })
    const landed = (id: string, kind: string) =>
      page.evaluate(([id, kind]) => (window as any).__landed[`${id}:${kind}`] as string | undefined ?? null, [id, kind])
    const trackId = root.tracks[0].id
    const ids: string[] = []
    for (const [name] of cases) {
      const id = await invokeCmd<string>(page, 'import_media', { path: path.join(folder, name) })
      ids.push(id)
      const pooled = async () => (await rootSummary<ProjectSummary>(page)).media.find(m => m.id === id)!
      await expect.poll(async () => {
        await invokeCmd(page, 'project_save')
        const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'project.wcpr'), 'utf8'))
        return Boolean(saved.media_pool[id].path_rel && await landed(id, 'conform') && await landed(id, 'waveform'))
      }, { timeout: 30_000, message: `${name}: copy, conform and waveform complete` }).toBe(true)
      const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'project.wcpr'), 'utf8'))
      const media = saved.media_pool[id]
      expect(media.kind, name).toBe('Audio')
      expect(media.label, name).toBe(name)
      expect(media.path_rel, `${name}: recorded as a project path`).toBe(`Media/${name}`)
      expect(media, `${name}: no absolute path in project.wcpr`).not.toHaveProperty('path_abs')
      const source = (await pooled()).path
      expect(source, name).toBe(path.join(workspace, 'Media', name))
      expect(digest(source), `${name}: workspace copy is byte-identical`).toBe(digest(path.join(folder, name)))
      expect(media.metadata.video, `${name}: cover is not a video track`).toBeNull()
      expect(media.metadata.audio.channels, name).toBe(2)
      expect(media.metadata.duration_us, name).toBeGreaterThan(900_000)
      expect(media.metadata.duration_us, name).toBeLessThan(1_200_000)
      expect(media.decode_route, name).toEqual({ route: 'bypass' })
      expect(await landed(id, 'thumbnails'), `${name}: audio gets no thumbnails`).toBeNull()
      const conform = (await landed(id, 'conform'))!
      expect((await pooled()).conform_path, name).toBe(conform)
      const pcm = fs.readFileSync(conform)
      expect(pcm.subarray(0, 8).toString(), name).toBe('VCONF\0\0\0')
      expect(pcm.readUInt32LE(12), name).toBe(48_000)
      expect(pcm.readUInt32LE(16), name).toBe(2)
      const frames = Number(pcm.readBigUInt64LE(20))
      expect(frames, name).toBeGreaterThan(43_200)
      expect(frames, name).toBeLessThan(57_600)
      expect(pcm.length, name).toBe(28 + frames * 2 * 4)
      let energy = 0
      for (let offset = 28; offset < pcm.length; offset += 4) energy += pcm.readFloatLE(offset) ** 2
      expect(Math.sqrt(energy / (frames * 2)), `${name}: audible, finite PCM`).toBeGreaterThan(0.03)
      expect(fs.statSync((await landed(id, 'waveform'))!).size, name).toBeGreaterThan(32)
      await expect(page.locator(`[data-media-id="${id}"] .media-audio-glyph`)).toBeAttached()
      const layerId = await invokeCmd<string>(page, 'add_media_layer', { trackId, mediaId: id, tStartUs: (ids.length - 1) * 2_000_000 })
      const placed = await rootSummary<ProjectSummary>(page)
      const layers = placed.tracks.flatMap(t => t.layers)
      expect(layers.find(l => l.id === layerId)?.params.kind, name).toBe('Audio')
      expect(layers.length, `${name}: no paired video layer`).toBe(ids.length)
    }
    for (const layout of ['large', 'grid', 'list']) {
      await invokeCmd(page, 'app_settings_set', { patch: { media_pool_layout: layout } })
      const row = page.locator(`[data-media-id="${ids[4]}"]`)
      await row.scrollIntoViewIfNeeded()
      const glyph = row.locator('.media-audio-glyph')
      await expect(glyph).toBeVisible()
      const box = await glyph.boundingBox()
      expect(box!.width).toBeGreaterThan(8)
      expect(box!.height).toBeGreaterThan(8)
      await page.screenshot({ path: testInfo.outputPath(`audio-pool-${layout}.png`) })
    }
    await invokeCmd(page, 'project_save')
    await invokeCmd(page, 'project_open', { path: workspace })
    const summary = await invokeCmd<{ media: Array<{ id: string; kind: string; label: string }> }>(page, 'project_summary')
    expect(summary.media.map(m => m.id).sort()).toEqual(ids.sort())
    expect(summary.media.every(m => m.kind === 'Audio')).toBe(true)
  } finally { await app.close() }
})
