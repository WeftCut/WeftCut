// e2e gate: the project folder holds what it renders (ADR 0173, spec
// § Project Motifs). Each test is one acceptance line of the cutover:
//   - a project copied to a profile whose library holds none of its Motifs
//     plays and exports as it did where it was made;
//   - a library Motif replaced changes no project that copied it, and that
//     project's row says an update is available;
//   - an edit under Motifs/<id>/ re-renders that Motif's frames and no other's;
//   - a Motif whose folder is gone shows the error placeholder, and an export
//     that renders it is refused, naming it.

import { test, expect, type Page } from '@playwright/test'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { analyze } from '../lib/analyze.mjs'
import { readMotifDirectory } from '../../src/main/motif/packageFiles'
import type { MotifBakeSnapshot } from '../../src/shared/motifs/baking'
import { hashCacheKey } from '../../src/shared/motifs/cacheKey'
import { driveExport, invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import { createMotif, motifPage, saveMotifToLibrary, seedLibraryMotif } from './helpers/motif'

interface Sample { r: number; g: number; b: number; a: number }
interface ProjectRow { id: string; status: string; state: string; path: string; revision: string | null; from: { version: number } | null }
interface CaptureDiagnostics { lanes: { motifId: string; captures: number }[] }

const seek = (page: Page, us: number) => page.evaluate(us => (window as any).__weftcutTest.weftcutSeekUs(us), us)
const sampleAt = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), [x, y] as const) as Promise<Sample>
const rgb = (s: Sample) => [s.r, s.g, s.b]

/** The composite at `points` once the preview shows `want` there (the preview
 *  mounts and captures asynchronously); seeks to `us` on every try. */
async function settledSamples(page: Page, us: number, points: readonly (readonly [number, number])[],
  want: (samples: Sample[]) => boolean, label: string): Promise<Sample[]> {
  let last = 'no sample' as Sample[] | string
  await expect.poll(async () => {
    try {
      await seek(page, us)
      last = await Promise.all(points.map(([x, y]) => sampleAt(page, x, y)))
      return want(last)
    } catch (error) { last = String(error); return false }
  }, { timeout: 60_000, message: `${label}: ${JSON.stringify(last)}` }).toBe(true)
  return last as Sample[]
}

/** The open project's Motif rows. */
const projectRows = (page: Page) => invokeCmd<ProjectRow[]>(page, 'list_motifs', { group: 'project' })
const projectRow = async (page: Page, id: string) => (await projectRows(page)).find(row => row.id === id)
/** A Motif folder's files and their bytes. */
const contents = (dir: string) => readMotifDirectory(dir).map(f => [f.path, f.bytes.toString('base64')])

async function reopen(page: Page, projectPath: string): Promise<void> {
  await waitForHook(page, 'motifReopenProject')
  await page.evaluate(p => (window as any).__weftcutTest.motifReopenProject({ path: p }), projectPath)
}

const addLayer = (page: Page, motifId: string, durationUs: number) =>
  page.evaluate(a => (window as any).__weftcutTest.addMotifLayer(a), { motifId, durationUs }) as Promise<string>

/** A Motif body that fills `rect` ([x, y, w, h]) of its canvas with `color`
 *  and leaves the rest transparent: whole-pixel edges, so a sample inside
 *  reads the colour exactly. */
const fillBody = (rect: readonly [number, number, number, number], color: string) =>
  `<div style="position:absolute;left:${rect[0]}px;top:${rect[1]}px;width:${rect[2]}px;height:${rect[3]}px;background:${color}"></div>`
  + `<script>motif.define({ frame() {} })</script>`
const fillPage = (rect: readonly [number, number, number, number], color: string) =>
  `<!doctype html><html><body style="margin:0;background:transparent">${fillBody(rect, color)}</body></html>`

async function connectMcp(page: Page): Promise<Client> {
  const info = await page.evaluate(() => (window as any).api.mcp.getInfo())
  const client = new Client({ name: 'e2e-project-motifs', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }))
  return client
}

test('a project copied to a profile whose library lacks its Motifs plays and exports identically @serial', async () => {
  test.skip(process.env.WEFTCUT_E2E_NO_EXPORT === '1', 'Video encoding unavailable on this runner')
  test.setTimeout(420_000)
  const canvas = { width: 320, height: 320, fpsNum: 30, fpsDen: 1 }
  // Left column: a Motif saved in the first profile's library, copied in on
  // placing. Middle column: one made in the project. Then a built-in.
  const LEFT = { manifest: { id: 'left-column', name: 'Left column', version: 1, size: [320, 320], default_duration_s: 3, props_schema: {} },
    color: [220, 40, 40] }
  const MIDDLE = { manifest: { name: 'Middle column', version: 1, size: [320, 320], default_duration_s: 3, props_schema: {} },
    color: [40, 200, 60] }
  const points = [[50, 160], [160, 160]] as const
  const columns = (s: Sample[]) => rgb(s[0]!).join() === LEFT.color.join() && rgb(s[1]!).join() === MIDDLE.color.join()
  const out = tmpDir('weftcut-portable-out-')

  const firstProfile = tmpDir('weftcut-portable-first-')
  seedLibraryMotif(firstProfile, 'left-column', 1, {
    'index.html': motifPage(LEFT.manifest, fillBody([0, 0, 100, 320], `rgb(${LEFT.color.join(',')})`)),
  })
  let running = await launchApp({ userDataDir: firstProfile })
  let projectPath = ''
  let ids: string[] = []
  let made: Sample[] = []
  try {
    await newProject(running.page, { parentFolder: tmpDir('weftcut-portable-project-'), name: 'Portable', canvas })
    await waitForHook(running.page, 'addMotifLayer')
    await addLayer(running.page, 'left-column', 3_000_000)
    const middle = await createMotif(running.page, MIDDLE.manifest, fillPage([110, 0, 100, 320], `rgb(${MIDDLE.color.join(',')})`))
    await addLayer(running.page, middle, 3_000_000)
    await invokeCmd(running.page, 'add_motif', { motifId: 'countdown', tStartUs: 2_000_000, tEndUs: 3_000_000, props: { seconds: 1 } })
    projectPath = await invokeCmd<string>(running.page, 'workspace_dir')
    ids = ['countdown', 'left-column', middle].sort()
    expect((await projectRows(running.page)).map(row => row.id).sort()).toEqual(ids)
    // Opened the way the copy will be, then played and exported.
    await reopen(running.page, projectPath)
    made = await settledSamples(running.page, 500_000, points, columns, 'the first profile shows both columns')
    const exported = await driveExport(running.page, { outputAbsPath: path.join(out, 'made.mp4') }, { hook: 'exportTimeline', timeout: 240_000 })
    expect(exported.done.ok, exported.done.error).toBe(true)
  } finally { await running.app.close() }

  // The folder as another machine receives it: the frame cache stays behind,
  // so every frame there is rendered from Motifs/.
  const copy = path.join(tmpDir('weftcut-portable-copy-'), 'Portable')
  cpSync(projectPath, copy, { recursive: true, filter: source => path.relative(projectPath, source).split(path.sep)[0] !== 'Cache' })
  expect(existsSync(path.join(copy, 'Cache'))).toBe(false)

  running = await launchApp()
  try {
    const library = await invokeCmd<Array<{ id: string; status: string }>>(running.page, 'list_motifs', { group: 'library' })
    expect(library.filter(row => row.status === 'installed'), 'the second profile\'s library holds no saved Motif').toEqual([])
    await reopen(running.page, copy)
    const rows = await projectRows(running.page)
    expect(rows.map(row => row.id).sort()).toEqual(ids)
    expect(rows.filter(row => row.status !== 'ok'), 'every Motif renders from the copied folder').toEqual([])
    const played = await settledSamples(running.page, 500_000, points, columns, 'the copy shows both columns')
    expect(played).toEqual(made)
    const exported = await driveExport(running.page, { outputAbsPath: path.join(out, 'copied.mp4') }, { hook: 'exportTimeline', timeout: 240_000 })
    expect(exported.done.ok, exported.done.error).toBe(true)
  } finally { await running.app.close() }

  // Frames of each Motif: both columns, then the countdown over them.
  const report = analyze({ output: path.join(out, 'copied.mp4'), source: path.join(out, 'made.mp4'), samples: [15, 45, 75], ssimMin: 0.995, window: 0 })
  console.log('[portable] copy vs original:', JSON.stringify(report))
  expect(report.pass).toBe(true)
})

test('replacing a library Motif changes no project that copied it; its row offers the update', async () => {
  test.setTimeout(180_000)
  const profile = tmpDir('weftcut-library-replace-')
  const manifest = { id: 'badge', name: 'Badge', version: 1, size: [160, 90], default_duration_s: 2, props_schema: {} }
  seedLibraryMotif(profile, 'badge', 1, {
    'index.html': motifPage(manifest, '<div></div><script>motif.define({ frame() {} })</script>', '<link rel="stylesheet" href="style.css">'),
    'style.css': 'html,body{margin:0;background:transparent}div{width:160px;height:90px;background:rgb(220,40,40)}',
  })
  const RED = [220, 40, 40], BLUE = [40, 40, 220]
  const center = [[80, 45]] as const
  const shows = (color: number[]) => (s: Sample[]) => rgb(s[0]!).join() === color.join()
  const canvas = { width: 160, height: 90, fpsNum: 30, fpsDen: 1 }
  const { app, page } = await launchApp({ userDataDir: profile })
  try {
    // The first project copies the library's version 1 on placing.
    await newProject(page, { parentFolder: tmpDir('weftcut-library-first-'), name: 'First', canvas })
    await waitForHook(page, 'addMotifLayer')
    await addLayer(page, 'badge', 2_000_000)
    const firstPath = await invokeCmd<string>(page, 'workspace_dir')
    const copied = await projectRow(page, 'badge')
    expect(copied).toMatchObject({ status: 'ok', state: 'in_sync', from: { version: 1 } })
    const filesBefore = contents(copied!.path)

    // Another project changes its own copy and saves it over the library's.
    await newProject(page, { parentFolder: tmpDir('weftcut-library-second-'), name: 'Second', canvas })
    await addLayer(page, 'badge', 2_000_000)
    const read = await invokeCmd<{ revision: string }>(page, 'read_motif', { motif_id: 'badge' })
    await invokeCmd(page, 'update_motif_files', { motif_id: 'badge', expected_revision: read.revision,
      files: [{ path: 'style.css', edits: [{ old: 'rgb(220,40,40)', new: `rgb(${BLUE.join(',')})` }] }] })
    expect(await saveMotifToLibrary(page, 'badge', 1)).toBe('badge')
    const library = await invokeCmd<Array<{ id: string; version: number }>>(page, 'list_motifs', { group: 'library' })
    expect(library.find(row => row.id === 'badge')?.version).toBe(2)

    await reopen(page, firstPath)
    // Nothing of the first project moved: its folder, its record, its picture.
    const after = await projectRow(page, 'badge')
    expect(after).toMatchObject({ status: 'ok', state: 'update_available', revision: copied!.revision })
    expect(contents(after!.path)).toEqual(filesBefore)
    await settledSamples(page, 500_000, center, shows(RED), 'the first project still shows its own copy')

    // The panel says so on the project's row, and offers the update.
    await page.getByRole('menuitem', { name: 'Insert', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Motifs…', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Motifs', exact: true })
    const card = picker.getByRole('region', { name: 'This project', exact: true }).locator('.motif-card')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.motif-card-status')).toHaveText('Update available')
    // Taken, the update is one step the user can undo.
    await card.getByRole('button', { name: 'Update project copy', exact: true }).click()
    await expect.poll(async () => (await projectRow(page, 'badge'))?.state).toBe('in_sync')
    await expect(card.locator('.motif-card-status')).toHaveCount(0)
    await settledSamples(page, 500_000, center, shows(BLUE), 'the updated copy renders the library\'s version')
    await invokeCmd(page, 'project_undo')
    await expect.poll(async () => (await projectRow(page, 'badge'))?.state).toBe('update_available')
    expect(contents(after!.path), 'undo puts the copy it replaced back').toEqual(filesBefore)
  } finally { await app.close() }
})

test('an edit under Motifs/<id>/ re-renders that Motif\'s frames and no other\'s @serial', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: 'bitmap' } })
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-motif-edit-'), name: 'Edit one',
      canvas: { width: 128, height: 64, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: true } })
    await waitForHook(page, 'addMotifLayer')
    // Side by side on one canvas: the edited Motif paints the left half, the
    // kept one the right.
    const manifest = (name: string) => ({ name, version: 1, size: [128, 64], default_duration_s: 1, props_schema: {} })
    const edited = await createMotif(page, manifest('Edited half'), fillPage([0, 0, 64, 64], 'rgb(220,40,40)'))
    const kept = await createMotif(page, manifest('Kept half'), fillPage([64, 0, 64, 64], 'rgb(40,200,60)'))
    const editedLayer = await addLayer(page, edited, 1_000_000)
    const keptLayer = await addLayer(page, kept, 1_000_000)
    const keyOf = (layerId: string) => page.evaluate(id => (window as any).__weftcutTest.cacheKeyForLayer(id), layerId) as Promise<string | null>
    const editedKey = (await keyOf(editedLayer))!
    const keptKey = (await keyOf(keptLayer))!
    const snapshot = () => invokeCmd<MotifBakeSnapshot>(page, 'motif_bake_snapshot')
    const ready = async (key: string) => (await snapshot()).statuses[key]?.phase === 'ready'
    await expect.poll(async () => await ready(editedKey) && await ready(keptKey), { timeout: 90_000 }).toBe(true)

    // The kept Motif's frames on disk, as they stand before the edit.
    const raster = path.join(await invokeCmd<string>(page, 'workspace_dir'), 'Cache', 'raster')
    const keptDir = path.join(raster, hashCacheKey(keptKey))
    const stamps = (dir: string) => Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.wfrm')).map(f => [f, statSync(path.join(dir, f)).mtimeMs]))
    const keptFrames = stamps(keptDir)
    expect(Object.keys(keptFrames).length).toBeGreaterThan(0)
    await invokeCmd(page, 'motif_capture_diagnostics', { reset: true })

    // An agent rewrites the edited Motif's page in the project's folder.
    const folder = (await projectRow(page, edited))!.path
    writeFileSync(path.join(folder, 'index.html'), readFileSync(path.join(folder, 'index.html'), 'utf8').replace('rgb(220,40,40)', 'rgb(40,40,220)'))

    let newKey: string | null = null
    await expect.poll(async () => (newKey = await keyOf(editedLayer)) !== editedKey, { timeout: 30_000 }).toBe(true)
    await expect.poll(() => ready(newKey!), { timeout: 90_000 }).toBe(true)
    await settledSamples(page, 500_000, [[32, 32], [96, 32]],
      s => rgb(s[0]!).join() === '40,40,220' && rgb(s[1]!).join() === '40,200,60', 'the edit shows, the kept half stays')

    // Ownership: the edit's captures are the edited Motif's alone.
    const lanes = (await invokeCmd<CaptureDiagnostics>(page, 'motif_capture_diagnostics')).lanes
    const captures = (id: string) => lanes.filter(lane => lane.motifId === id).reduce((n, lane) => n + lane.captures, 0)
    expect(captures(edited), 'the edited Motif was captured again').toBeGreaterThan(0)
    expect(captures(kept), 'the kept Motif was not captured again').toBe(0)
    expect(await keyOf(keptLayer)).toBe(keptKey)
    expect(stamps(keptDir), 'the kept Motif\'s stored frames were not rewritten').toEqual(keptFrames)
  } finally { await app.close() }
})

test('a Motif whose folder is gone shows the error placeholder, and an export that renders it is refused naming it', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  let client: Client | null = null
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-motif-missing-'), name: 'Missing',
      canvas: { width: 480, height: 270, fpsNum: 30, fpsDen: 1 } })
    await waitForHook(page, 'addMotifLayer')
    // The error placeholder's size: the layer keeps its geometry when the
    // Motif goes, so a sample lands at the same place in both pictures.
    const id = await createMotif(page, { name: 'Vanishing', version: 1, size: [480, 270], default_duration_s: 2, props_schema: {} },
      fillPage([0, 0, 480, 270], 'rgb(40,40,220)'))
    await addLayer(page, id, 2_000_000)
    // Inside the placeholder's disc, beside its exclamation mark.
    const inDisc = [[215, 135]] as const
    await settledSamples(page, 500_000, inDisc, s => rgb(s[0]!).join() === '40,40,220', 'the Motif renders')
    const projectPath = await invokeCmd<string>(page, 'workspace_dir')

    rmSync(path.join(projectPath, 'Motifs', id), { recursive: true, force: true })
    await reopen(page, projectPath)
    expect(await projectRow(page, id)).toMatchObject({ status: 'missing' })
    // The placeholder's disc is the app's destructive red (MotifSprite.ts).
    await settledSamples(page, 500_000, inDisc, ([s]) => s!.r > 200 && s!.g < 150 && s!.b < 150 && s!.a === 255,
      'the missing Motif shows the error placeholder')

    client = await connectMcp(page)
    const session = await client.readResource({ uri: 'project://session' })
    const missing = JSON.parse((session.contents[0] as { text: string }).text).motifs.missing as Array<{ motif_id: string }>
    expect(missing.map(m => m.motif_id)).toEqual([id])

    // An agent's export is refused before a job exists.
    const agentOutput = path.join(tmpDir('weftcut-motif-missing-out-'), 'agent.mp4')
    const refused = await client.callTool({ name: 'start_export', arguments: { request_id: 'missing-motif', output_path: agentOutput } })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ error: 'MotifUnavailable', motif_ids: [id] })
    expect(JSON.stringify(refused.content)).toContain(`'${id}'`)
    expect(existsSync(agentOutput)).toBe(false)

    // The app's own export refuses the same, naming it.
    const userOutput = path.join(tmpDir('weftcut-motif-missing-out-'), 'user.mp4')
    const exported = await driveExport(page, { outputAbsPath: userOutput }, { hook: 'exportTimeline', timeout: 60_000 })
    expect(exported.done.ok).toBe(false)
    expect(exported.done.error).toContain(id)
    expect(existsSync(userOutput)).toBe(false)
  } finally {
    await client?.close()
    await app.close()
  }
})
