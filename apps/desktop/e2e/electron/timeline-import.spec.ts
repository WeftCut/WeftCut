import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { driveExport, invokeCmd, launchApp, newProject, rootSummary, tmpDir, waitForHook, type ProjectSummary, type ProjectSummaryWire } from './helpers/driver'

function encodeSource(media: string) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "nullsrc=s=320x240:r=30000/1001,geq=lum='if(eq(N,7),235,16)':cb=128:cr=128",
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.001',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', media,
  ], { windowsHide: true })
}


async function beginImport(page: Page, kind: "file" | "bundle" = "file") {
  await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
  await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
  await page.getByRole("button", { name: "Choose FCPXML " + kind + "…" }).click()
}

async function importedSummary(page: Page): Promise<ProjectSummary> {
  const project = await invokeCmd<ProjectSummaryWire>(page, 'project_summary')
  const imported = Object.values(project.compositions).filter(c => c.id !== project.root_id)
  expect(imported).toHaveLength(1)
  const composition = imported[0]!
  return { ...project, ...composition,
    layer_count: composition.tracks.reduce((count, track) => count + track.layers.length, 0) }
}

function importedComposition(project: any): any {
  const imported = Object.values(project.compositions).filter((c: any) => c.id !== project.root_id)
  expect(imported).toHaveLength(1)
  return imported[0]
}

test('imports an editable FCPXML composition and refuses missing or changed media', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-')
  const source = join(folder, 'Glass Garden.fcpxml')
  const media = join(folder, 'Garden Take.mov')
  const destination = join(folder, 'Imported Garden')
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" start="3600s" duration="1001/1000s" hasVideo="1" hasAudio="1"
        audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Glass Garden">
    <sequence format="f" duration="6006/30000s" tcStart="0s" tcFormat="NDF">
      <spine>
        <asset-clip ref="a" name="Glass" start="108002002/30000s" duration="3003/30000s">
          <marker value="Cue" start="108003003/30000s" duration="1001/30000s"/>
          <marker value="Before the cut" note="Keep this beat" start="108004900/30000s" duration="0s"/>
        </asset-clip>
        <gap offset="3003/30000s" duration="1001/30000s"/>
        <asset-clip ref="a" name="Garden" offset="4004/30000s" start="108006006/30000s" duration="2002/30000s"/>
      </spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, { source, destination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination })
    await beginImport(page)
    await expect(page.getByText(/Missing or unreadable original media/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    expect(await invokeCmd(page, 'project_open_state')).not.toBeNull()

    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    encodeSource(media)

    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Video clips 2.*Audio clips 2.*Markers 2.*Media files 1/)).toBeVisible()
    await expect(review.getByText(/Before the cut.*last frame of its clip/)).toBeVisible()
    await expect(review.getByText(/Before the cut.*independent marker/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    expect(await invokeCmd(page, 'project_open_state')).not.toBeNull()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toHaveCount(0)
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)

    await beginImport(page)
    await expect(review).toBeVisible()
    const moved = join(folder, 'Moved Take.mov')
    renameSync(media, moved)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review.getByRole('alert')).toContainText('Original media changed or became unreadable')
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    renameSync(moved, media)
    await review.getByRole('button', { name: 'Review timeline again…' }).click()
    await expect(review.getByText('Glass Garden', { exact: true })).toBeVisible()

    writeFileSync(source, readFileSync(source, 'utf8').replace('name="Glass Garden"', 'name="Revised Garden"'))
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review.getByRole('alert')).toContainText('The FCPXML file changed')
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Review timeline again…' }).click()
    await expect(review.getByText('Revised Garden', { exact: true })).toBeVisible()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await waitForHook(page, 'getSelectedLayerIds')
    const imported = await importedSummary(page)
    expect(imported).toMatchObject({ fps_num: 30000, fps_den: 1001, duration_us: 200200, layer_count: 4 })
    expect(imported.media).toHaveLength(1)
    expect(imported.links).toHaveLength(2)
    const markers = [
      { t_us: 33367, label: 'Cue' },
      { t_us: 66733, label: 'Before the cut', note: 'Keep this beat', anchor_layer: null, hibernating: false },
    ]
    expect(imported.markers).toMatchObject(markers)
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(133467))
    const sample = () => page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
    await expect.poll(async () => (await sample())?.r ?? 255).toBeLessThan(32)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(166833))
    await expect.poll(async () => (await sample())?.r ?? 0).toBeGreaterThan(200)
    const video = imported.tracks[0]!.layers.find((layer) => layer.params.kind === 'VideoClip')!
    await invokeCmd(page, 'update_layer', { layerId: video.id, patch: { label: 'Glass edit' } })
    const projectFile = join(destination, 'project.json')
    await expect.poll(async () => {
      await invokeCmd(page, 'project_save')
      const saved = JSON.parse(readFileSync(projectFile, 'utf8'))
      const item = saved.media_pool[imported.media[0]!.id]
      return item.path_rel ? readFileSync(item.path_abs).equals(readFileSync(media)) : false
    }, { timeout: 30_000 }).toBe(true)
    const saved = JSON.parse(readFileSync(projectFile, 'utf8'))
    expect(JSON.stringify(saved)).toContain('Glass edit')
    const metadata = saved.media_pool[imported.media[0]!.id].metadata
    expect(metadata.video).not.toHaveProperty('duration_us')
    expect(metadata.audio).not.toHaveProperty('duration_us')
    await invokeCmd(page, 'project_open', { path: destination })
    expect(await importedSummary(page)).toMatchObject({ duration_us: 200200, layer_count: 4, markers })
  } finally { await app.close() }
})

test('verifies variable-rate in-points and preserves their selected pictures through export', async () => {
  test.setTimeout(150_000)
  const folder = tmpDir('weftcut-fcpxml-vfr-')
  const media = join(folder, 'Field Signal.mov')
  const xml = join(folder, 'Field Signal.fcpxml')
  const output = join(folder, 'Rendered Signal.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', "nullsrc=size=320x240:rate=30,geq=lum='if(eq(N,2),235,16)':cb=128:cr=128",
    '-vf', "settb=1/3000,setpts='if(lt(N,2),N*100,N*100+10)'", '-frames:v', '6',
    '-fps_mode', 'vfr', '-enc_time_base', '1:3000', '-video_track_timescale', '3000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { windowsHide: true })
  writeFileSync(xml, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1/30s"/>
    <asset id="a" format="f" hasVideo="1" duration="1/5s" src="${pathToFileURL(media).href}"/>
    </resources><project name="Field Signal"><sequence format="f" duration="2/30s"><spine>
    <asset-clip ref="a" start="7/100s" duration="1/30s"/>
    <asset-clip ref="a" offset="1/30s" start="8/100s" duration="1/30s"/>
    </spine></sequence></project></fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: 'Review Field Signal',
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, xml)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/timestamps confirm a frame at the requested source in-point/)).toBeVisible()
    await expect(review.getByText(/cut starts inside a displayed frame.*0.070000 s/)).toBeVisible()
    const commit = review.getByRole('button', { name: 'Import', exact: true })
    await expect(commit).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await commit.click()
    await expect(review).toHaveCount(0)
    const imported = await importedSummary(page)
    expect(imported.tracks.flatMap(track => track.layers)).toMatchObject([
      { t_start_us: 0, t_end_us: 33333, params: { kind: 'VideoClip', src_in_us: 70000 } },
      { t_start_us: 33333, t_end_us: 66667, params: { kind: 'VideoClip', src_in_us: 80000 } },
    ])
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    await expect.poll(async () => {
      const pixel = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return pixel != null && pixel.r > 200 && pixel.g > 200 && pixel.b > 200
    }).toBe(true)
    const result = await driveExport(page, { outputAbsPath: output, settings: { audio: { include: false } } }, { hook: 'exportTimeline' })
    expect(result.done).toMatchObject({ ok: true })
    const pixels = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output,
      '-vf', 'crop=2:2:160:120', '-frames:v', '2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true })
    expect(pixels).toHaveLength(24)
    expect([...pixels].every(channel => channel > 200)).toBe(true)
  } finally { await app.close() }
})

test('shows independent clip fixes alongside missing media in the source editor', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-structural-')
  const movedFolder = join(folder, 'Relocated')
  mkdirSync(movedFolder)
  const media = join(movedFolder, 'Recovered Signal.mov')
  const missing = join(folder, 'Offline', 'Signal.mov')
  const xml = join(folder, 'Signal.fcpxml')
  encodeSource(media)
  const clip = '<video ref="a" name="Alternate camera stream" srcID="2" offset="1001/30000s" start="1001/30000s" duration="1001/30000s"/>'
  const original = `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="a" format="f" hasVideo="1" duration="1001/1000s" src="${pathToFileURL(missing).href}"/>
    </resources><project name="Signal"><sequence format="f" duration="3003/30000s"><spine>
    <asset-clip ref="a" offset="0s" start="0s" duration="1001/30000s"/>
    ${clip}
    <asset-clip ref="a" name="Dock cut" offset="2002/30000s" start="6006/30000s" duration="1001/30000s" enabled="invalid"/>
    </spine></sequence></project></fcpxml>`
  writeFileSync(xml, original)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: 'Review Edit',
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      const selections = [input.xml, input.media]
      dialog.showOpenDialog = async () => {
        const path = selections.shift()
        return path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] }
      }
    }, { xml, media })
    await beginImport(page)
    const mediaIssues = page.getByRole('dialog', { name: 'Some media needs attention' })
    await expect(mediaIssues.getByText(/Missing or unreadable original media/)).toBeVisible()
    await expect(mediaIssues.getByText('Alternate camera stream', { exact: true })).toBeVisible()
    await expect(mediaIssues.getByText(/selects source stream 2/)).toBeVisible()
    await expect(mediaIssues.getByText('From frame 1 to the start of frame 2')).toBeVisible()
    await expect(mediaIssues.getByText('Dock cut', { exact: true })).toBeVisible()
    await expect(mediaIssues.getByText(/invalid enabled flag/)).toBeVisible()
    await expect(mediaIssues.getByText('From frame 2 to the start of frame 3')).toBeVisible()
    await mediaIssues.getByRole('button', { name: 'Replace this file…' }).click()
    const editIssues = page.getByRole('dialog', { name: 'Some edits need attention' })
    await expect(editIssues.getByText(/Export the selected stream as its own file/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    const revised = original.replace('id="a"', 'id="renumbered"').replaceAll('ref="a"', 'ref="renumbered"')
    writeFileSync(xml, revised)
    await editIssues.getByRole('button', { name: 'Review timeline again…' }).click()
    const retained = /kept your earlier choice of “Recovered Signal.mov”/
    await expect(editIssues.getByText(retained)).toBeVisible()
    writeFileSync(xml, revised.replace('srcID="2"', 'srcID="1"').replace('enabled="invalid"', 'enabled="1"'))
    await editIssues.getByRole('button', { name: 'Review timeline again…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(`${missing} → ${await realpath(media)}`, { exact: true })).toBeVisible()
    await expect(review.getByText(retained)).toBeVisible()
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    const imported = await importedSummary(page)
    expect(imported.tracks.flatMap(track => track.layers)).toMatchObject([
      { t_start_us: 0, t_end_us: 33367, params: { src_in_us: 0 } },
      { t_start_us: 33367, t_end_us: 66733, params: { src_in_us: 33366 } },
      { t_start_us: 66733, t_end_us: 100100, params: { src_in_us: 200200 } },
    ])
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(folder, 'Review Edit', 'project.json'), 'utf8'))
    const exactTrim = importedComposition(project).tracks.flatMap((track: any) => track.layers)
      .find((layer: any) => layer.label === 'Alternate camera stream')
    expect(exactTrim.params.source_phase.in).toEqual({ num: 2, den: 3 })
  } finally { await app.close() }
})

test('continues past an unplayably short audio trim only after review', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-short-audio-')
  const xml = join(folder, 'Short beat.fcpxml')
  const camera = join(folder, 'Camera.mov')
  const audio = join(folder, 'Offline click.wav')
  encodeSource(camera)
  writeFileSync(xml, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="v" format="f" hasVideo="1" hasAudio="1" duration="1001/1000s" src="${pathToFileURL(camera).href}"/>
    <asset id="a" hasAudio="1" duration="1s" src="${pathToFileURL(audio).href}"/>
    </resources><project name="Short beat"><sequence format="f" duration="3003/30000s"><spine>
      <asset-clip ref="v" offset="0s" srcEnable="video" duration="1001/30000s"/>
      <audio ref="a" name="Slate tick" offset="1001/30000s" start="0s" duration="1/1000000s">
        <marker value="Slate marker" note="Hold the beat" start="0s" duration="0s"/>
      </audio>
      <asset-clip ref="v" offset="2002/30000s" srcEnable="video" duration="1001/30000s"/>
    </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    const destination = join(folder, 'Imported Short Beat')
    await newProject(page, { parentFolder: folder, name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, xml)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    const omission = review.getByRole('region', { name: 'Audio edits too short to keep' })
    await expect(omission).toContainText('Slate tick')
    await expect(omission).toContainText(/Both audio edges land on the same 48 kHz sample/)
    await expect(omission).toContainText('From frame 1 to the start of frame 2')
    const confirm = review.getByRole('button', { name: 'Import', exact: true })
    await expect(confirm).toBeDisabled()
    await omission.getByRole('checkbox', { name: 'Import without these short audio edits' }).check()
    await confirm.click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    await invokeCmd(page, 'project_open', { path: destination })
    const project = await importedSummary(page)
    expect(project.duration_us).toBe(100100)
    expect(project.tracks.flatMap(track => track.layers)).toMatchObject([
      { t_start_us: 0, t_end_us: 33367, params: { kind: 'VideoClip' } },
      { t_start_us: 66733, t_end_us: 100100, params: { kind: 'VideoClip' } },
    ])
    expect(project.markers).toMatchObject([{ t_us: 33367, label: 'Slate marker', note: 'Hold the beat', anchor_layer: null }])
  } finally { await app.close() }
})

test('finds restored media and previews marked gaps together without moving the cuts', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-offline-gap-')
  const xml = join(folder, 'Observatory.fcpxml')
  const camera = join(folder, 'Camera.mov')
  const offline = join(folder, 'Missing Camera.mov')
  const secondOffline = join(folder, 'Missing Exterior.mov')
  const restored = join(folder, 'Restored Camera.mov')
  encodeSource(camera)
  writeFileSync(xml, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="v" format="f" hasVideo="1" hasAudio="1" duration="1001/1000s" src="${pathToFileURL(camera).href}"/>
    <asset id="o" format="f" hasVideo="1" duration="1001/1000s" src="${pathToFileURL(offline).href}"/>
    <asset id="exterior" format="f" hasVideo="1" duration="1001/1000s" src="${pathToFileURL(secondOffline).href}"/>
    <asset id="restored" format="f" hasVideo="1" hasAudio="1" duration="1001/1000s" src="${pathToFileURL(restored).href}"/>
    </resources><project name="Observatory"><sequence format="f" duration="5005/30000s"><spine>
      <asset-clip ref="v" srcEnable="video" name="Arrival" offset="0s" duration="1001/30000s"/>
      <asset-clip ref="o" name="Control room" offset="1001/30000s" duration="1001/30000s">
        <marker value="Check the light" start="0s" duration="0s"/>
      </asset-clip>
      <asset-clip ref="exterior" name="Exterior" offset="2002/30000s" duration="1001/30000s"/>
      <asset-clip ref="restored" srcEnable="video" name="Recovered shot" offset="3003/30000s" duration="1001/30000s"/>
      <asset-clip ref="v" srcEnable="video" name="Return" offset="4004/30000s" duration="1001/30000s"/>
    </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    const parentFolder = join(folder, 'ObservatoryReview'.repeat(5))
    mkdirSync(parentFolder)
    const destination = join(parentFolder, 'Imported Observatory')
    await newProject(page, { parentFolder, name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, xml)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.setMinimumSize(0, 0)
      window.setContentSize(520, 380)
    })
    await beginImport(page)
    const blocked = page.getByRole('dialog', { name: 'Some media needs attention' })
    await expect(blocked.getByRole('button', { name: 'Review with marked gaps for 3 media sources' })).toBeVisible()
    writeFileSync(restored, readFileSync(camera))
    await blocked.getByRole('button', { name: 'Review timeline again…' }).click()
    await blocked.getByRole('button', { name: 'Review with marked gaps for 2 media sources' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    const destinationPath = review.getByText(/ObservatoryReview.*Imported Observatory/)
    await expect(destinationPath).toBeVisible()
    const pathLayout = await destinationPath.evaluate((element) => {
      const text = document.createRange()
      text.selectNodeContents(element)
      const lines = Array.from(text.getClientRects())
      const bounds = element.getBoundingClientRect()
      return { lines: lines.length, contained: lines.every(line =>
        line.left >= bounds.left - 1 && line.right <= bounds.right + 1 &&
        line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1) }
    })
    expect(pathLayout.lines).toBeGreaterThan(1)
    expect(pathLayout.contained).toBe(true)
    const heading = review.getByRole('heading', { name: 'Review timeline import' })
    await expect(heading).toBeInViewport({ ratio: 1 })
    const confirm = review.getByRole('button', { name: 'Import', exact: true })
    await expect(confirm).toBeInViewport({ ratio: 1 })
    const lastClip = review.getByText(/^Return \(lane 0\)/)
    await lastClip.scrollIntoViewIfNeeded()
    await expect(lastClip).toBeInViewport({ ratio: 1 })
    await expect(heading).toBeInViewport({ ratio: 1 })
    await expect(confirm).toBeInViewport({ ratio: 1 })
    const gaps = review.getByRole('region', { name: 'Media to replace later' })
    await expect(gaps).toContainText('Control room')
    await expect(gaps).toContainText('From frame 1 to the start of frame 2')
    await expect(gaps).toContainText('Exterior')
    await expect(gaps).toContainText('From frame 2 to the start of frame 3')
    await expect(gaps).not.toContainText('Recovered shot')
    await expect(confirm).toBeDisabled()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await gaps.getByRole('checkbox', { name: 'Import with the marked gaps shown above' }).check()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    await invokeCmd(page, 'project_open', { path: destination })
    const imported = await importedSummary(page)
    expect(imported.duration_us).toBe(166833)
    expect(imported.tracks.flatMap(track => track.layers)).toMatchObject([
      { label: 'Arrival', t_start_us: 0, t_end_us: 33367 },
      { label: 'Recovered shot', t_start_us: 100100, t_end_us: 133467 },
      { label: 'Return', t_start_us: 133467, t_end_us: 166833 },
    ])
    expect(imported.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Replace media — Control room', t_us: 33367, end_t_us: 66733, anchor_layer: null }),
      expect.objectContaining({ label: 'Check the light', t_us: 33367, anchor_layer: null }),
      expect.objectContaining({ label: 'Replace media — Exterior', t_us: 66733, end_t_us: 100100, anchor_layer: null }),
    ]))
    expect(imported.media).toHaveLength(1)
  } finally { await app.close() }
})

test('offers an available proxy for an offline original and imports only after approval', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-proxy-')
  const original = join(folder, 'Offline Original.mov')
  const proxy = join(folder, 'Review Copy.mov')
  const xml = join(folder, 'Signal.fcpxml')
  encodeSource(proxy)
  writeFileSync(xml, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="a" format="f" hasVideo="1" duration="1001/1000s">
      <media-rep kind="original-media" src="${pathToFileURL(original).href}"/>
      <media-rep kind="proxy-media" src="${pathToFileURL(proxy).href}"/>
    </asset></resources><project name="Proxy Edit"><sequence format="f" duration="3003/30000s"><spine>
    <asset-clip ref="a" srcEnable="video" start="6006/30000s" duration="3003/30000s"/>
    </spine></sequence></project></fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: 'Review Proxy',
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, xml)
    await beginImport(page)
    const blocked = page.getByRole('dialog', { name: 'Some media needs attention' })
    await expect(blocked.getByText(/Missing or unreadable original media/)).toBeVisible()
    await blocked.getByRole('button', { name: 'Review proxy Review Copy.mov…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/selected file is a proxy.*editing and export/)).toBeVisible()
    const commit = review.getByRole('button', { name: 'Import', exact: true })
    await expect(commit).toBeDisabled()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await commit.click()
    await expect(review).toHaveCount(0)
    const imported = await importedSummary(page)
    expect(imported).toMatchObject({ duration_us: 100100, layer_count: 1 })
    expect(imported.tracks.flatMap(track => track.layers)).toMatchObject([
      { t_start_us: 0, t_end_us: 100100, params: { kind: 'VideoClip', src_in_us: 200200, src_out_us: 300300 } },
    ])
    expect(existsSync(original)).toBe(false)
  } finally { await app.close() }
})

test('keeps tagged Rec. 601 video editable and discloses its SDR output conversion', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-sdr-')
  const media = join(folder, 'Signal.mov')
  const xml = join(folder, 'Signal.fcpxml')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:size=320x240:rate=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', media], { windowsHide: true })
  writeFileSync(xml, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1/30s" colorSpace="6-1-6 (Rec. 601 NTSC)"/>
    <asset id="a" format="f" hasVideo="1" duration="1s" src="${pathToFileURL(media).href}"/>
    </resources><project name="Signal"><sequence format="f" duration="1s"><spine>
    <asset-clip ref="a" start="0s" duration="1s"/>
    </spine></sequence></project></fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: 'Review SDR',
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, xml)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/source timeline uses Rec. 601 NTSC.*use SDR Rec. 709/)).toBeVisible()
    const commit = review.getByRole('button', { name: 'Import', exact: true })
    await expect(commit).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await commit.click()
    await expect(review).toHaveCount(0)
    expect(await importedSummary(page)).toMatchObject({ duration_us: 1_000_000, layer_count: 1 })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(300000))
    await expect.poll(async () => {
      const pixel = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return pixel != null && pixel.r > 200 && pixel.g < 35 && pixel.b < 35
    }).toBe(true)
  } finally { await app.close() }
})

test('imports from the startup screen into a new editable project at the sequence rate', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-startup-import-')
  const source = join(folder, 'Harbour Lights.fcpxml')
  const media = join(folder, 'Harbour.mov')
  const target = join(folder, 'Harbour Lights')
  encodeSource(media)
  writeFileSync(source, `<fcpxml version="1.10"><resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000" src="${pathToFileURL(media).href}"/>
    </resources><project name="Harbour Lights"><sequence format="f" duration="1001/10000s"><spine>
    <asset-clip ref="a" duration="1001/10000s"/>
    </spine></sequence></project></fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ dialog }, { source, folder }) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false, filePaths: [options?.properties?.includes('openDirectory') ? folder : source],
      })
    }, { source, folder })
    const startupImport = page.getByRole('button', { name: 'Import timeline…', exact: true })
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    const create = page.getByRole('dialog', { name: 'Create project from timeline' })
    const reviewAndChooseLocation = async () => {
      await startupImport.click()
      await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
      await expect(review.getByText(/Video clips 1.*Media files 1/)).toBeVisible()
      await review.getByRole('button', { name: 'Choose project location…' }).click()
      await expect(create.getByRole('textbox', { name: 'Project name' })).toHaveValue('Harbour Lights')
      await create.getByRole('button', { name: 'Choose…', exact: true }).click()
    }
    await reviewAndChooseLocation()
    await create.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(startupImport).toBeVisible()
    expect(existsSync(target)).toBe(false)
    expect(await invokeCmd(page, 'project_open_state')).toBeNull()

    await newProject(page, { parentFolder: folder, name: 'Other Project',
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Save and Close' }).click()
    await expect(startupImport).toBeVisible()

    await reviewAndChooseLocation()
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await waitForHook(page, 'getSelectedLayerIds')
    await expect(startupImport).toHaveCount(0)
    expect(await rootSummary<ProjectSummary>(page)).toMatchObject({ fps_num: 30000, fps_den: 1001 })
    expect(await importedSummary(page)).toMatchObject({ fps_num: 30000, fps_den: 1001, layer_count: 2 })
    expect(readFileSync(join(target, 'project.json'), 'utf8')).toContain('Harbour Lights')
    await invokeCmd(page, 'project_undo')
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await invokeCmd(page, 'project_redo')
    expect((await importedSummary(page)).layer_count).toBe(2)
  } finally { await app.close() }
})

test('conforms 25 fps 640×360 camera footage into a 30 fps 320×240 edit with correct preview fit', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-mixed-camera-')
  const source = join(folder, 'Camera Cut.fcpxml')
  const media = join(folder, 'Camera.mov')
  const destination = join(folder, 'Imported Camera Cut')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="seq" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Camera Cut">
    <sequence format="seq" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Video clips using source-timestamp frame-rate conform: 1')
    await expect(review).toContainText('Video clips with source-size or spatial-conform adjustments: 1')
    await expect(review).toContainText('Camera.mov')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    const summary = await importedSummary(page)
    expect(summary).toMatchObject({ fps_num: 30, fps_den: 1, duration_us: 100000, layer_count: 1 })
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clip = importedComposition(saved).tracks.flatMap(
      (t: { layers: unknown[] }) => t.layers,
    ).find((layer: any) => layer.params.kind === 'VideoClip')
    expect(clip.params.transform).toMatchObject({
      position: { x: { mode: 'Static', value: 160 }, y: { mode: 'Static', value: 120 } },
      scale_x: { mode: 'Static', value: 0.5 },
      scale_y: { mode: 'Static', value: 0.5 },
    })
    expect(clip.params.src_in_us).toBe(40000)
    expect(clip.params.src_out_us).toBe(140000)
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    const sample = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), { x, y })
    await expect.poll(async () => (await sample(160, 120))?.r ?? 0).toBeGreaterThan(180)
    await expect.poll(async () => (await sample(160, 10))?.r ?? 255).toBeLessThan(80)
  } finally { await app.close() }
})

test('selects one of multiple FCPXML project sequences and leaves the others unimported', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-multi-sequence-')
  const source = join(folder, 'Multiple.fcpxml')
  const media = join(folder, 'Shared.mov')
  const destination = join(folder, 'Chosen Sequence')
  encodeSource(media)
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <library>
    <event name="Drafts">
      <project name="Unusable Draft">
        <sequence format="f" duration="3003/30000s">
          <spine><transition name="Complex Fade" duration="3003/30000s"/></spine>
        </sequence>
      </project>
    </event>
    <event name="Approved">
      <project name="Final Export">
        <sequence format="f" duration="3003/30000s">
          <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const picker = page.getByRole('dialog', { name: 'Choose a timeline to import' })
    await expect(picker).toContainText('2 timelines')
    await picker.getByRole('combobox', { name: 'Source timeline' }).click()
    await page.getByRole('option', { name: /Approved \/ Final Export/ }).click()
    await picker.getByRole('button', { name: 'Review selected timeline' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Final Export')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(2)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    expect(importedComposition(saved).label).toBe('Final Export')
  } finally { await app.close() }
})

test('fits non-square pixel aspect footage while preserving display geometry', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-pixel-aspect-')
  const source = join(folder, 'NonSquare.fcpxml')
  const media = join(folder, 'NonSquare.mov')
  const destination = join(folder, 'Imported NonSquare')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:s=640x360:r=25', '-vf', 'setsar=8/9',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="seq" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360" paspH="8" paspV="9"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="NonSquare">
    <sequence format="seq" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('SAR 8:9')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clip = importedComposition(saved).tracks.flatMap(
      (t: { layers: unknown[] }) => t.layers,
    ).find((layer: any) => layer.params.kind === 'VideoClip')
    expect(clip.params.transform).toMatchObject({
      scale_x: { mode: 'Static', value: 0.5 },
      scale_y: { mode: 'Static', value: 0.5625 },
    })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    const sample = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), { x, y })
    await expect.poll(async () => (await sample(160, 24))?.r ?? 0).toBeGreaterThan(180)
    await expect.poll(async () => (await sample(160, 10))?.r ?? 255).toBeLessThan(80)
  } finally { await app.close() }
})

test('keeps FCPXML fill conform and static audio gain as editable layer settings', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-adjustment-import-')
  const source = join(folder, 'Adjusted.fcpxml')
  const media = join(folder, 'Adjusted.mov')
  const destination = join(folder, 'Imported Adjusted')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:s=640x360:r=25', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="seq" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Adjusted">
    <sequence format="seq" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s">
        <adjust-conform type="fill"/><adjust-volume amount="-6dB"/>
      </asset-clip></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Spatial conform: fill the canvas')
    await expect(review).toContainText('Static clip gain: -6dB')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clips = importedComposition(saved).tracks.flatMap((t: { layers: unknown[] }) => t.layers)
    const video = clips.find((layer: any) => layer.params.kind === 'VideoClip')
    const audio = clips.find((layer: any) => layer.params.kind === 'Audio')
    expect(video.params.transform.scale_x.value).toBeCloseTo(2 / 3, 5)
    expect(video.params.transform.scale_y.value).toBeCloseTo(2 / 3, 5)
    expect(audio.params.gain_db).toMatchObject({ mode: 'Static', value: -6 })
  } finally { await app.close() }
})

test('renders FCPXML static position/scale and normal opacity without baking media', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-transform-import-')
  const source = join(folder, 'Moved Clip.fcpxml')
  const media = join(folder, 'Red Card.mov')
  const destination = join(folder, 'Imported Moved')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:s=320x240:r=30000/1001',
    '-t', '1.001', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="take" format="f" duration="1001/1000s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Moved Clip">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="take" start="0s" duration="3003/30000s">
        <adjust-transform position="25 0" scale="0.5 0.5" rotation="0"/>
        <adjust-blend amount="0.5" mode="0"/>
      </asset-clip></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Static position/scale/rotation')
    await expect(review).toContainText('Static opacity: 0.5')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clip = importedComposition(saved).tracks.flatMap((t: { layers: unknown[] }) => t.layers)
      .find((layer: any) => layer.params.kind === 'VideoClip')
    expect(clip.params).toMatchObject({
      opacity: { mode: 'Static', value: 0.5 },
      transform: {
        position: { x: { mode: 'Static', value: 220 }, y: { mode: 'Static', value: 120 } },
        scale_x: { mode: 'Static', value: 0.5 },
        scale_y: { mode: 'Static', value: 0.5 },
      },
    })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    const sample = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), { x, y })
    await expect.poll(async () => (await sample(220, 120))?.r ?? 0).toBeGreaterThan(70)
    await expect.poll(async () => (await sample(220, 120))?.a ?? 0).toBeGreaterThan(110)
    await expect.poll(async () => (await sample(220, 120))?.a ?? 255).toBeLessThan(145)
    await expect.poll(async () => (await sample(60, 120))?.a ?? 255).toBeLessThan(5)
  } finally { await app.close() }
})

test('imports a Final Cut 1.14 bundle with Info.fcpxml and reports its source', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-bundle-')
  const bundle = join(folder, 'Fictional Scene.fcpxmld')
  const media = join(folder, 'Scene.mov')
  const destination = join(folder, 'Imported Scene')
  mkdirSync(bundle)
  encodeSource(media)
  writeFileSync(join(bundle, 'Info.fcpxml'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.14">
  <import-options><option key="library location" value="file:///fictional/Library.fcpbundle"/></import-options>
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Fictional Scene">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, args) => {
      dialog.showOpenDialog = async (_window, options) => {
        const expected = process.platform === 'darwin' ? ['openDirectory', 'treatPackageAsDirectory'] : ['openDirectory']
        if (JSON.stringify(options.properties) !== JSON.stringify(expected)) throw new Error('Wrong picker for a bundle')
        return { canceled: false, filePaths: [args.bundle] }
      }
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: args.destination })
    }, { bundle, destination })
    await beginImport(page, "bundle")
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Source: FCPXML bundle')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(2)
    expect(existsSync(join(destination, 'project.json'))).toBe(true)
  } finally { await app.close() }
})

test('reviews missing media, a size mismatch, a title and an effect before importing', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-relink-flow-')
  const source = join(folder, 'Offline.fcpxml')
  const lost = join(folder, 'Old Disk', 'Scene.mov')
  const relocatedFolder = join(folder, 'Found Media')
  const actual = join(relocatedFolder, 'scene.mov')
  const destination = join(folder, 'Relinked Edit')
  const still = join(folder, 'Signal.png')
  mkdirSync(relocatedFolder)
  encodeSource(actual)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=120x130:rate=1',
    '-frames:v', '1', '-update', '1', still,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <format id="still" name="FFVideoFormatRateUndefined" width="640" height="360"/>
    <asset id="image" format="still" duration="0s" hasVideo="1" src="${pathToFileURL(still).href}"/>
    <asset id="a" uid="fictional-asset" format="f" duration="1001/30000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" sig="fictional-signature" src="${pathToFileURL(lost).href}"/>
    </asset>
  </resources>
  <project name="Offline">
    <sequence format="f" duration="4004/30000s">
      <spine><asset-clip ref="a" duration="3003/30000s" start="0s"><video ref="image" lane="1" offset="0s" duration="1001/30000s"/><filter-video name="Fictional Glow"/></asset-clip>
      <title ref="motion" name="End Card" offset="3003/30000s" duration="1001/30000s"><text><text-style>End of chapter</text-style></text></title></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async (_window, options) => {
        const pickingDirectory = options.properties?.length === 1 &&
          options.properties.includes('openDirectory')
        return { canceled: false, filePaths: [pickingDirectory ? input.relocatedFolder : input.source] }
      }
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, relocatedFolder, destination })
    await beginImport(page)
    const problems = page.getByRole('dialog', { name: 'Some media needs attention' })
    await expect(problems.getByText('Fictional Glow', { exact: true })).toBeVisible()
    await expect(problems.getByText('End Card', { exact: true })).toBeVisible()
    await expect(problems.getByText('From frame 3 to the start of frame 4')).toBeVisible()
    await problems.getByRole('button', { name: 'Review without these titles…' }).click()
    await expect(problems.getByText('Fictional Glow', { exact: true })).toBeVisible()
    await expect(problems.getByText(/Missing or unreadable original media/)).toBeVisible()
    await expect(problems.getByText(/640 × 360 pixels, but this file is 120 × 130/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await problems.getByRole('button', { name: 'Find original media in a folder…' }).click()
    await expect(problems.getByText(/Missing or unreadable original media/)).toBeVisible()
    await problems.getByRole('button', { name: 'Use scene.mov', exact: true }).click()
    const unsupported = page.getByRole('dialog', { name: 'Some edits need attention' })
    await expect(unsupported.getByText(/The file contains that material. WeftCut can keep the original cut times/)).toBeVisible()
    await expect(unsupported.getByText(/640 × 360 pixels, but this file is 120 × 130/)).toBeVisible()
    await unsupported.getByRole('button', { name: 'Review without these effects…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText(/Audio end moved \d+(?:\.\d+)? µs (earlier|later) to fit the 48 kHz sample grid/)
    await expect(review).toContainText('Check media replacements')
    await expect(review.getByRole('region', { name: 'Titles that will be left out' })).toContainText('End Card')
    await expect(review).toContainText('Source asset UID is not retained')
    await expect(review).toContainText('Source media signature is not retained')
    await expect(review.getByText(`${lost} → ${await realpath(actual)}`, { exact: true })).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Keep the clips and leave out these effects' }).check()
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Use these files with the differences shown above' }).check()
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('checkbox', { name: 'Leave out these titles and keep their timing' }).check()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(3)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const records = Object.values(project.media_pool) as { path_abs: string }[]
    expect(records.map(record => readFileSync(record.path_abs))).toEqual(expect.arrayContaining([
      readFileSync(actual), readFileSync(still),
    ]))
    const imported = (Object.values(project.compositions) as any[]).find(comp => comp.label === 'Offline')
    const layers = imported.tracks.flatMap((track: any) => track.layers)
    const video = layers.find((layer: any) => layer.params.kind === 'VideoClip')
    const audio = layers.find((layer: any) => layer.params.kind === 'Audio')
    expect(imported.duration_us).toBe(133467)
    const sequenceEnd = 100100
    const finalSample = Math.round(sequenceEnd * 48_000 / 1_000_000)
    expect(video).toMatchObject({ t_start_us: 0, t_end_us: sequenceEnd, params: { src_out_us: sequenceEnd } })
    expect(audio).toMatchObject({ t_start_us: 0, t_end_us: Math.round(finalSample * 1_000_000 / 48_000),
      params: { src_out_us: sequenceEnd } })
  } finally { await app.close() }
})

test('imports into the current project as one undoable Group without replacing its edit', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-current-import-')
  const source = join(folder, 'Short Scene.fcpxml')
  const media = join(folder, 'Scene.mov')
  const original = join(folder, 'Original')
  encodeSource(media)
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Short Scene">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: folder, name: 'Original',
      canvas: { width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 },
    })
    const originalFile = join(original, 'project.json')
    const before = JSON.parse(readFileSync(originalFile, 'utf8'))
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      // In-project importing MUST NOT ask for a project destination.
      dialog.showSaveDialog = async () => { throw new Error('Unexpected Save As dialog') }
    }, { source })

    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Compare project settings')
    await expect(review.getByText(/1920 × 1080/)).toBeVisible()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toHaveCount(0)
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)

    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    await expect(review).toBeVisible()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    // The project summary counts nested clips as well as the Group layer.
    await expect.poll(async () => (await rootSummary<ProjectSummary>(page)).layer_count).toBe(3)

    await invokeCmd(page, 'project_save')
    const after = JSON.parse(readFileSync(originalFile, 'utf8'))
    expect(after.project_id).toBe(before.project_id)
    expect(after.root_id).toBe(before.root_id)
    expect(Object.keys(after.compositions)).toHaveLength(2)
    const root = after.compositions[after.root_id]
    const groups = root.tracks.flatMap((track: { layers: { params: { kind: string } }[] }) => track.layers)
      .filter((layer: { params: { kind: string } }) => layer.params.kind === 'CompositionRef')
    expect(groups).toHaveLength(1)
    expect(Object.keys(after.media_pool)).toHaveLength(1)
    // The in-project media source is copied into the existing workspace,
    // not left as a dependency on a temporary external import folder.
    await expect.poll(async () => {
      await invokeCmd(page, 'project_save')
      const saved = JSON.parse(readFileSync(originalFile, 'utf8'))
      const item = Object.values(saved.media_pool)[0] as { path_rel: string | null; path_abs: string }
      return item.path_rel !== null && existsSync(item.path_abs) &&
        readFileSync(item.path_abs).equals(readFileSync(media))
    }, { timeout: 30_000 }).toBe(true)
    await invokeCmd(page, 'project_undo')
    await expect.poll(async () => (await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    expect((await invokeCmd(page, 'project_open_state'))).not.toBeNull()
  } finally { await app.close() }
})

test('keeps repeated compound clips editable with separate trims and one Undo', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-compound-import-')
  const source = join(folder, 'Repeated Scene.fcpxml')
  const media = join(folder, 'Source.mov')
  const target = join(folder, 'Imported Compounds')
  encodeSource(media)
  writeFileSync(source, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000" src="${pathToFileURL(media).href}"/>
    <media id="m" name="Shared Scene"><sequence format="f" tcStart="3600s" duration="30030/30000s">
      <spine><asset-clip ref="a" offset="3600s" duration="30030/30000s"/></spine>
    </sequence></media></resources>
    <project name="Repeated Scene"><sequence format="f"><spine>
      <ref-clip ref="m" name="First" start="108006006/30000s" duration="3003/30000s"/>
      <gap offset="3003/30000s" duration="1001/30000s"/>
      <ref-clip ref="m" name="Second" offset="4004/30000s" start="3600s" duration="3003/30000s"/>
    </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: basename(target),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText('2 compound clips become editable Groups.')).toBeVisible()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(target, 'project.json'), 'utf8'))
    const compositions = Object.values(saved.compositions) as any[]
    const outer = compositions.find(comp => comp.label === 'Repeated Scene')
    const shared = compositions.find(comp => comp.label === 'Shared Scene')
    expect(compositions).toHaveLength(3)
    expect(outer.tracks[0].layers).toMatchObject([
      { label: 'First', t_start_us: 0, t_end_us: 100100, params: { kind: 'CompositionRef', composition: shared.id, src_in_us: 200200 } },
      { label: 'Second', t_start_us: 133467, params: { kind: 'CompositionRef', composition: shared.id, src_in_us: 0 } },
    ])
    expect(shared.tracks[0].layers.map((layer: any) => layer.params.kind)).toEqual(['VideoClip', 'Audio'])
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33367))
    await expect.poll(async () => {
      const pixel = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return pixel?.r ?? 0
    }).toBeGreaterThan(200)
    await invokeCmd(page, 'project_undo')
    const undone = await invokeCmd<ProjectSummaryWire>(page, 'project_summary')
    expect(Object.keys(undone.compositions)).toHaveLength(1)
  } finally { await app.close() }
})

test('keeps overlapping split audio editable and linked without moving the picture cuts', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-split-audio-')
  const source = join(folder, 'Dialogue.fcpxml')
  const media = join(folder, 'Take.mov')
  const target = join(folder, 'Imported dialogue')
  encodeSource(media)
  writeFileSync(source, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1" src="${pathToFileURL(media).href}"/>
  </resources><project name="Dialogue"><sequence format="f"><spine>
    <asset-clip ref="a" name="Opening" start="0s" duration="3003/30000s" audioDuration="5005/30000s"/>
    <asset-clip ref="a" name="Reply" offset="3003/30000s" start="6006/30000s" duration="3003/30000s"
      audioStart="5005/30000s" audioDuration="4004/30000s"/>
  </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: basename(target),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Separate picture and sound trims/)).toHaveCount(2)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(target, 'project.json'), 'utf8'))
    const composition = importedComposition(project)
    const all = composition.tracks.flatMap((track: any) => track.layers)
    const video = all.filter((layer: any) => layer.params.kind === 'VideoClip')
    const audio = all.filter((layer: any) => layer.params.kind === 'Audio')
    expect(video.map((layer: any) => [layer.t_start_us, layer.t_end_us])).toEqual([[0, 100100], [100100, 200200]])
    expect(audio.map((layer: any) => [layer.params.src_in_us, layer.params.src_out_us])).toEqual([[0, 166833], [166833, 300300]])
    expect(audio[0].t_end_us).toBeGreaterThan(audio[1].t_start_us)
    expect(composition.tracks.filter((track: any) => track.layers.some((layer: any) => layer.params.kind === 'Audio'))).toHaveLength(2)
    expect(composition.links.map((link: any) => link.members)).toEqual(
      video.map((layer: any, index: number) => [layer.id, audio[index].id].sort()))
    await invokeCmd(page, 'project_undo')
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
  } finally { await app.close() }
})

test('imports the selected multicam picture and recorder audio as editable Group clips', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-multicam-import-')
  const source = join(folder, 'Field Notes.fcpxml')
  const camera = join(folder, 'Camera.mov')
  const recorder = join(folder, 'Recorder.wav')
  const destination = join(folder, 'Field Notes')
  encodeSource(camera)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '1', '-c:a', 'pcm_s16le', recorder,
  ], { windowsHide: true })
  writeFileSync(source, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="v" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1" src="${pathToFileURL(camera).href}"/>
    <asset id="a" duration="1s" hasAudio="1" src="${pathToFileURL(recorder).href}"/>
    <asset id="unused" format="f" duration="1s" hasVideo="1" src="file:///fictional/Unused.mov"/>
    <media id="m" name="Field Cameras"><multicam format="f" duration="1s">
      <mc-angle name="Wide camera" angleID="wide"><asset-clip ref="v" offset="0s" start="0s" duration="1s"/></mc-angle>
      <mc-angle name="Field recorder" angleID="sound"><asset-clip ref="a" offset="0s" start="0s" duration="1s"/></mc-angle>
      <mc-angle name="Alternate" angleID="alt"><asset-clip ref="unused" offset="0s" duration="1s"/></mc-angle>
    </multicam></media>
  </resources><project name="Field Notes"><sequence format="f"><spine>
    <mc-clip ref="m" name="Selected take" start="6006/30000s" duration="5005/30000s">
      <mc-source angleID="wide" srcEnable="video"/><mc-source angleID="sound" srcEnable="audio"/>
      <mc-source angleID="alt" srcEnable="none"/>
    </mc-clip>
  </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Wide camera (video), Field recorder (audio)')
    await expect(review).toContainText('Angle switching stays in the source editor')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const group = (Object.values(project.compositions) as any[]).find(comp => comp.label === 'Selected take')
    const layers = group.tracks.flatMap((track: any) => track.layers)
    const video = layers.find((layer: any) => layer.params.kind === 'VideoClip')
    const audio = layers.find((layer: any) => layer.params.kind === 'Audio')
    expect(video).toMatchObject({ t_start_us: 0, params: { src_in_us: 200200 } })
    expect(audio).toMatchObject({ t_start_us: 0, params: { src_in_us: 200200 } })
    expect(readFileSync(project.media_pool[video.params.media].path_abs)).toEqual(readFileSync(camera))
    expect(readFileSync(project.media_pool[audio.params.media].path_abs)).toEqual(readFileSync(recorder))
    expect(Object.keys(project.media_pool)).toHaveLength(2)
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33367))
    await expect.poll(async () => {
      const pixel = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return pixel?.r ?? 0
    }).toBeGreaterThan(200)
    await invokeCmd(page, 'project_undo')
    const undone = await invokeCmd<ProjectSummaryWire>(page, 'project_summary')
    expect(Object.keys(undone.compositions)).toHaveLength(1)
  } finally { await app.close() }
})

test('exports synchronized camera and recorder edits at the same authored instant', async () => {
  test.setTimeout(150_000)
  const folder = tmpDir('weftcut-synchronized-import-')
  const source = join(folder, 'Field Interview.fcpxml')
  const camera = join(folder, 'Camera.mov')
  const recorder = join(folder, 'Recorder.wav')
  const destination = join(folder, 'Field Interview')
  const output = join(folder, 'Field Interview.mp4')
  encodeSource(camera)
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', "aevalsrc=if(gte(n\\,12808)\\,0.3*sin(2*PI*880*t)\\,0):s=48000", '-t', '1',
    '-c:a', 'pcm_s16le', recorder], { windowsHide: true })
  writeFileSync(source, `<fcpxml version="1.10"><resources>
    <format id="f" width="320" height="240" frameDuration="1001/30000s"/>
    <asset id="v" format="f" start="600s" duration="1001/1000s" hasVideo="1" hasAudio="1" src="${pathToFileURL(camera).href}"/>
    <asset id="a" start="2s" duration="1s" hasAudio="1" src="${pathToFileURL(recorder).href}"/>
  </resources><project name="Field Interview"><sequence format="f" tcStart="60s"><spine>
    <sync-clip name="Slate take" offset="1801001/30000s" start="25025/30000s" duration="5005/30000s">
      <spine><asset-clip ref="v" offset="20020/30000s" start="600s" duration="12012/30000s" srcEnable="video"/></spine>
      <audio ref="a" lane="-1" offset="22022/30000s" start="21/10s" duration="12012/30000s"/>
    </sync-clip>
  </spine></sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    // A one-thread host must let a retimed export use its existing reservation.
    const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
    await app.evaluate((_electron, path) => {
      const native = process.getBuiltinModule('module').createRequire(path)(path)
      const configure = native.resourcesConfigure
      const oneThread = (json: string) => configure(JSON.stringify({ ...JSON.parse(json), cpu_threads: 1, task_threads: 1 }))
      native.resourcesConfigure = oneThread
      const readMemory = native.resourcesMemory
      native.resourcesMemory = async () => ({ ...await readMemory(), availableMib: 1024 })
    }, addon)
    await newProject(page, { parentFolder: folder, name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 2304 } } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Picture and sound keep their timing inside the Group')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const group = (Object.values(project.compositions) as any[]).find(comp => comp.label === 'Slate take')
    const layers = group.tracks.flatMap((track: any) => track.layers)
    expect(layers).toHaveLength(2)
    expect(layers.find((layer: any) => layer.params.kind === 'VideoClip')).toMatchObject({ t_start_us: 0, params: { src_in_us: 0 } })
    expect(layers.find((layer: any) => layer.params.kind === 'Audio')).toMatchObject({ t_start_us: 66729, params: { src_in_us: 100000 } })
    const imported = (Object.values(project.compositions) as any[]).find(comp => comp.label === 'Field Interview' && comp.id !== project.root_id)
    const take = imported.tracks[0].layers[0]
    expect(take).toMatchObject({ t_start_us: 33367, t_end_us: 200200,
      params: { composition: group.id, src_in_us: 166833, src_out_us: 333666,
        source_phase: { in: { num: 1, den: 3 }, out: { num: 2, den: 3 } } } })

    const result = await driveExport(page, { outputAbsPath: output,
      settings: { encoderEngine: 'native', decodeEngine: 'webcodecs', audio: { include: true } } }, { hook: 'exportTimeline' })
    expect(result.done.ok, result.done.error ?? result.lastDetail ?? undefined).toBe(true)
    const pixels = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output,
      '-vf', 'crop=2:2:160:120', '-frames:v', '6', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true })
    const firstBrightFrame = [0, 1, 2, 3, 4, 5].find(frame => pixels[frame * 12]! > 200)
    expect(firstBrightFrame).toBe(3)
    expect(pixels[4 * 12]).toBeLessThan(32)
    const samples = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output,
      '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { windowsHide: true })
    const firstAudibleSample = Array.from({ length: samples.length / 4 }, (_, index) => index)
      .find(index => Math.abs(samples.readFloatLE(index * 4)) > 0.05)
    expect(firstAudibleSample).toBeDefined()
    const slateSeconds = firstBrightFrame! * 1001 / 30000
    expect(Math.abs(firstAudibleSample! / 48000 - slateSeconds)).toBeLessThan(0.005)
    await invokeCmd(page, 'project_undo')
    expect(Object.keys((await invokeCmd<ProjectSummaryWire>(page, 'project_summary')).compositions)).toHaveLength(1)
  } finally { await app.close() }
})

test('imports a built-in cross dissolve and renders both clips at its midpoint', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-dissolve-import-')
  const source = join(folder, 'Dissolve.fcpxml')
  const destination = join(folder, 'Imported Dissolve')
  const files = ['red', 'blue'].map(color => {
    const path = join(folder, color + '.mov')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=320x240:r=30',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', path,
    ], { windowsHide: true })
    return pathToFileURL(path).href
  })
  writeFileSync(source, `<fcpxml version="1.10">
    <resources>
      <format id="f" frameDuration="1/30s" width="320" height="240"/>
      <effect id="d" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/>
      <asset id="r" format="f" duration="1s" hasVideo="1" src="${files[0]}"/>
      <asset id="b" format="f" duration="1s" hasVideo="1" src="${files[1]}"/>
    </resources><project name="Two Colors"><sequence format="f" duration="50/30s">
      <spine>
        <asset-clip ref="r" name="Red" duration="1s"/>
        <transition name="Cross Dissolve" offset="20/30s" duration="10/30s"><filter-video ref="d"/></transition>
        <asset-clip ref="b" name="Blue" offset="20/30s" duration="1s"/>
      </spine>
    </sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: folder, name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source)
    const bluePath = fileURLToPath(files[1]!)
    const heldBlue = join(folder, 'Temporarily Offline.mov')
    renameSync(bluePath, heldBlue)
    await beginImport(page)
    await expect(page.getByText(/A transition needs this media/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review with a marked gap' })).toHaveCount(0)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    renameSync(heldBlue, bluePath)
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/uses its editable crossfade over the original overlap/)).toBeVisible()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const imported = importedComposition(saved)
    const [red, blue] = imported.tracks[0].layers
    expect([red.label, blue.label]).toEqual(['Red', 'Blue'])
    expect(imported.transitions).toMatchObject([{
      from_layer: red.id, to_layer: blue.id, duration_us: red.t_end_us - blue.t_start_us,
      kind: { kind: 'Crossfade' }, extended_us: 0,
    }])
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(833333))
    await expect.poll(async () => {
      const p = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return p != null && p.r > 70 && p.b > 70 && p.g < 40
    }).toBe(true)
  } finally { await app.close() }
})

test('offers a separate project at the sequence rate and saves the current edit before switching', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-conflict-import-')
  const media = join(folder, 'Source.mov')
  const xml = join(folder, 'Conflict.fcpxml')
  encodeSource(media)
  writeFileSync(xml, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
<resources><format id="f" frameDuration="1001/30000s" width="320" height="240"/>
<asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
audioSources="1" audioChannels="2" audioRate="48000">
<media-rep kind="original-media" src="${pathToFileURL(media).href}"/></asset></resources>
<project name="Conflict"><sequence format="f" duration="3003/30000s">
<spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
</sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: folder, name: 'Original',
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 },
    })
    const state = await invokeCmd(page, 'project_open_state')
    await invokeCmd(page, 'add_marker', { tUs: 0, label: 'Keep this cut note' })
    const otherDestination = join(folder, 'Imported as New')
    await app.evaluate(({ dialog }, { path, parent }) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false, filePaths: [options.properties?.includes('openDirectory') ? parent : path],
      })
    }, { path: xml, parent: folder })
    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/These frame rates differ/)).toBeVisible()
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('button', { name: 'Review as a new project…' }).click()
    await expect(review.getByRole('button', { name: 'Choose project location…' })).toBeEnabled()
    expect(await invokeCmd(page, 'project_open_state')).toEqual(state)
    await review.getByRole('button', { name: 'Choose project location…' }).click()
    const create = page.getByRole('dialog', { name: 'Create project from timeline' })
    await create.getByRole('textbox', { name: 'Project name' }).fill('Imported as New')
    await create.getByRole('button', { name: 'Choose…', exact: true }).click()
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(create).toHaveCount(0)
    expect(await invokeCmd(page, 'project_open_state')).toEqual({ dir: otherDestination })
    expect(await importedSummary(page)).toMatchObject({ fps_num: 30000, fps_den: 1001, layer_count: 2 })
    expect(readFileSync(join(folder, 'Original', 'project.json'), 'utf8')).toContain('Keep this cut note')
  } finally { await app.close() }
})

test('discloses 96 kHz surround resampling and stereo downmix before import', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-surround-import-')
  const source = join(folder, 'Surround Edit.fcpxml')
  const audio = join(folder, 'Six Channel.wav')
  const destination = join(folder, 'Imported Surround')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=96000', '-t', '1',
    '-ac', '6', '-c:a', 'pcm_s16le', audio,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1/30s" width="320" height="240"/>
    <asset id="tone" hasAudio="1" audioSources="1" audioChannels="6" audioRate="96000"
      start="0s" duration="1s">
      <media-rep kind="original-media" src="${pathToFileURL(audio).href}"/>
    </asset>
  </resources>
  <project name="Surround Edit">
    <sequence format="f" duration="1s" audioLayout="surround" audioRate="96k">
      <spine><gap offset="0s" duration="1s">
        <asset-clip ref="tone" lane="-1" offset="0s" start="0s" duration="1s"/>
      </gap></spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Audio clips requiring 48 kHz resampling: 1/)).toBeVisible()
    await expect(review.getByText(/Audio clips requiring stereo downmixing: 1/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(1)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const pool = Object.values(project.media_pool) as { metadata: { audio: { sample_rate: number; channels: number } } }[]
    expect(pool).toHaveLength(1)
    expect(pool[0]?.metadata.audio).toMatchObject({ sample_rate: 96000, channels: 6 })
  } finally { await app.close() }
})

test('reviews and imports connected FCPXML video and audio lanes in stacking order', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-stacked-')
  const source = join(folder, 'Kite Workshop.fcpxml')
  const bed = join(folder, 'Bed.mov'), overlayA = join(folder, 'Green.mov'), overlayB = join(folder, 'Red.mov')
  const audio = join(folder, 'Bench Tone.wav')
  const destination = join(folder, 'Imported Workshop')
  for (const [color, file, frames] of [['blue', bed, 12], ['green', overlayA, 2], ['red', overlayB, 2]] as const) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=320x240:r=30000/1001',
      '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
    ], { windowsHide: true })
  }
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'pcm_s16le', audio], { windowsHide: true })

  const movie = (id: string, file: string, duration: string, start: string = '0s') =>
    `<asset id="${id}" format="f" start="${start}" duration="${duration}" hasVideo="1">
        <media-rep kind="original-media" src="${pathToFileURL(file).href}"/>
      </asset>`
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    ${movie('bed', bed, '12012/30000s', '3s')}
    ${movie('green', overlayA, '2002/30000s')}
    ${movie('red', overlayB, '2002/30000s')}
    <asset id="tone" duration="1s" hasAudio="1" audioSources="1" audioChannels="1" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(audio).href}"/>
    </asset>
  </resources>
  <project name="Kite Workshop">
    <sequence format="f" duration="6006/30000s">
      <spine>
        <asset-clip ref="bed" name="Primary" start="3s" duration="6006/30000s">
          <asset-clip ref="red" name="Top" lane="2" offset="91001/30000s" start="0s" duration="2002/30000s"/>
          <asset-clip ref="tone" name="Tone" lane="-1" offset="91001/30000s" start="0s" duration="3003/30000s"/>
          <asset-clip ref="green" name="Middle" lane="1" offset="91001/30000s" start="0s" duration="2002/30000s"/>
        </asset-clip>
      </spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, { source, destination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Lanes from bottom to top.*-1, 0, 1, 2/)).toBeVisible()
    await expect(review.getByText(/3 connected clips become independent clips/)).toBeVisible()
    await expect(review.getByText(/less than half a microsecond/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await waitForHook(page, 'getSelectedLayerIds')
    const summary = await importedSummary(page)
    expect(summary.layer_count).toBe(4)
    expect(summary.tracks.map((track) => track.layers[0]?.params.kind)).toEqual(['Audio', 'VideoClip', 'VideoClip', 'VideoClip'])
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const layers = importedComposition(project).tracks.map((track: { layers: { label: string; t_start_us: number; t_end_us: number }[] }) => track.layers[0])
    expect(layers.map((layer: { label: string }) => layer.label)).toEqual(['Tone', 'Primary', 'Middle', 'Top'])
    expect(layers[3]).toMatchObject({ t_start_us: 33367, t_end_us: 100100 })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33367))
    await expect.poll(async () => {
      const sample = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return sample != null && sample.r > 150 && sample.g < 50 && sample.b < 50
    }).toBe(true)
  } finally { await app.close() }
})
