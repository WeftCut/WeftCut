import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { invokeCmd, newProject, launchApp, rootSummary, tmpDir, waitForHook, type ProjectSummary } from './helpers/driver'

test('imports fictional 48 kHz mono audio and a differently sized PNG as an editable overlay after review', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-illustrated-story-stills-')
  const source = join(folder, 'Illustrated Story.fcpxml')
  const audio = join(folder, 'Narration.wav')
  const png = join(folder, 'Mouth.png')
  const destination = join(folder, 'Imported Illustrated Story')

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
    '-ac', '1', '-c:a', 'pcm_s16le', audio,
  ], { windowsHide: true })
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:size=120x130:rate=1', '-frames:v', '1', '-update', '1', png,
  ], { windowsHide: true })

  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1/60s" width="320" height="240"/>
    <format id="still" name="FFVideoFormatRateUndefined" width="640"/>
    <format id="still-clip" name="Still clip" frameDuration="1/24s"/>
    <asset id="voice" name="Narration.wav" start="0s" duration="2s" hasAudio="1" audioSources="1" audioChannels="1">
      <media-rep kind="original-media" src="${pathToFileURL(audio).href}"/>
    </asset>
    <asset id="mouth" name="Mouth.png" start="0s" duration="0s" hasVideo="1" videoSources="1" format="still">
      <media-rep kind="original-media" src="${pathToFileURL(png).href}"/>
    </asset>
  </resources>
  <library><event name="Illustrated Story"><project name="Illustrated Story test">
    <sequence format="f" duration="120/60s" tcStart="0s" tcFormat="NDF" audioLayout="mono" audioRate="48k">
      <spine><gap offset="0s" start="0s" duration="120/60s">
        <asset-clip ref="voice" lane="-1" offset="0s" start="0s" duration="120/60s" audioRole="narration.guide"/>
        <video ref="mouth" format="still-clip" lane="1" name="A" offset="30/60s" start="0s" duration="60/60s"/>
      </gap></spine>
    </sequence>
  </project></event></library>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: 'Imported Illustrated Story',
      canvas: { width: 320, height: 240, fpsNum: 60, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Video clips 1.*Audio clips 1.*Media files 2/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await expect(review.getByText(/640 pixels wide, but this file is 120 × 130/)).toBeVisible()
    await expect(review.getByText(/WeftCut reads the dimensions from the image file/)).toBeVisible()
    await expect(review.getByText(/Its duration comes from the timeline/)).toBeVisible()
    await expect(review.getByText(/narration.guide.*This clip will use Dialogue in the mixer/)).toBeVisible()
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await waitForHook(page, 'getSelectedLayerIds')
    const imported = await rootSummary<ProjectSummary>(page)
    expect(imported).toMatchObject({ fps_num: 60, fps_den: 1, duration_us: 2_000_000, layer_count: 3 })
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const root: any = Object.values(project.compositions).find((c: any) => c.id !== project.root_id)
    const layers = root.tracks.flatMap((track: { layers: { params: { kind: string }; t_start_us: number; t_end_us: number }[] }) => track.layers)
    expect(layers.map((layer: { params: { kind: string } }) => layer.params.kind).sort()).toEqual(['Audio', 'ImageOverlay'])
    expect(layers.find((layer: { params: { kind: string } }) => layer.params.kind === 'Audio'))
      .toMatchObject({ t_start_us: 0, t_end_us: 2000000, params: { role: 'dialogue' } })
    expect(layers.find((layer: { params: { kind: string } }) => layer.params.kind === 'ImageOverlay'))
      .toMatchObject({ t_start_us: 500000, t_end_us: 1500000 })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(700000))
    await expect.poll(async () => page.evaluate(async () => {
      const sample = (x: number) => (window as any).__weftcutTest.weftcutSampleComposite(x, 120)
      const isRed = (pixel: Awaited<ReturnType<typeof sample>>) => pixel != null && pixel.r > 150 && pixel.g < 50 && pixel.b < 50
      const isBlack = (pixel: Awaited<ReturnType<typeof sample>>) => pixel != null && pixel.r < 32 && pixel.g < 32 && pixel.b < 32
      return isRed(await sample(75)) && isRed(await sample(245)) && isBlack(await sample(30)) && isBlack(await sample(290))
    })).toBe(true)
  } finally { await app.close() }
})

test('offers a replacement for a TIFF the editor cannot display and keeps its timeline interval', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-still-relink-')
  const source = join(folder, 'Signal.fcpxml')
  const tiff = join(folder, 'Signal.tiff')
  const png = join(folder, 'Signal.png')
  const destination = join(folder, 'Signal Edit')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:size=120x130:rate=1', '-frames:v', '1', '-update', '1', tiff], { windowsHide: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', tiff,
    '-frames:v', '1', '-update', '1', png], { windowsHide: true })
  const original = readFileSync(tiff)
  writeFileSync(source, `<fcpxml version="1.10"><resources>
    <format id="f" frameDuration="1/30s" width="320" height="240"/>
    <asset id="a" name="Signal" duration="0s" hasVideo="1" colorSpaceOverride="sRGB IEC61966-2.1"
      src="${pathToFileURL(tiff).href}"/>
    </resources><project name="Signal Edit"><sequence format="f" duration="1s"><spine>
      <video ref="a" offset="15/30s" start="0s" duration="9/30s"/>
    </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await expect(page.getByRole('button', { name: 'Import timeline…' })).toBeVisible()
    await app.evaluate(({ dialog }, input) => {
      let next = input.source
      dialog.showOpenDialog = async (_window, options) => {
        if (options.properties?.includes('openDirectory')) return { canceled: false, filePaths: [input.folder] }
        const selected = next
        next = input.png
        return { canceled: false, filePaths: [selected] }
      }
    }, { source, png, folder })
    await page.getByRole('button', { name: 'Import timeline…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    const issue = page.getByRole('dialog', { name: 'Some media needs attention' })
    await expect(issue.getByText(/its editor cannot display it.*Save the image as a PNG.*keeps its timing/)).toBeVisible()
    expect(existsSync(destination)).toBe(false)
    await issue.getByRole('button', { name: 'Replace this file…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('The timeline declares sRGB for this image.')
    await expect(review).toContainText('Check media replacements')
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await review.getByRole('button', { name: 'Choose project location…' }).click()
    const setup = page.getByRole('dialog', { name: 'Create project from timeline' })
    await setup.getByRole('button', { name: 'Choose…', exact: true }).click()
    await setup.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(setup).toHaveCount(0)
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await waitForHook(page, 'weftcutSampleComposite')
    await expect.poll(async () => (await rootSummary<ProjectSummary>(page)).layer_count).toBe(2)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const root: any = Object.values(project.compositions).find((composition: any) => composition.id !== project.root_id)
    expect(root.tracks.flatMap((track: { layers: unknown[] }) => track.layers)).toMatchObject([
      { t_start_us: 500000, t_end_us: 800000, params: { kind: 'ImageOverlay' } },
    ])
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(650000))
    await expect.poll(async () => {
      const pixel = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return pixel != null && pixel.r > 150 && pixel.g < 50 && pixel.b < 50
    }).toBe(true)
    expect(readFileSync(tiff)).toEqual(original)
  } finally { await app.close() }
})
