import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { invokeCmd, launchApp, newProject, summary, tmpDir } from './helpers/driver'
import { AUTOSAVE_INTERVAL_MIN_SECS, SAVE_STATUS_CHANNEL, type SaveStatus } from '../../src/shared/save-status'
import { MOTIF_BAKE_READY_EVENT } from '../../src/shared/motifs/baking'
import { ATOMIC_TEMP_SUFFIX } from '../../src/main/atomicWrite'
import { QUIT_SAVE_CHOICES, quitSaveDialog, type QuitSaveChoice } from '../../src/main/quitSave'
import enUS from '../../src/renderer/i18n/locales/en-US'

// Quitting a project that cannot be saved (docs/data-model.md § Saving): the
// question the quit asks, and on which window, what each answer leaves on disk
// and running, that opening alone is not unsaved, and the save-failure card's
// Open folder. Saves fail as in save-failure-status.spec.ts: a directory where
// atomicWrite puts its temp file.
//
// The native dialog and the file manager are replaced in main: a test can
// answer neither, and a real opener on a headless runner wedges the quit.

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
/** The badge appears at the first failed write once the edit has waited the
 *  interval — a liveness bound, generous for a loaded runner. */
const BADGE_WITHIN_MS = AUTOSAVE_INTERVAL_MIN_SECS * 1000 * 6
/** Liveness bounds: the quit's save is one write, and the teardown after it
 *  waits on every window and child. */
const ASKED_WITHIN_MS = 30_000
const EXITED_WITHIN_MS = 60_000
/** The dialog as main builds it in en-US, with an empty reason. */
const QUIT_DIALOG = quitSaveDialog(false, '')
/** Quiet window for a state that must NOT turn: were an untouched open
 *  counted as unsaved, its failing writes would turn Not saved at the
 *  interval's deadline, armed at the latest by the first write half a second
 *  after the open. Two intervals cover both. */
const NOT_SAVED_QUIET_MS = AUTOSAVE_INTERVAL_MIN_SECS * 1000 * 2

interface DialogCall {
  /** Asked with a parent window, so the question is attached to the editor. */
  parented: boolean
  options: ReturnType<typeof quitSaveDialog>
}

function layerIds(projectFile: string): string[] {
  const p = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as { compositions: Record<string, { tracks: Array<{ layers: Array<{ id: string }> }> }> }
  return Object.values(p.compositions).flatMap((c) => c.tracks.flatMap((t) => t.layers.map((l) => l.id)))
}

interface FastAutosaveProject {
  dir: string
  projectFile: string
  /** Made a directory, it makes every write of `projectFile` fail. */
  blocker: string
}

/** A project with the shortest autosave interval, so the Not saved state turns
 *  within seconds; not opened yet. */
async function writeFastAutosaveProject(page: Page): Promise<FastAutosaveProject> {
  const parent = tmpDir('weftcut-save-failure-quit-')
  await newProject(page, { parentFolder: parent, name: 'seed', canvas: CANVAS })
  await invokeCmd(page, 'project_save')
  const seed = JSON.parse(fs.readFileSync(path.join(parent, 'seed', 'project.json'), 'utf8'))
  seed.settings.autosave_interval_secs = AUTOSAVE_INTERVAL_MIN_SECS
  const dir = path.join(parent, 'fast-autosave')
  const projectFile = path.join(dir, 'project.json')
  fs.mkdirSync(dir)
  fs.writeFileSync(projectFile, JSON.stringify(seed))
  return { dir, projectFile, blocker: projectFile + ATOMIC_TEMP_SUFFIX }
}

async function openProject(page: Page, dir: string): Promise<void> {
  await invokeCmd(page, 'project_open', { path: dir })
  await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
}

/** The fast-autosave project, open with nothing unsaved: the file holds what
 *  the load made of it, so opening leaves nothing to write. */
async function openFastAutosaveProject(page: Page): Promise<FastAutosaveProject> {
  const project = await writeFastAutosaveProject(page)
  await openProject(page, project.dir)
  return project
}

const addLayer = (page: Page): Promise<string> => invokeCmd<string>(page, 'add_color_layer', {
  tStartUs: 0, durationUs: 1_000_000, color: { r: 200, g: 40, b: 40, a: 255 },
})

/** Replaces main's message box: every question is appended to `record` (a file,
 *  so it outlives an app that quits) and answered `answer`. `removeFirst` is
 *  deleted before answering, as a user clears the cause before pressing Retry. */
async function answerQuitDialog(app: ElectronApplication, record: string, answer: QuitSaveChoice, removeFirst?: string): Promise<void> {
  await app.evaluate(({ dialog, BrowserWindow }, a) => {
    const fs = process.getBuiltinModule('node:fs')
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const parented = args[0] instanceof BrowserWindow
      fs.appendFileSync(a.record, `${JSON.stringify({ parented, options: parented ? args[1] : args[0] })}\n`)
      if (a.removeFirst !== null) fs.rmSync(a.removeFirst, { recursive: true })
      return { response: a.response, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, { record, response: QUIT_SAVE_CHOICES.indexOf(answer), removeFirst: removeFirst ?? null })
}

function dialogCalls(record: string): DialogCall[] {
  if (!fs.existsSync(record)) return []
  return fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as DialogCall)
}

function expectQuitSaveQuestion(call: DialogCall | undefined): void {
  expect(call?.parented).toBe(true)
  const { detail, ...fixed } = QUIT_DIALOG
  expect(call?.options).toMatchObject(fixed)
  // The reason is the system's own message, after the fixed text.
  expect(call?.options.detail.startsWith(detail)).toBe(true)
  expect(call!.options.detail.length).toBeGreaterThan(detail.length)
}

/** What main sends the editor as a project switch begins
 *  (onWorkspaceChanging, which also resets main's derivative jobs, Motif bakes
 *  and audio-effect baker; the editor drops its queued imports and export
 *  handshake on it) and as one ends (onWorkspaceOpened). */
const WORKSPACE_SIGNALS = ['evt:project:workspace-changing', `evt:${MOTIF_BAKE_READY_EVENT}`]

/** Records, in main, every workspace signal sent to the editor from now on. */
async function recordWorkspaceSignals(app: ElectronApplication, page: Page): Promise<void> {
  const editor = await app.browserWindow(page)
  await editor.evaluate((w, channels) => {
    const sent: string[] = []
    ;(globalThis as { __workspaceSignals?: string[] }).__workspaceSignals = sent
    const wc = w.webContents
    const send = wc.send.bind(wc)
    wc.send = ((channel: string, ...args: unknown[]) => {
      if (channels.includes(channel)) sent.push(channel)
      send(channel, ...args)
    }) as typeof wc.send
  }, WORKSPACE_SIGNALS)
}

const workspaceSignals = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __workspaceSignals?: string[] }).__workspaceSignals ?? [])

/** Quit as the app menu and Cmd+Q do. */
async function quit(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => { app.quit() })
}

/** Quit, and wait for the process to end. Its close event is the witness: the
 *  quit's own call may lose its reply to the exit. */
async function quitToExit(app: ElectronApplication): Promise<void> {
  await Promise.all([
    app.waitForEvent('close', { timeout: EXITED_WITHIN_MS }),
    quit(app).catch(() => { /* the close event decides */ }),
  ])
}

/** The titlebar ✕ (`window:close`, as app-quit.spec.ts presses it). The invoke
 *  never resolves when the window goes, so it is not awaited. */
function pressCloseButton(page: Page): void {
  void page
    .evaluate(() => void (window as unknown as { api: { window: { close(): Promise<void> } } }).api.window.close())
    .catch(() => { /* the window went away */ })
}

/** Close a test's app, whatever state it was left in. A question left to a
 *  Cancel stub, or to the real dialog no test can answer, would hold the quit:
 *  every question is answered Quit Without Saving first. */
async function closeApp(app: ElectronApplication): Promise<void> {
  // Once the app has exited, Playwright has dropped the process handle and
  // `process()` throws rather than answering.
  let proc: ReturnType<ElectronApplication['process']> | null = null
  try { proc = app.process() } catch { /* exited */ }
  if (proc === null || proc.exitCode !== null || proc.signalCode !== null) {
    await app.close().catch(() => { /* already exited; the wrapper still reaps the temp dir */ })
    return
  }
  await app.evaluate(({ dialog }, discard) => {
    dialog.showMessageBox = (async () => ({ response: discard, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, QUIT_SAVE_CHOICES.indexOf('discard')).catch(() => { /* exiting already */ })
  await app.close()
}

/** One spelling per folder, so main's path and the test's compare. */
function samePath(p: string): string {
  const real = fs.realpathSync.native(p)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

test('a quit that cannot save asks first: Cancel keeps the app editing, Retry once the cause is gone saves every edit and quits', async () => {
  test.setTimeout(120_000 + BADGE_WITHIN_MS)
  const { app, page } = await launchApp()
  const record = test.info().outputPath('quit-dialog.jsonl')
  try {
    const { projectFile, blocker } = await openFastAutosaveProject(page)
    fs.mkdirSync(blocker)
    const first = await addLayer(page)
    const badge = page.getByTestId('save-status-badge')
    await expect(badge).toBeVisible({ timeout: BADGE_WITHIN_MS })

    await answerQuitDialog(app, record, 'cancel')
    await recordWorkspaceSignals(app, page)
    await quit(app)
    await expect.poll(() => dialogCalls(record).length, { timeout: ASKED_WITHIN_MS }).toBe(1)
    // Closing the last window saves before the window goes (main's 'close'
    // handler, not before-quit). A quit still settling would be joined, not
    // asked again: the second question also proves the first ended in Cancel.
    pressCloseButton(page)
    await expect.poll(() => dialogCalls(record).length, { timeout: ASKED_WITHIN_MS }).toBe(2)
    for (const call of dialogCalls(record)) expectQuitSaveQuestion(call)

    expect(app.process().exitCode).toBeNull()
    const win = await app.browserWindow(page)
    expect(await win.evaluate((w) => !w.isDestroyed() && w.isVisible())).toBe(true)
    const second = await addLayer(page)
    const live = (await summary(page)).tracks.flatMap((t) => t.layers.map((l) => l.id))
    expect(live).toEqual(expect.arrayContaining([first, second]))
    await expect(badge).toBeVisible()
    expect(layerIds(projectFile)).not.toContain(first)
    // The failed saves aborted the close before it began: nothing working for
    // the project was told it was changing, or reset.
    expect(await workspaceSignals(app)).toEqual([])

    await answerQuitDialog(app, record, 'retry', blocker)
    await quitToExit(app)
    // Asked once more, with the cause still there; the edits reached the disk
    // only through the save Retry ran after it was removed.
    expect(dialogCalls(record)).toHaveLength(3)
    expectQuitSaveQuestion(dialogCalls(record)[2])
    expect(fs.existsSync(blocker)).toBe(false)
    expect(layerIds(projectFile)).toEqual(expect.arrayContaining([first, second]))
  } finally {
    await closeApp(app)
  }
})

test('Quit Without Saving quits and leaves the last good project.json untouched', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const record = test.info().outputPath('quit-dialog.jsonl')
  try {
    const { projectFile, blocker } = await openFastAutosaveProject(page)
    fs.mkdirSync(blocker)
    const unsaved = await addLayer(page)
    const lastGood = fs.readFileSync(projectFile)
    expect(layerIds(projectFile)).not.toContain(unsaved)

    await answerQuitDialog(app, record, 'discard')
    await quitToExit(app)
    expect(dialogCalls(record)).toHaveLength(1)
    expectQuitSaveQuestion(dialogCalls(record)[0])
    // Nothing written after the answer: the file is byte for byte the last
    // good one, and the blocker no write could have got past is still there.
    expect(fs.readFileSync(projectFile).equals(lastGood)).toBe(true)
    expect(fs.statSync(blocker).isDirectory()).toBe(true)
  } finally {
    await closeApp(app)
  }
})

// The save fails here too: with nothing unsaved, no edit is lost by quitting,
// so the failure itself must not ask (settleQuitSave).
test('a quit with nothing unsaved asks nothing, even when the save fails', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const record = test.info().outputPath('quit-dialog.jsonl')
  try {
    const { blocker } = await openFastAutosaveProject(page)
    fs.mkdirSync(blocker)

    await answerQuitDialog(app, record, 'discard')
    await quitToExit(app)
    expect(dialogCalls(record)).toEqual([])
  } finally {
    await closeApp(app)
  }
})

// Opening is not an edit: a project whose file already holds it has nothing
// to save, so a folder no save can land in says nothing until the user edits.
test('a project opened where no save can land, and not edited, is not Not saved and quits without asking', async () => {
  test.setTimeout(120_000 + NOT_SAVED_QUIET_MS)
  const { app, page } = await launchApp()
  const record = test.info().outputPath('quit-dialog.jsonl')
  try {
    const { dir, blocker } = await writeFastAutosaveProject(page)
    fs.mkdirSync(blocker)
    await openProject(page, dir)

    // A quiet window (e2e/README.md § Waiting inside a spec): what must not
    // happen cannot be polled for. The quit below does not depend on it.
    await page.waitForTimeout(NOT_SAVED_QUIET_MS)
    expect(await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)).toMatchObject({ state: 'ok' })
    await expect(page.getByTestId('save-status-badge')).toHaveCount(0)

    // The quit's save fails here too; with nothing unsaved it asks nothing.
    await answerQuitDialog(app, record, 'discard')
    await quitToExit(app)
    expect(dialogCalls(record)).toEqual([])
  } finally {
    await closeApp(app)
  }
})

/** A Render & Play window, opened as the export dialog opens one
 *  (SecondaryWindow → `win:create`). */
const PLAYER = 'render-play-quit'

const playerOpen = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some((w) => !w.isDestroyed() && w.webContents.getURL().includes('render-play.html')))

test('closing the editor asks even with another window open; Cancel keeps both, and closing the other one neither asks nor quits', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const record = test.info().outputPath('quit-dialog.jsonl')
  try {
    const { blocker } = await openFastAutosaveProject(page)
    fs.mkdirSync(blocker)
    const unsaved = await addLayer(page)
    await answerQuitDialog(app, record, 'cancel')
    await page.evaluate((label) => (window as unknown as { api: { win: { create(l: string, o: unknown): Promise<void> } } })
      .api.win.create(label, { url: '/render-play.html', title: 'Render & Play', width: 480, height: 320, resizable: true }), PLAYER)
    await expect.poll(() => playerOpen(app)).toBe(true)
    // Every app.quit() from here on, counted in main.
    await app.evaluate(({ app: electronApp }) => {
      const g = globalThis as { __quits?: number }
      g.__quits = 0
      const quitApp = electronApp.quit.bind(electronApp)
      electronApp.quit = () => { g.__quits! += 1; quitApp() }
    })

    // Asked on the editor, the one window that can host the question and the
    // editing a Cancel returns to.
    pressCloseButton(page)
    await expect.poll(() => dialogCalls(record).length, { timeout: ASKED_WITHIN_MS }).toBe(1)
    expectQuitSaveQuestion(dialogCalls(record)[0])
    const after = await addLayer(page)
    const editor = await app.browserWindow(page)
    expect(await editor.evaluate((w) => !w.isDestroyed() && w.isVisible())).toBe(true)
    expect(await playerOpen(app)).toBe(true)

    // The player's own `closed` handlers run before this one, registered
    // after them: once it has run, theirs have.
    await app.evaluate(({ BrowserWindow }) => {
      const player = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('render-play.html'))!
      player.once('closed', () => { (globalThis as { __playerClosed?: boolean }).__playerClosed = true })
    })
    await page.evaluate((label) => (window as unknown as { api: { win: { act(l: string, a: string): Promise<void> } } })
      .api.win.act(label, 'close'), PLAYER)
    await expect.poll(() => app.evaluate(() => (globalThis as { __playerClosed?: boolean }).__playerClosed === true)).toBe(true)
    expect(await app.evaluate(() => (globalThis as { __quits?: number }).__quits)).toBe(0)
    expect(dialogCalls(record)).toHaveLength(1)
    expect(await editor.evaluate((w) => !w.isDestroyed() && w.isVisible())).toBe(true)
    const live = (await summary(page)).tracks.flatMap((t) => t.layers.map((l) => l.id))
    expect(live).toEqual(expect.arrayContaining([unsaved, after]))
  } finally {
    await closeApp(app)
  }
})

/** Replaces both ways main hands a path to the file manager (main/openPath.ts):
 *  shell.openPath, and on Linux an xdg-open child it spawns itself. Each
 *  records the path and reports success; nothing opens. */
async function recordOpenedPaths(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __openedPaths?: string[] }).__openedPaths = opened
    shell.openPath = async (target: string) => { opened.push(target); return '' }
    const childProcess = process.getBuiltinModule('node:child_process')
    const { EventEmitter } = process.getBuiltinModule('node:events')
    const spawn = childProcess.spawn as (...args: unknown[]) => unknown
    childProcess.spawn = ((command: string, ...rest: unknown[]) => {
      if (command !== 'xdg-open') return spawn(command, ...rest)
      opened.push((rest[0] as string[])[0]!)
      const child = Object.assign(new EventEmitter(), { unref() {} })
      setImmediate(() => child.emit('exit', 0))
      return child
    }) as typeof childProcess.spawn
    // LANDMINE: main's bundle imports `spawn` by name from the ESM builtin;
    // without this the patched export never reaches it and a real opener runs.
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  })
}

const openedPaths = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __openedPaths?: string[] }).__openedPaths ?? [])

test("the save-failure card's Open folder opens the project folder", async () => {
  test.setTimeout(120_000 + BADGE_WITHIN_MS)
  const { app, page } = await launchApp()
  try {
    const { dir, blocker } = await openFastAutosaveProject(page)
    fs.mkdirSync(blocker)
    await addLayer(page)
    const badge = page.getByTestId('save-status-badge')
    await expect(badge).toBeVisible({ timeout: BADGE_WITHIN_MS })

    await recordOpenedPaths(app)
    await badge.click()
    const card = page.getByTestId('save-failure-card')
    await card.getByRole('button', { name: enUS.save_status.open_folder }).click()
    await expect.poll(() => openedPaths(app), { timeout: ASKED_WITHIN_MS }).toHaveLength(1)
    expect((await openedPaths(app)).map(samePath)).toEqual([samePath(dir)])
    // The card reports a failed open in place; this one succeeded.
    await expect(card.locator('.save-failure-result')).toHaveCount(0)
  } finally {
    await closeApp(app)
  }
})
