// e2e gate: a project collects the fonts it draws (ADR 0176). Each test is one
// acceptance line:
//   - a face a layer draws is copied into `Fonts/`, and draws from there
//     on a machine without it, in preview and export;
//   - only drawn faces are collected, and a family before the first that
//     draws is reported missing, in the panel and `project://session`;
//   - the exclusion list keeps a family out across opens; Allow copying
//     brings it back without a copy line;
//   - a collected face deleted from `Fonts/` is copied again;
//   - a close waits for a copy in flight, and a copy killed midway leaves no
//     partial file;
//   - a Motif's font slot collects the face its text props draw, and its
//     capture draws with it.
//
// "Installed" is what `WEFTCUT_E2E_FONT_DIRS` names (src/main/fonts/catalog.ts):
// the fixture family is installed where a test points it at a folder holding
// the fixture, and nowhere where it points at an empty one. The fixture is
// Courier Prime (fixtures/fonts/courier-prime/README.md): monospaced, so its
// text measures unlike any bundled fallback's.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { analyze } from '../lib/analyze.mjs'
import { driveExport, forceCloseApp, invokeCmd, launchApp, newProject, textBoxProbe, tmpDir, waitForHook } from './helpers/driver'
import { addLayer, connectMcp, createMotif, reopen, rgb, settledSamples, trustMotif, type Sample } from './helpers/motif'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/fonts/courier-prime')
const FAMILY = 'Courier Prime'
const REGULAR = 'CourierPrime-Regular.ttf'
const BOLD = 'CourierPrime-Bold.ttf'
/** A family no machine has. */
const NOWHERE = 'Nowhere Sans E2E'
const NOWHERE_TOO = 'Nowhere Serif E2E'

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const DURATION_US = 1_000_000
const FONT_PX = 56
const TEXT = 'Hamburgefonstiv'
/** Mid-file, so a leading-frame quirk of either encode is not what is read. */
const SAMPLE_FRAME = 15
/** Two exports of the same frames on one machine; text-box-cjk-export.spec.ts
 *  uses the same bar for the same kind of comparison. */
const SAME_FRAME_SSIM = 0.99

/** A system font folder holding the fixture family. */
function installedFonts(): string {
  const dir = tmpDir('weftcut-e2e-sysfonts-')
  for (const file of [REGULAR, BOLD]) copyFileSync(path.join(FIXTURE_DIR, file), path.join(dir, file))
  return dir
}

/** A system font folder with no fonts: an empty variable would scan the
 *  machine's own folders instead. */
const noFonts = () => tmpDir('weftcut-e2e-nofonts-')

const launchWithFonts = (fontDir: string) => launchApp({ env: { WEFTCUT_E2E_FONT_DIRS: fontDir } })

/** What a project's `Fonts/` holds, partial copies (`.<name>.<uuid>.part`)
 *  included, sorted. */
function fontsIn(project: string): string[] {
  try { return readdirSync(path.join(project, 'Fonts')).sort() } catch { return [] }
}

/** Waits until the system scan has landed, holding the fixture when
 *  `withFixture`. Before it, no family is missing and nothing is copied. */
async function systemScanned(page: Page, withFixture: boolean): Promise<void> {
  await expect.poll(() => page.evaluate(async ({ family, withFixture }) => {
    const index = await window.api.font.index()
    const has = index.faces.some(face => face.source === 'system' && face.families.includes(family))
    return index.systemScanned && has === withFixture
  }, { family: FAMILY, withFixture }), { message: 'the system font scan lands', timeout: 60_000 }).toBe(true)
}

/** Waits until the catalog serves the fixture from the project's `Fonts/`. */
async function projectFaceIndexed(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async (family) => {
    const index = await window.api.font.index()
    return index.faces.some(face => face.source === 'project' && face.families.includes(family))
  }, FAMILY), { message: 'Fonts/ is indexed', timeout: 60_000 }).toBe(true)
}

interface LogRow { id: string; i18n_key?: string | null; i18n_args?: Record<string, unknown>; details?: Record<string, unknown> }
/** The open project's log rows with `key`. The log is the session's: each
 *  open starts an empty one (docs/status-log.md). */
const logRows = async (page: Page, key: string) =>
  (await invokeCmd<LogRow[]>(page, 'log_list')).filter(row => row.i18n_key === key)

/** A one-line Text layer drawing `content` in `family` at `weight`. */
async function addText(page: Page, family: string, weight: number, content = TEXT): Promise<string> {
  const layerId = await invokeCmd<string>(page, 'add_text_layer', { tStartUs: 0, durationUs: DURATION_US, content })
  await setText(page, layerId, { font_family: family, font_weight: weight, font_size_px: FONT_PX })
  return layerId
}
const setText = (page: Page, layerId: string, patch: Record<string, unknown>) =>
  invokeCmd(page, 'update_layer_params', { layerId, patch: { kind: 'Text', ...patch } })

/** What the preview did with the layer's text; null until a preview has
 *  staged it (`textBoxProbe` throws until one registers). */
async function probe(page: Page, layerId: string): Promise<Awaited<ReturnType<typeof textBoxProbe>> | null> {
  try { return await textBoxProbe(page, layerId) } catch { return null }
}

/** The width the preview laid the layer's line out at. The sprite lays text
 *  out only once its faces are loaded (TextSprite `fontIndex`), so a width is
 *  always one font's, never a placeholder's. */
async function lineWidth(page: Page, layerId: string): Promise<number | null> {
  return (await probe(page, layerId))?.natural?.w ?? null
}

/** `project://session` `fonts.missing`. */
async function sessionMissing(client: Client): Promise<unknown[]> {
  const session = await client.readResource({ uri: 'project://session' })
  return JSON.parse((session.contents[0] as { text: string }).text).fonts.missing
}

/** Moves what the app trashes into `bin` instead of the runner's trash, and
 *  records it. */
async function stubTrash(app: ElectronApplication, bin: string): Promise<void> {
  mkdirSync(bin, { recursive: true })
  await app.evaluate(({ shell }, bin) => {
    const fs = process.getBuiltinModule('node:fs')
    const trashed: string[] = (globalThis as any).__trashed = []
    shell.trashItem = async (target) => { trashed.push(target); fs.renameSync(target, `${bin}/${trashed.length}`) }
  }, bin)
}
const trashed = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__trashed as string[])

/** Holds every copy into `Fonts/` once its `.part` is written, until
 *  `releaseCopies`. `fs.promises` is the object the font store writes through
 *  (src/main/index.ts), so the hold sits at the store's own boundary. Records
 *  'copy held' and, per finished copy, 'copy renamed' into `__fontOrder`. */
async function holdCopies(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as any
    const fsp = process.getBuiltinModule('node:fs').promises
    const order: string[] = g.__fontOrder ??= []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    g.__releaseFontCopies = release
    const partial = /[\\/]Fonts[\\/]\.[^\\/]*\.part$/
    const writeFile = fsp.writeFile
    fsp.writeFile = (async (file: any, ...rest: any[]) => {
      await (writeFile as any).call(fsp, file, ...rest)
      if (partial.test(String(file))) { order.push('copy held'); await gate }
    }) as typeof fsp.writeFile
    const rename = fsp.rename
    fsp.rename = (async (from: any, to: any) => {
      await rename.call(fsp, from, to)
      if (partial.test(String(from))) order.push('copy renamed')
    }) as typeof fsp.rename
  })
}
const releaseCopies = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__releaseFontCopies())
const fontOrder = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__fontOrder ?? []) as string[])

/** Records when `project_close` reaches main and when main answers it, into
 *  the same `__fontOrder` as `holdCopies`. */
async function recordClose(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as any
    const order: string[] = g.__fontOrder ??= []
    const handlers = ipcMain._invokeHandlers
    for (const channel of ['backend:invoke', 'backend:invokePublished']) {
      const handler = handlers.get(channel)!
      handlers.set(channel, async (event, request) => {
        if (request?.channel !== 'project_close') return handler(event, request)
        order.push('close requested')
        try { return await handler(event, request) } finally { order.push('close answered') }
      })
    }
  })
}

/** Exports the timeline to `file`. */
async function exportTo(page: Page, file: string): Promise<void> {
  const result = await driveExport(page, { outputAbsPath: file }, { hook: 'exportTimeline', timeout: 150_000 })
  if (!result.done.ok) throw new Error(`export to ${path.basename(file)} failed: ${result.done.error}`)
}

/** SSIM of `a` against `b` at `SAMPLE_FRAME`, index for index: both files are
 *  one still frame repeated, so there is nothing to align. */
function ssim(a: string, b: string): number {
  const report = analyze({ output: a, source: b, samples: [SAMPLE_FRAME], ssimMin: SAME_FRAME_SSIM, window: 0 })
  const sample = report.samples[0]
  if (!sample) throw new Error('analyzer returned no sample: ' + JSON.stringify(report))
  return sample.ssim
}

/** The project folder as another machine receives it: without `Cache/`. */
function copyProject(project: string, prefix: string): string {
  const copy = path.join(tmpDir(prefix), path.basename(project))
  cpSync(project, copy, { recursive: true, filter: source => path.relative(project, source).split(path.sep)[0] !== 'Cache' })
  return copy
}

test('a project carries the face it draws, and draws from it where the font is not installed', async () => {
  test.skip(process.env.WEFTCUT_E2E_NO_EXPORT === '1', 'the portable leg compares real exports')
  test.setTimeout(600_000)
  const outDir = tmpDir('weftcut-e2e-fonts-out-')
  const made = path.join(outDir, 'made.mp4')
  const received = path.join(outDir, 'received.mp4')
  const excluded = path.join(outDir, 'excluded.mp4')
  let project = '', layerId = '', drawn = 0

  // Made on a machine with the family installed.
  let running = await launchWithFonts(installedFonts())
  try {
    const { page } = running
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-made-'), name: 'Carried', canvas: CANVAS })
    project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    // The yardstick: the same line in a bundled family, read once the layout
    // carries the layer's own size (it is born at the default one).
    layerId = await addText(page, 'Liberation Sans', 700)
    await expect.poll(async () => (await probe(page, layerId))?.fit?.authoredPx, { timeout: 60_000 }).toBe(FONT_PX)
    const bundled = (await lineWidth(page, layerId))!
    await setText(page, layerId, { font_family: FAMILY })
    await expect.poll(() => lineWidth(page, layerId), { message: 'the line takes the fixture family' }).not.toBe(bundled)
    drawn = (await lineWidth(page, layerId))!

    // Exactly the face the layer draws: Bold, not the Regular beside it.
    await expect.poll(() => fontsIn(project), { message: 'the Bold face is copied into Fonts/' }).toEqual([BOLD])
    expect(readFileSync(path.join(project, 'Fonts', BOLD)).equals(readFileSync(path.join(FIXTURE_DIR, BOLD)))).toBe(true)
    await expect.poll(async () => (await logRows(page, 'log.fonts_copied')).map(row => row.details?.families))
      .toEqual([[FAMILY]])

    await exportTo(page, made)
    await invokeCmd(page, 'project_save')
  } finally { await running.app.close() }

  // Received on a machine without it: the folder alone carries the face.
  const copy = copyProject(project, 'weftcut-e2e-fonts-received-')
  running = await launchWithFonts(noFonts())
  try {
    const { app, page } = running
    await systemScanned(page, false)
    await reopen(page, copy)
    await projectFaceIndexed(page)
    await expect.poll(() => lineWidth(page, layerId), { message: 'preview draws the face from Fonts/', timeout: 60_000 }).toBe(drawn)
    await exportTo(page, received)
    expect(ssim(received, made), 'the export draws the face from Fonts/').toBeGreaterThanOrEqual(SAME_FRAME_SSIM)
    expect(fontsIn(copy)).toEqual([BOLD])
    expect(await logRows(page, 'log.fonts_copied'), 'nothing is copied: the folder has it').toEqual([])

    // The comparison bites: without the face, the same frame is another one.
    await stubTrash(app, path.join(outDir, 'trash'))
    await page.evaluate(family => window.api.projectFonts.exclude(family), FAMILY)
    expect(fontsIn(copy)).toEqual([])
    await expect.poll(() => lineWidth(page, layerId), { message: 'preview falls back once the face is gone' }).not.toBe(drawn)
    await exportTo(page, excluded)
    expect(ssim(excluded, made), 'an export without the face differs').toBeLessThan(SAME_FRAME_SSIM)
  } finally { await running.app.close() }
})

test('only faces that draw are collected, and a family before the first that draws is missing', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithFonts(installedFonts())
  let client: Client | null = null
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-uses-'), name: 'Uses', canvas: CANVAS })
    const project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    // Missing first: the fixture after it draws instead, in Bold.
    const missingFirst = await addText(page, `${NOWHERE}, ${FAMILY}`, 700)
    // Missing after the family that draws: a fallback, never missing.
    const missingAfter = await addText(page, `${FAMILY}, ${NOWHERE}`, 400, 'Sphinx of black quartz')
    // A bundled family first draws every character: nothing after it is a use.
    await addText(page, `Liberation Sans, ${NOWHERE_TOO}`, 400)

    await expect.poll(() => fontsIn(project), { message: 'each drawn face is copied' }).toEqual([BOLD, REGULAR])
    client = await connectMcp(page, 'e2e-project-fonts')
    await expect.poll(() => sessionMissing(client!), { message: 'project://session names the missing family' })
      .toEqual([{ family: NOWHERE, weight: 700, italic: false, layer_ids: [missingFirst] }])
    await expect.poll(async () => (await logRows(page, 'log.fonts_missing')).map(row => row.details?.family)).toEqual([NOWHERE])

    await waitForHook(page, 'revealLayer')
    const panel = page.locator('.attribute-panel')
    // A Text layer's label defaults to its content: which layer the panel shows.
    const label = panel.getByRole('textbox', { name: 'Label', exact: true })
    const note = panel.getByTestId('font-problem')
    await page.evaluate(id => window.__weftcutTest.revealLayer({ layerId: id }), missingFirst)
    await expect(label).toHaveAttribute('placeholder', TEXT)
    await expect(note).toHaveCount(1)
    await expect(note).toContainText(NOWHERE)
    await expect(note).toContainText(FAMILY)
    await page.evaluate(id => window.__weftcutTest.revealLayer({ layerId: id }), missingAfter)
    await expect(label).toHaveAttribute('placeholder', 'Sphinx of black quartz')
    await expect(note).toHaveCount(0)
  } finally {
    await client?.close()
    await app.close()
  }
})

test('the exclusion list keeps a family out across opens; Allow copying brings it back quietly', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithFonts(installedFonts())
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-exclude-'), name: 'Excluded', canvas: CANVAS })
    const project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    // The missing family is the witness that a reconcile walked the uses.
    const layerId = await addText(page, `${NOWHERE}, ${FAMILY}`, 700)
    await expect.poll(() => fontsIn(project)).toEqual([BOLD])
    await expect.poll(async () => (await logRows(page, 'log.fonts_copied')).length).toBe(1)

    await stubTrash(app, path.join(tmpDir('weftcut-e2e-fonts-bin-'), 'trash'))
    const view = await page.evaluate(family => window.api.projectFonts.exclude(family), FAMILY)
    expect(view).toMatchObject({ copied: [], excluded: [{ family: FAMILY, installed: true }] })
    expect((await trashed(app)).map(file => path.basename(file))).toEqual([BOLD])
    expect(fontsIn(project)).toEqual([])
    await invokeCmd(page, 'project_save')
    expect(JSON.parse(readFileSync(path.join(project, 'project.json'), 'utf8')).settings.excluded_fonts).toEqual([FAMILY])

    // Reopened: the walk runs (its missing line is the witness) and the
    // close waits for that batch, so nothing it copied can arrive later.
    await reopen(page, project)
    await expect.poll(async () => (await logRows(page, 'log.fonts_missing')).length,
      { message: 'the reopened project walks its uses' }).toBeGreaterThan(0)
    await invokeCmd(page, 'project_close')
    expect(fontsIn(project), 'an excluded family is not copied').toEqual([])

    // Allow copying once the open's own walk is done, as a user's click is.
    await reopen(page, project)
    await expect.poll(async () => (await logRows(page, 'log.fonts_missing')).length).toBeGreaterThan(0)
    const allowed = await page.evaluate(family => window.api.projectFonts.allow(family), FAMILY)
    expect(allowed).toMatchObject({ copied: [{ family: FAMILY, files: 1 }], excluded: [] })
    expect(fontsIn(project)).toEqual([BOLD])
    // A later line from the same log is the witness that an earlier one would
    // have landed by now.
    await setText(page, layerId, { font_family: `${NOWHERE_TOO}, ${FAMILY}` })
    await expect.poll(async () => (await logRows(page, 'log.fonts_missing')).some(row => row.details?.family === NOWHERE_TOO)).toBe(true)
    expect(await logRows(page, 'log.fonts_copied'), 'Allow copying logs no copy').toEqual([])
  } finally { await app.close() }
})

test('a face deleted from Fonts/ while the project was closed is copied again', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithFonts(installedFonts())
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-recopy-'), name: 'Recopied', canvas: CANVAS })
    const project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    await addText(page, FAMILY, 700)
    await expect.poll(async () => (await logRows(page, 'log.fonts_copied')).length).toBe(1)
    expect(fontsIn(project)).toEqual([BOLD])
    await invokeCmd(page, 'project_save')
    await invokeCmd(page, 'project_close')

    rmSync(path.join(project, 'Fonts', BOLD))
    await reopen(page, project)
    await expect.poll(async () => (await logRows(page, 'log.font_recopied')).map(row => row.i18n_args?.name),
      { message: 'the copy again points at the exclusion list' }).toEqual([FAMILY])
    expect(fontsIn(project)).toEqual([BOLD])
    expect(await logRows(page, 'log.fonts_copied'), 'a copy again is not a first copy').toEqual([])
  } finally { await app.close() }
})

test('a close waits for the copy in flight', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithFonts(installedFonts())
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-close-'), name: 'Closing', canvas: CANVAS })
    const project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    await holdCopies(app)
    await recordClose(app)
    await page.evaluate(() => {
      const w = window as any
      w.__fontProgress = []
      window.api.projectFonts.onProgress(progress => { w.__fontProgress.push(progress) })
    })
    await addText(page, FAMILY, 700)
    await expect.poll(() => fontOrder(app)).toEqual(['copy held'])

    const closing = invokeCmd(page, 'project_close')
    // The work pill's state: the close is waiting on the copy.
    await expect.poll(() => page.evaluate(() => ((window as any).__fontProgress as Array<{ closing: boolean } | null>).some(p => p?.closing === true)),
      { message: 'the close waits on the copy' }).toBe(true)
    expect(await fontOrder(app)).toEqual(['copy held', 'close requested'])
    await releaseCopies(app)
    await closing
    expect(await fontOrder(app)).toEqual(['copy held', 'close requested', 'copy renamed', 'close answered'])
    expect(fontsIn(project)).toEqual([BOLD])
  } finally { await app.close() }
})

test('a copy killed midway leaves no partial file, and the next open finishes it', async () => {
  test.setTimeout(240_000)
  const fontDir = installedFonts()
  let project = ''
  let running = await launchWithFonts(fontDir)
  try {
    const { app, page } = running
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-kill-'), name: 'Killed', canvas: CANVAS })
    project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    await holdCopies(app)
    await addText(page, FAMILY, 700)
    await invokeCmd(page, 'project_save')
    await expect.poll(() => fontOrder(app)).toEqual(['copy held'])
    const partial = fontsIn(project)
    expect(partial, 'the held copy is a .part').toHaveLength(1)
    expect(partial[0]).toMatch(/^\..*\.part$/)
    forceCloseApp(app)
  } finally { await running.app.close().catch(() => {}) }

  running = await launchWithFonts(fontDir)
  try {
    const { page } = running
    await systemScanned(page, true)
    await reopen(page, project)
    await expect.poll(() => fontsIn(project), { message: 'the stale .part is gone and the copy is done' }).toEqual([BOLD])
  } finally { await running.app.close() }
})

test('a Motif font slot collects the face its text draws, and its capture draws with it', async () => {
  test.setTimeout(300_000)
  const GREEN = [40, 200, 60], RED = [220, 40, 40]
  /** The left half: green when the slot's family measures monospaced (the
   *  fixture), red when a proportional fallback draws. */
  const SIGNAL = [[120, 60]] as const
  const shows = (color: number[]) => (s: Sample[]) => rgb(s[0]!).join() === color.join()
  const manifest = {
    name: 'Font slot probe', version: 1, size: [CANVAS.width, CANVAS.height], default_duration_s: 2,
    props_schema: {
      font_title: { type: 'string', default: `'${FAMILY}'`, max_length: 200 },
      title: { type: 'string', default: TEXT },
    },
  }
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div id="signal" style="position:absolute;left:0;top:0;width:${CANVAS.width / 2}px;height:${CANVAS.height / 2}px"></div>
<div id="title" style="position:absolute;left:0;bottom:0;font-size:40px;color:#fff"></div>
<script>
motif.define({ async setup(props) {
  const stack = props.font_title + ', sans-serif'
  await document.fonts.load('400 40px ' + stack)
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = '400 40px ' + stack
  const mono = Math.abs(ctx.measureText('iiiiiiii').width - ctx.measureText('MMMMMMMM').width) < 0.5
  document.getElementById('signal').style.background = mono ? 'rgb(${GREEN.join(',')})' : 'rgb(${RED.join(',')})'
  const title = document.getElementById('title')
  title.style.fontFamily = stack
  title.textContent = props.title
} })
</script></body></html>`

  let project = '', motifId = ''
  let running = await launchWithFonts(installedFonts())
  try {
    const { page } = running
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-fonts-motif-'), name: 'Motif fonts', canvas: CANVAS })
    project = await invokeCmd<string>(page, 'workspace_dir')
    await systemScanned(page, true)
    await waitForHook(page, 'addMotifLayer')
    motifId = await createMotif(page, manifest, html)
    await addLayer(page, motifId, 2_000_000)
    await settledSamples(page, 500_000, SIGNAL, shows(GREEN), 'the slot draws the installed family')
    // A slot walks at Regular upright: its CSS picks the weight.
    await expect.poll(() => fontsIn(project), { message: 'the slot collects the Regular face' }).toEqual([REGULAR])
    await invokeCmd(page, 'project_save')
  } finally { await running.app.close() }

  const copy = copyProject(project, 'weftcut-e2e-fonts-motif-received-')
  running = await launchWithFonts(noFonts())
  try {
    const { app, page } = running
    await systemScanned(page, false)
    await reopen(page, copy)
    await trustMotif(page, motifId)
    await settledSamples(page, 500_000, SIGNAL, shows(GREEN), 'the capture draws the face from Fonts/')
    // The probe bites: without the face, the capture draws a fallback.
    await stubTrash(app, path.join(tmpDir('weftcut-e2e-fonts-motif-bin-'), 'trash'))
    await page.evaluate(family => window.api.projectFonts.exclude(family), FAMILY)
    await settledSamples(page, 500_000, SIGNAL, shows(RED), 'without the face the capture falls back')
  } finally { await running.app.close() }
})
