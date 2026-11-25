// e2e gate: a project Motif runs only when trusted on this machine: its
// revision (ADR 0174) or its project's folder (ADR 0182). Each test is one
// acceptance line of trust:
//   - a project received from another machine runs none of its Motifs' code
//     until the user trusts the project in the dialog it opens with; the
//     dialog asks once per folder, and Later is remembered;
//   - a trusted project runs Motifs edited while WeftCut was closed, and
//     stops when the user stops trusting it;
//   - edits made while the project is open here never ask;
//   - an edit made while an untrusted project was closed asks;
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

/** The renderer-only channels that decide a project's trust: none is an
 *  agent's tool. */
const TRUST_CHANNELS = ['project_trust_summary', 'trust_project', 'untrust_project', 'dismiss_project_trust']

/** The project trust dialog, wherever it was opened from. */
const trustDialog = (page: Page) => page.getByRole('dialog', { name: 'Run this project\'s Motifs?', exact: true })

interface CaptureLane { motifId: string; pageLoads: number }

/** Pages capture hosts loaded for Motif `id` since launch. */
const pageLoads = async (page: Page, id: string) =>
  (await invokeCmd<{ lanes: CaptureLane[] }>(page, 'motif_capture_diagnostics')).lanes
    .filter(lane => lane.motifId === id).reduce((n, lane) => n + lane.pageLoads, 0)

interface TrustAnswer { project: string; trusted: boolean; dismissed: boolean; prompt: boolean }

/** Records, in the main process, the host of every Motif cover the renderer
 *  asks for (`motif_get_cover`) and every answered `project_trust_summary`,
 *  on either backend channel. */
async function recordBackend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as any
    g.__coverRequests = []
    g.__trustAnswers = []
    const handlers = ipcMain._invokeHandlers
    for (const channel of ['backend:invoke', 'backend:invokePublished']) {
      const handler = handlers.get(channel)!
      handlers.set(channel, async (event, request) => {
        if (request?.channel === 'motif_get_cover') g.__coverRequests.push(request.args?.id)
        const answer = await handler(event, request)
        // The published channel answers `{ value, publication }`.
        if (request?.channel === 'project_trust_summary') g.__trustAnswers.push(channel === 'backend:invokePublished' ? answer.value : answer)
        return answer
      })
    }
  })
}
const coverRequests = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__coverRequests as string[])
const trustAnswers = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__trustAnswers as TrustAnswer[])
const forgetTrustAnswers = (app: ElectronApplication) => app.evaluate(() => { (globalThis as any).__trustAnswers = [] })

/** Opens the project at `projectPath` and waits until the editor read its
 *  trust state, which decides whether the dialog opens by itself. Answers
 *  that first state; the caller says what it should be. */
async function reopenRead(app: ElectronApplication, page: Page, projectPath: string): Promise<TrustAnswer> {
  await forgetTrustAnswers(app)
  await reopen(page, projectPath)
  const name = path.basename(projectPath)
  let first: TrustAnswer | undefined
  await expect.poll(async () => {
    first = (await trustAnswers(app)).find(answer => answer.project === name)
    return first !== undefined
  }, { message: `the editor reads ${name}'s trust state` }).toBe(true)
  return first!
}

/** The dialog stays shut once the editor has read a state that does not ask:
 *  main answered before the renderer acted on it, so one round trip and one
 *  frame pass before the dialog is counted. */
async function expectNoDialog(page: Page): Promise<void> {
  await invokeCmd(page, 'list_motifs', { group: 'project' })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))))
  await expect(trustDialog(page)).toHaveCount(0)
}

/** The open project's state as `project://session` tells an agent. */
async function session(client: Client): Promise<{ project: { trusted: boolean }; motifs: { untrusted: Array<{ motif_id: string; revision: string }> } }> {
  const read = await client.readResource({ uri: 'project://session' })
  return JSON.parse((read.contents[0] as { text: string }).text)
}

/** An agent's tool call that must succeed; answers its JSON. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
}

/** The project folder at `projectPath` as another machine receives it,
 *  without its frame cache, in a new folder named `name`. */
function receive(projectPath: string, name: string): string {
  const copy = path.join(tmpDir('weftcut-trust-copy-'), name)
  cpSync(projectPath, copy, { recursive: true, filter: source => path.relative(projectPath, source).split(path.sep)[0] !== 'Cache' })
  return copy
}

/** Opens the Motifs panel from the Insert menu. */
async function openMotifsPanel(page: Page) {
  await page.getByRole('menuitem', { name: 'Insert', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Motifs…', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Motifs', exact: true })
  await expect(picker).toBeVisible()
  return picker
}

/** Chooses File > `item`. */
async function fileMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test('a received project runs no Motif code until the user trusts it, and asks once per folder', async () => {
  test.setTimeout(420_000)
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

  // Received twice, in two folders: one the user puts off, one they trust.
  const putOff = receive(projectPath, 'Put off')
  const received = receive(projectPath, 'Received')

  const second = tmpDir('weftcut-trust-second-')
  running = await launchApp({ userDataDir: second })
  let client: Client | null = null
  try {
    const { app, page } = running
    await recordBackend(app)

    // Opened, it asks by itself. Later puts the question off for the folder.
    expect(await reopenRead(app, page, putOff)).toMatchObject({ trusted: false, dismissed: false, prompt: true })
    await expect(trustDialog(page)).toBeVisible()
    await trustDialog(page).getByRole('button', { name: 'Later', exact: true }).click()
    await expect(trustDialog(page)).toHaveCount(0)
    await expect.poll(async () => (await invokeCmd<TrustAnswer>(page, 'project_trust_summary', { summaries: false })).dismissed,
      { message: 'Later is recorded for the folder' }).toBe(true)
    expect(await projectRow(page, id)).toMatchObject({ status: 'untrusted', revision })

    // Opened again, it does not ask; the Motifs panel still offers the trust.
    expect(await reopenRead(app, page, putOff)).toMatchObject({ trusted: false, dismissed: true, prompt: false })
    await expectNoDialog(page)
    const picker = await openMotifsPanel(page)
    const projectGroup = picker.getByRole('region', { name: 'This project', exact: true })
    await expect(projectGroup.getByText('1 not trusted', { exact: true })).toBeVisible()
    await expect(projectGroup.getByRole('button', { name: 'Trust this project…', exact: true })).toBeEnabled()
    // Its code ran nowhere: the panel asked covers of the library's Motifs
    // and not of it, and no capture host loaded it.
    await expect.poll(async () => (await coverRequests(app)).length, { message: 'the panel asks for its covers' }).toBeGreaterThan(0)
    expect(await coverRequests(app), 'no cover of the untrusted Motif was asked for').not.toContain(id)
    expect(await pageLoads(page, id), 'no capture host loaded the untrusted Motif').toBe(0)
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)

    // The other folder asks by itself, untouched by the first one's Later.
    expect(await reopenRead(app, page, received)).toMatchObject({ trusted: false, dismissed: false, prompt: true })
    const dialog = trustDialog(page)
    await expect(dialog).toBeVisible()
    expect(await projectRow(page, id)).toMatchObject({ status: 'untrusted', revision })
    client = await connectMcp(page, 'e2e-motif-trust')
    expect(await session(client)).toMatchObject({ project: { trusted: false }, motifs: { untrusted: [expect.objectContaining({ motif_id: id, revision })] } })
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

    // Nor can an agent trust it: the trust channels are not its tools.
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    for (const channel of TRUST_CHANNELS) expect(tools, `${channel} is not an MCP tool`).not.toContain(channel)
    const refused = await client.callTool({ name: 'trust_project', arguments: { revisions: { [id]: revision } } })
      .then(result => result.isError === true, () => true)
    expect(refused, 'an agent\'s trust_project is refused').toBe(true)
    expect(await projectRow(page, id)).toMatchObject({ status: 'untrusted', revision })
    expect(await pageLoads(page, id), 'no capture host loaded the untrusted Motif').toBe(0)

    // The dialog names what waits, and hands an agent a read-only check.
    await dialog.getByText('Show 1 Motif', { exact: true }).click()
    await expect(dialog.getByText('Received fill', { exact: true })).toBeVisible()
    // Clipboard access is gated on document focus.
    await (await app.browserWindow(page)).evaluate(window => window.focus())
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5_000 }).toBe(true)
    await dialog.getByRole('button', { name: 'Ask an agent to check first', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('Copied')
    await expect(dialog, 'copying the prompt leaves the decision open').toBeVisible()
    await expect.poll(() => app.evaluate(async ({ clipboard }) => await clipboard.readText()), { timeout: 5_000 })
      .toMatch(/read_motif[\s\S]*project:\/\/session|project:\/\/session[\s\S]*read_motif/)

    // The user's Trust: the Motif renders, and the same records now see it run.
    await dialog.getByRole('button', { name: 'Trust this project', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await projectRow(page, id))?.status).toBe('ok')
    expect(await session(client)).toMatchObject({ project: { trusted: true }, motifs: { untrusted: [] } })
    await settledSamples(page, 500_000, IN_DISC, shows(BLUE), 'the trusted Motif renders its colour')
    expect(await pageLoads(page, id), 'a capture host loads the trusted Motif').toBeGreaterThan(0)
    await openMotifsPanel(page)
    await expect.poll(() => coverRequests(app), { message: 'its card asks for its cover' }).toContain(id)
  } finally {
    await client?.close()
    await running.app.close()
  }

  // Both answers are this machine's record: they outlive the session.
  running = await launchApp({ userDataDir: second })
  try {
    const { app, page } = running
    await recordBackend(app)
    expect(await reopenRead(app, page, received)).toMatchObject({ trusted: true, prompt: false })
    await expectNoDialog(page)
    expect(await projectRow(page, id)).toMatchObject({ status: 'ok', revision })
    await settledSamples(page, 500_000, IN_DISC, shows(BLUE), 'the Motif renders after a restart')
    // The trust stays with its folder: the same bytes in the put-off one
    // still wait, and the question stays put off.
    expect(await reopenRead(app, page, putOff)).toMatchObject({ trusted: false, dismissed: true, prompt: false })
    await expectNoDialog(page)
    expect(await projectRow(page, id)).toMatchObject({ status: 'untrusted', revision })
  } finally { await running.app.close() }
})

test('a trusted project runs Motifs edited while WeftCut was closed, until the user stops trusting it', async () => {
  test.setTimeout(300_000)
  const profile = tmpDir('weftcut-trust-folder-')
  let running = await launchApp({ userDataDir: profile })
  let projectPath = '', id = '', before = '', folder = ''
  try {
    const { page } = running
    await newProject(page, { parentFolder: tmpDir('weftcut-trust-folder-project-'), name: 'Trusted here', canvas: CANVAS })
    await waitForHook(page, 'addMotifLayer')
    id = await createMotif(page, manifest('Trusted here'), fillPage(FULL, css(RED)))
    await addLayer(page, id, 2_000_000)
    await settledSamples(page, 500_000, IN_DISC, shows(RED), 'the Motif renders')
    projectPath = await invokeCmd<string>(page, 'workspace_dir')
    const made = (await projectRow(page, id))!
    before = made.revision!
    folder = made.path

    // Nothing waits, and the user trusts the project from the File menu.
    await fileMenu(page, 'Trust this project…')
    await trustDialog(page).getByRole('button', { name: 'Trust this project', exact: true }).click()
    await expect(trustDialog(page)).toHaveCount(0)
    await expect.poll(async () => (await invokeCmd<TrustAnswer>(page, 'project_trust_summary', { summaries: false })).trusted).toBe(true)
  } finally { await running.app.close() }

  // Edited while WeftCut is closed, as a sync or the user's editor would.
  const index = path.join(folder, 'index.html')
  writeFileSync(index, readFileSync(index, 'utf8').replace(css(RED), css(GREEN)))

  running = await launchApp({ userDataDir: profile })
  let client: Client | null = null
  try {
    const { app, page } = running
    await recordBackend(app)
    expect(await reopenRead(app, page, projectPath)).toMatchObject({ trusted: true, prompt: false })
    await expectNoDialog(page)
    const row = await projectRow(page, id)
    expect(row).toMatchObject({ status: 'ok' })
    expect(row!.revision).not.toBe(before)
    await settledSamples(page, 500_000, IN_DISC, shows(GREEN), 'the edit renders without asking')
    // One quiet row in the log names it.
    await expect.poll(async () => (await invokeCmd<Array<{ level: string; details?: { kind?: string; motif_ids?: string[] } }>>(page, 'log_list'))
      .filter(entry => entry.details?.kind === 'TrustedMotifsChangedWhileClosed')
      .map(entry => ({ level: entry.level, motif_ids: entry.details!.motif_ids })), { message: 'the log names the Motif changed while closed' })
      .toEqual([{ level: 'info', motif_ids: [id] }])

    // Stop trusting: the Motif the folder alone let run stops at once.
    await fileMenu(page, 'Stop trusting this project')
    await expect.poll(async () => (await projectRow(page, id))?.status, { message: 'the Motif is untrusted again' }).toBe('untrusted')
    client = await connectMcp(page, 'e2e-motif-trust')
    expect(await session(client)).toMatchObject({ project: { trusted: false }, motifs: { untrusted: [expect.objectContaining({ motif_id: id })] } })
    const preview = await client.callTool({ name: 'preview_motif', arguments: { motif_id: id, local_t_s: [0] } })
    expect(preview.structuredContent).toMatchObject({ error: 'MotifUntrusted', id })
    await settledSamples(page, 500_000, IN_DISC, placeholder, 'the untrusted Motif shows the error placeholder')
    // It does not ask again, and the menu offers the trust back.
    await expectNoDialog(page)
    await page.getByRole('menuitem', { name: 'File', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Trust this project…', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    await client?.close()
    await running.app.close()
  }
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
    expect((await session(client)).motifs.untrusted).toEqual([])
    await settledSamples(page, 500_000, IN_DISC, shows(BLUE), 'the file write renders')

    // Opened again, nothing asks.
    await reopen(page, projectPath)
    expect(await projectRow(page, id)).toMatchObject({ status: 'ok', revision: written })
    expect((await session(client)).motifs.untrusted).toEqual([])
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

test('an edit made while an untrusted project was closed asks for trust', async () => {
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

    // Opened again, it asks by itself.
    await reopen(page, projectPath)
    await expect(trustDialog(page)).toBeVisible()
    const row = await projectRow(page, id)
    expect(row).toMatchObject({ status: 'untrusted' })
    expect(row!.revision).not.toBe(before.revision)
    client = await connectMcp(page, 'e2e-motif-trust')
    expect((await session(client)).motifs.untrusted).toEqual([expect.objectContaining({ motif_id: id, revision: row!.revision })])
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
