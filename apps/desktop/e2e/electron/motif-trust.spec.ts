// e2e gate: a project Motif runs only when trusted on this machine (ADR 0174).
// Each test is one acceptance line of trust:
//   - a project received from another machine runs none of its Motifs' code
//     until the user trusts them in the Motifs panel, and stays trusted;
//   - edits made while the project is open here never ask;
//   - an edit made while the project was closed asks;
//   - a ZIP asks, unless it holds the bytes of a version this library exported.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync } from 'fflate'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import {
  addLayer, connectMcp, createMotif, fillPage, projectRow, reopen, rgb, saveMotifToLibrary, settledSamples, type Sample,
} from './helpers/motif'

const CANVAS = { width: 480, height: 270, fpsNum: 30, fpsDen: 1 }
/** The whole canvas: the Motif and the error placeholder cover the same
 *  pixels, so one sample reads either. */
const FULL = [0, 0, 480, 270] as const
const manifest = (name: string) => ({ name, version: 1, size: [480, 270], default_duration_s: 2, props_schema: {} })
/** Inside the placeholder's disc, beside its exclamation mark. */
const IN_DISC = [[215, 135]] as const
const RED = [220, 40, 40], GREEN = [40, 200, 60], BLUE = [40, 40, 220]
const css = (color: number[]) => `rgb(${color.join(',')})`
const shows = (color: number[]) => (s: Sample[]) => rgb(s[0]!).join() === color.join()
/** The placeholder's disc is the app's destructive red (MotifSprite.ts). */
const placeholder = ([s]: Sample[]) => s!.r > 200 && s!.g < 150 && s!.b < 150 && s!.a === 255

interface CaptureLane { motifId: string; pageLoads: number }

/** Pages capture hosts loaded for Motif `id` since launch. */
const pageLoads = async (page: Page, id: string) =>
  (await invokeCmd<{ lanes: CaptureLane[] }>(page, 'motif_capture_diagnostics')).lanes
    .filter(lane => lane.motifId === id).reduce((n, lane) => n + lane.pageLoads, 0)

/** Records, in the main process, the host of every Motif cover the renderer
 *  asks for (`motif_get_cover` on either backend channel). */
async function recordCoverRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as any
    g.__coverRequests = []
    const handlers = ipcMain._invokeHandlers
    for (const channel of ['backend:invoke', 'backend:invokePublished']) {
      const handler = handlers.get(channel)!
      handlers.set(channel, (event, request) => {
        if (request?.channel === 'motif_get_cover') g.__coverRequests.push(request.args?.id)
        return handler(event, request)
      })
    }
  })
}
const coverRequests = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__coverRequests as string[])

/** The open project's untrusted Motifs as `project://session` names them. */
async function sessionUntrusted(client: Client): Promise<Array<{ motif_id: string; revision: string }>> {
  const session = await client.readResource({ uri: 'project://session' })
  return JSON.parse((session.contents[0] as { text: string }).text).motifs.untrusted
}

/** An agent's tool call that must succeed; answers its JSON. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
}

test('a project received from another machine runs no Motif code until the user trusts it', async () => {
  test.setTimeout(300_000)
  // Made on the first profile, where its code ran.
  let running = await launchApp()
  let projectPath = '', id = '', revision = ''
  try {
    await newProject(running.page, { parentFolder: tmpDir('weftcut-trust-made-'), name: 'Received', canvas: CANVAS })
    await waitForHook(running.page, 'addMotifLayer')
    id = await createMotif(running.page, manifest('Received fill'), fillPage(FULL, css(BLUE)))
    await addLayer(running.page, id, 2_000_000)
    await settledSamples(running.page, 500_000, IN_DISC, shows(BLUE), 'the Motif renders where it was made')
    revision = (await projectRow(running.page, id))!.revision!
    projectPath = await invokeCmd<string>(running.page, 'workspace_dir')
  } finally { await running.app.close() }

  // The folder as another machine receives it, without its frame cache.
  const copy = path.join(tmpDir('weftcut-trust-copy-'), 'Received')
  cpSync(projectPath, copy, { recursive: true, filter: source => path.relative(projectPath, source).split(path.sep)[0] !== 'Cache' })

  const second = tmpDir('weftcut-trust-second-')
  running = await launchApp({ userDataDir: second })
  let client: Client | null = null
  try {
    const { app, page } = running
    await recordCoverRequests(app)
    await reopen(page, copy)
    expect(await projectRow(page, id)).toMatchObject({ status: 'untrusted', revision })
    client = await connectMcp(page, 'e2e-motif-trust')
    expect(await sessionUntrusted(client)).toEqual([expect.objectContaining({ motif_id: id, revision })])
    await settledSamples(page, 500_000, IN_DISC, placeholder, 'the untrusted Motif shows the error placeholder')

    // An agent reads it as text; nothing renders it.
    const read = await call(client, 'read_motif', { motif_id: id, path: 'index.html' })
    expect(read).toMatchObject({ motif_id: id, revision })
    expect(read.text).toContain(css(BLUE))
    const preview = await client.callTool({ name: 'preview_motif', arguments: { motif_id: id, local_t_s: [0] } })
    expect(preview.isError).toBe(true)
    expect(preview.structuredContent).toMatchObject({ error: 'MotifUntrusted', id, revision })
    const output = path.join(tmpDir('weftcut-trust-out-'), 'received.mp4')
    const exported = await client.callTool({ name: 'start_export', arguments: { request_id: 'untrusted-motif', output_path: output } })
    expect(exported.isError).toBe(true)
    expect(exported.structuredContent).toMatchObject({ error: 'MotifUnavailable', motif_ids: [id] })
    expect(existsSync(output)).toBe(false)

    // The Motifs panel lists it as not trusted and offers the card.
    await page.getByRole('menuitem', { name: 'Insert', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Motifs…', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Motifs', exact: true })
    const card = picker.getByRole('region', { name: 'This project', exact: true }).locator('.motif-card')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.motif-card-status')).toHaveText('Not trusted')
    await card.locator('.motif-card-select').click()
    const trustCard = picker.getByRole('region', { name: 'Not trusted on this machine', exact: true })
    await expect(trustCard.getByRole('button', { name: 'Trust', exact: true })).toBeEnabled()

    // Until now its code ran nowhere: the panel asked covers of the library's
    // Motifs and not of it, and no capture host loaded it.
    await expect.poll(async () => (await coverRequests(app)).length, { message: 'the panel asks for its covers' }).toBeGreaterThan(0)
    expect(await coverRequests(app), 'no cover of the untrusted Motif was asked for').not.toContain(id)
    expect(await pageLoads(page, id), 'no capture host loaded the untrusted Motif').toBe(0)

    // The user's Trust: the row renders, and the same records now see it run.
    await trustCard.getByRole('button', { name: 'Trust', exact: true }).click()
    await expect.poll(async () => (await projectRow(page, id))?.status).toBe('ok')
    await expect(trustCard).toHaveCount(0)
    expect(await sessionUntrusted(client)).toEqual([])
    await settledSamples(page, 500_000, IN_DISC, shows(BLUE), 'the trusted Motif renders its colour')
    expect(await pageLoads(page, id), 'a capture host loads the trusted Motif').toBeGreaterThan(0)
    await expect.poll(() => coverRequests(app), { message: 'its card asks for its cover' }).toContain(id)
  } finally {
    await client?.close()
    await running.app.close()
  }

  // The Trust is this machine's record: it outlives the session.
  running = await launchApp({ userDataDir: second })
  try {
    await reopen(running.page, copy)
    expect(await projectRow(running.page, id)).toMatchObject({ status: 'ok', revision })
    await settledSamples(running.page, 500_000, IN_DISC, shows(BLUE), 'the Motif renders after a restart')
  } finally { await running.app.close() }
})

test('edits made while the project is open here never ask for trust', async () => {
  test.setTimeout(240_000)
  const profile = tmpDir('weftcut-trust-edits-')
  let running = await launchApp({ userDataDir: profile })
  let client: Client | null = null
  let projectPath = '', id = '', written = ''
  try {
    const { page } = running
    await newProject(page, { parentFolder: tmpDir('weftcut-trust-edits-project-'), name: 'Edited here', canvas: CANVAS })
    await waitForHook(page, 'addMotifLayer')
    id = await createMotif(page, manifest('Edited here'), fillPage(FULL, css(RED)))
    await addLayer(page, id, 2_000_000)
    projectPath = await invokeCmd<string>(page, 'workspace_dir')
    client = await connectMcp(page, 'e2e-motif-trust')

    // An agent's edit through its tool.
    const read = await call(client, 'read_motif', { motif_id: id })
    const edited = await call(client, 'update_motif_files', { motif_id: id, expected_revision: read.revision,
      files: [{ path: 'index.html', edits: [{ old: css(RED), new: css(GREEN) }] }] })
    expect(await projectRow(page, id)).toMatchObject({ status: 'ok', revision: edited.revision })
    await settledSamples(page, 500_000, IN_DISC, shows(GREEN), 'the tool edit renders')

    // An agent's write with its own file tools, then its preview of it.
    const index = path.join((await projectRow(page, id))!.path, 'index.html')
    writeFileSync(index, readFileSync(index, 'utf8').replace(css(GREEN), css(BLUE)))
    const preview = await client.callTool({ name: 'preview_motif', arguments: { motif_id: id, local_t_s: [0] } })
    // Read at once, before the watcher has heard the write.
    expect((preview.structuredContent as { error?: string } | undefined)?.error,
      'an edit made while the project is open is never refused as untrusted').not.toBe('MotifUntrusted')
    // Heard by the project's watcher as an edit made here.
    await expect.poll(async () => {
      const row = await projectRow(page, id)
      written = row?.status === 'ok' && row.revision !== edited.revision ? row.revision! : ''
      return written
    }).not.toBe('')
    expect(await sessionUntrusted(client)).toEqual([])
    await settledSamples(page, 500_000, IN_DISC, shows(BLUE), 'the file write renders')

    // Opened again, nothing asks.
    await reopen(page, projectPath)
    expect(await projectRow(page, id)).toMatchObject({ status: 'ok', revision: written })
    expect(await sessionUntrusted(client)).toEqual([])
  } finally {
    await client?.close()
    await running.app.close()
  }

  // Nor after a restart: the edits were recorded as trusted.
  running = await launchApp({ userDataDir: profile })
  try {
    await reopen(running.page, projectPath)
    expect(await projectRow(running.page, id)).toMatchObject({ status: 'ok', revision: written })
    await settledSamples(running.page, 500_000, IN_DISC, shows(BLUE), 'the edited Motif renders after a restart')
  } finally { await running.app.close() }
})

test('an edit made while the project was closed asks for trust', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  let client: Client | null = null
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-trust-closed-'), name: 'Closed edit', canvas: CANVAS })
    await waitForHook(page, 'addMotifLayer')
    const id = await createMotif(page, manifest('Closed edit'), fillPage(FULL, css(RED)))
    await addLayer(page, id, 2_000_000)
    await settledSamples(page, 500_000, IN_DISC, shows(RED), 'the Motif renders')
    const projectPath = await invokeCmd<string>(page, 'workspace_dir')
    const before = (await projectRow(page, id))!

    // Another project opens; this one's folder is edited while it is closed.
    await newProject(page, { parentFolder: tmpDir('weftcut-trust-closed-other-'), name: 'Elsewhere', canvas: CANVAS })
    const index = path.join(before.path, 'index.html')
    writeFileSync(index, readFileSync(index, 'utf8').replace(css(RED), css(BLUE)))

    await reopen(page, projectPath)
    const row = await projectRow(page, id)
    expect(row).toMatchObject({ status: 'untrusted' })
    expect(row!.revision).not.toBe(before.revision)
    client = await connectMcp(page, 'e2e-motif-trust')
    expect(await sessionUntrusted(client)).toEqual([expect.objectContaining({ motif_id: id, revision: row!.revision })])
    await settledSamples(page, 500_000, IN_DISC, placeholder, 'the edited Motif shows the error placeholder')
    // The open recorded the change as found, never as an edit made here.
    expect(await projectRow(page, id)).toMatchObject({ status: 'untrusted', revision: row!.revision })
  } finally {
    await client?.close()
    await app.close()
  }
})

test('a ZIP imports untrusted unless it holds a version this library exported', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    // A Motif saved to this library, exported as the panel's Export Motif ZIP is.
    await newProject(page, { parentFolder: tmpDir('weftcut-trust-zip-source-'), name: 'Source', canvas: CANVAS })
    const made = await createMotif(page, manifest('Shared badge'), fillPage(FULL, css(RED)))
    const libraryId = await saveMotifToLibrary(page, made)
    const zips = tmpDir('weftcut-trust-zips-')
    const fromLibrary = path.join(zips, 'library.zip')
    await invokeCmd(page, 'export_motif', { motif_id: libraryId, group: 'library', path: fromLibrary })
    // A ZIP made anywhere else: bytes this machine never held.
    const fromElsewhere = path.join(zips, 'elsewhere.zip')
    writeFileSync(fromElsewhere, zipSync({
      'manifest.json': Buffer.from(JSON.stringify(manifest('Foreign badge'))),
      'index.html': Buffer.from(fillPage(FULL, css(BLUE))),
    }))

    // Imported into a project that holds neither.
    await newProject(page, { parentFolder: tmpDir('weftcut-trust-zip-target-'), name: 'Imports', canvas: CANVAS })
    const imported = async (zip: string) =>
      (await invokeCmd<{ motif_id: string }>(page, 'create_motif', { source: { kind: 'zip', path: zip } })).motif_id
    const library = await imported(fromLibrary)
    const elsewhere = await imported(fromElsewhere)
    expect(await projectRow(page, library), 'the library\'s own bytes are trusted').toMatchObject({ status: 'ok' })
    expect(await projectRow(page, elsewhere), 'bytes from elsewhere ask').toMatchObject({ status: 'untrusted' })
    // Again, beside the copy the project now holds: renamed, still trusted.
    const beside = await imported(fromLibrary)
    expect(beside).not.toBe(library)
    expect(await projectRow(page, beside), 'renaming keeps the library\'s bytes trusted').toMatchObject({ status: 'ok' })
  } finally { await app.close() }
})
