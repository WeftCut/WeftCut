import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, driveExport } from './helpers/driver'

const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/media')

// Cancelling stops the export's native stages (encoder, mix, mux) in main, then
// tells the renderer. Whatever a stopped stage answers the renderer, the job
// ends cancelled: never a failure, a retry offer or an encoder fallback
// question. Main's `export:cancel` is held until the renderer has had that
// answer, the order a slow native stop produces, so no outcome here depends on
// which message wins.

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
const RUNNING = ['starting', 'preparing', 'progress', 'finalizing']

async function setup() {
  const { app, page } = await launchApp()
  await newProject(page, { parentFolder: tmpDir('weftcut-cancel-'), name: 'Cancel export', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
  const media = await importAndPlaceMedia(page, { mediaAbsPath: path.join(MEDIA, 'test_1080p_30fps_audio.mp4') })
  await page.evaluate(mediaId => (window as any).__weftcutTest.waitMediaExportReady({ mediaId }), media.mediaId)
  const consoleErrors: string[] = []
  const dialogs: string[] = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss() })
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const g = globalThis as any
    g.__statuses = []
    g.__leases = new Map<string, unknown>()
    g.__cancelGate = new Promise<void>(resolve => { g.__openCancelGate = resolve })
    for (const w of BrowserWindow.getAllWindows()) {
      const wc = w.webContents
      const send = wc.send.bind(wc)
      wc.send = (channel: string, ...args: any[]) => {
        if (channel === 'evt:export:status' && args[0]) g.__statuses.push({ job_id: args[0].job_id, state: args[0].state, phase: args[0].phase, error: args[0].error })
        if (channel === 'evt:export:cancel') { void g.__cancelGate.then(() => send(channel, ...args)); return }
        send(channel, ...args)
      }
    }
    for (const channel of ['resources:acquire', 'resources:plan-export']) {
      const handler = ipcMain._invokeHandlers.get(channel)!
      ipcMain._invokeHandlers.set(channel, async (event: any, request: any) => {
        const result = await handler(event, request)
        // The export's own: its plans, and claims that borrow from one. The
        // editor's leases (preview, thumbnails) come and go on their own.
        if (channel === 'resources:plan-export' || request.finalizationToken) g.__leases.set(request.id, { channel, memoryMiB: request.memoryMiB, options: request.options })
        return result
      })
    }
    ipcMain.on('resources:release', (_event, id: string) => g.__leases.delete(id))
  })
  return { app, page, consoleErrors, dialogs }
}

/** Starts an export; with `hold`, that backend command waits until released. */
async function startExport(page: Page, outputAbsPath: string, hold?: string): Promise<Set<string>> {
  const logsBefore = new Set((await invokeCmd<any[]>(page, 'log_list')).map(e => e.id as string))
  await page.evaluate(({ outputAbsPath, hold }) => {
    const w = window as any
    w.__held = false; w.__heldSettled = false; w.__done = false
    w.__weftcutE2EBackendInvokeInterceptor = async (cmd: string, args: unknown, next: any) => {
      if (cmd !== hold) return next(cmd, args)
      w.__weftcutE2EBackendInvokeInterceptor = undefined
      w.__held = true
      await new Promise<void>(resolve => { w.__release = resolve })
      try { return await next(cmd, args) } finally { w.__heldSettled = true }
    }
    void w.__weftcutTest.exportTimeline({ outputAbsPath, settings: { encoderEngine: 'auto' } })
      .catch(() => { }).finally(() => { w.__done = true })
  }, { outputAbsPath, hold })
  return logsBefore
}

async function cancelAndSettle(app: ElectronApplication, page: Page, held: boolean): Promise<string> {
  const jobId = await page.evaluate(() => {
    const state = (window as any).__weftcutExportState
    state.onCancel()
    return state.job.job_id as string
  })
  await expect.poll(() => app.evaluate((_e, id) => (globalThis as any).__statuses.some((s: any) => s.job_id === id && s.phase === 'cancelling'), jobId), { timeout: 30_000 }).toBe(true)
  if (held) await page.evaluate(() => (window as any).__release())
  // The stopped stage has answered the renderer: its run left the running
  // states (cancelled, or reported a failure).
  await page.waitForFunction(({ held, running }) => {
    const w = window as any
    return (!held || w.__heldSettled) && !running.includes(w.__weftcutExportState?.kind)
  }, { held, running: RUNNING }, { timeout: 60_000 })
  await app.evaluate(() => (globalThis as any).__openCancelGate())
  await page.waitForFunction(() => (window as any).__done, undefined, { timeout: 60_000 })
  await expect.poll(async () => (await invokeCmd<any>(page, 'export_job_status', { job_id: jobId })).state, { timeout: 60_000 }).toBe('cancelled')
  return jobId
}

async function expectCleanCancel(app: ElectronApplication, page: Page, jobId: string, output: string, consoleErrors: string[], dialogs: string[], logsBefore: Set<string>) {
  const job = await invokeCmd<any>(page, 'export_job_status', { job_id: jobId })
  expect.soft(job.error, 'a cancelled job carries no failure').toBeUndefined()
  expect.soft(job.cancelled_by, 'the job names who cancelled it').toEqual({ kind: 'user' })
  const published = await app.evaluate((_e, id) => (globalThis as any).__statuses.filter((s: any) => s.job_id === id), jobId)
  expect.soft(published.map((s: any) => s.state), 'main never published a failure or a retry offer for the cancelled job')
    .not.toContain('failed')
  expect.soft(published.map((s: any) => s.state)).not.toContain('awaiting_retry')
  // The run's rows: Export rows after those that existed when it started. Its
  // terminal row is emitted asynchronously; wait for one.
  const runRows = async () => (await invokeCmd<any[]>(page, 'log_list')).filter(e => e.category?.kind === 'Export' && !logsBefore.has(e.id))
  await expect.poll(async () => (await runRows()).some(e => ['log.export_cancelled', 'log.export_failed', 'log.export_ok'].includes(e.i18n_key)), { timeout: 30_000 }).toBe(true)
  const rows = await runRows()
  const logs = rows.map(e => e.i18n_key)
  expect.soft(logs, `the log records a cancellation, not a failure: ${JSON.stringify(rows.map(e => e.message))}`).toContain('log.export_cancelled')
  expect.soft(logs).not.toContain('log.export_failed')
  expect.soft(rows.find(e => e.i18n_key === 'log.export_cancelled'), 'the cancel row names this run\'s file and the user who cancelled')
    .toMatchObject({ source: { kind: 'User' }, details: { output, cancelled_by: { kind: 'user' } } })
  expect.soft(rows.filter(e => (e.details as any)?.output !== undefined).map(e => (e.details as any).output), 'every row names this run\'s file')
    .toEqual(rows.filter(e => (e.details as any)?.output !== undefined).map(() => output))
  expect.soft(consoleErrors.filter(m => /Error invoking remote method|export failed|\[export job\]/.test(m)), 'no stage failure reached the console').toEqual([])
  expect.soft(dialogs, 'cancelling asks no question').toEqual([])
  await expectReleasedAndReusable(app, page, output)
}

async function expectReleasedAndReusable(app: ElectronApplication, page: Page, output: string) {
  // Every lease the export took is returned, and the native ledger names no
  // export holder (the encoder's and the mix's leases live there).
  const held = () => app.evaluate(() => [...(globalThis as any).__leases.entries()].map(([id, lease]: [string, any]) => ({ id, ...lease })))
  await expect.poll(held, { timeout: 30_000 }).toEqual([]).catch(() => { })
  expect.soft(await held(), 'every export lease is returned').toEqual([])
  const ledger = await app.evaluate((_e, addon) => JSON.parse(process.getBuiltinModule('module').createRequire(addon)(addon).resourcesSnapshot()), addon)
  expect.soft(ledger.holders.filter((h: any) => h.kind === 'export'), `no export holder remains; ledger ${JSON.stringify(ledger)}`).toEqual([])
  const next = await driveExport(page, { outputAbsPath: path.join(path.dirname(output), 'after.mp4'), settings: { encoderEngine: 'auto' } }, { hook: 'exportTimeline' })
  expect(next.done.ok, next.done.error).toBe(true)
}

test('cancelling a native encode mid-render ends cancelled, with no failure reported', async () => {
  test.setTimeout(240_000)
  const { app, page, consoleErrors, dialogs } = await setup()
  try {
    const output = path.join(tmpDir('weftcut-cancel-render-'), 'cancelled.mp4')
    const logsBefore = await startExport(page, output)
    await page.waitForFunction(() => {
      const s = (window as any).__weftcutExportState
      return s?.kind === 'progress' && s.progress.frame >= 6
    }, undefined, { timeout: 120_000 })
    const jobId = await cancelAndSettle(app, page, false)
    await expectCleanCancel(app, page, jobId, output, consoleErrors, dialogs, logsBefore)
  } finally { await app.close() }
})

for (const stage of ['export_project_audio_only', 'export_video_sink_start', 'mux_export']) {
  test(`cancelling while ${stage} runs ends cancelled, with no failure reported`, async () => {
    test.setTimeout(240_000)
    const { app, page, consoleErrors, dialogs } = await setup()
    try {
      const output = path.join(tmpDir(`weftcut-cancel-${stage}-`), 'cancelled.mp4')
      const logsBefore = await startExport(page, output, stage)
      await page.waitForFunction(() => (window as any).__held, undefined, { timeout: 120_000 })
      const jobId = await cancelAndSettle(app, page, true)
      await expectCleanCancel(app, page, jobId, output, consoleErrors, dialogs, logsBefore)
    } finally { await app.close() }
  })
}

test('discarding a failed finalization ends cancelled, logged as the user\'s cancel', async () => {
  test.setTimeout(240_000)
  const { app, page } = await setup()
  try {
    // Publication fails once, so the encoded job awaits retry.
    await app.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('backend:invokePublished')!
      let failed = false
      ipcMain._invokeHandlers.set('backend:invokePublished', (event: any, request: any) => {
        if (request.channel === 'export_job_publish' && !failed) { failed = true; throw new Error('Injected publication failure') }
        return handler(event, request)
      })
      ;(globalThis as any).__openCancelGate()
    })
    const output = path.join(tmpDir('weftcut-cancel-discard-'), 'discarded.mp4')
    const logsBefore = await startExport(page, output)
    await page.waitForFunction(() => {
      const s = (window as any).__weftcutExportState
      return s?.kind === 'error' && typeof s.onDiscard === 'function'
    }, undefined, { timeout: 120_000 })
    const jobId = await page.evaluate(() => (window as any).__weftcutExportState.job.job_id as string)
    await expect.poll(async () => (await invokeCmd<any>(page, 'export_job_status', { job_id: jobId })).state, { timeout: 30_000 }).toBe('awaiting_retry')
    await page.evaluate(() => (window as any).__weftcutExportState.onDiscard())
    await expect.poll(async () => (await invokeCmd<any>(page, 'export_job_status', { job_id: jobId })).state, { timeout: 60_000 }).toBe('cancelled')
    expect.soft((await invokeCmd<any>(page, 'export_job_status', { job_id: jobId })).cancelled_by).toEqual({ kind: 'user' })
    const runRows = async () => (await invokeCmd<any[]>(page, 'log_list')).filter(e => e.category?.kind === 'Export' && !logsBefore.has(e.id))
    await expect.poll(async () => (await runRows()).filter(e => e.i18n_key === 'log.export_cancelled').length, { timeout: 30_000 }).toBe(1)
    const rows = await runRows()
    // The finalization's failure stays recorded; the discard ends the job after it.
    const keys = rows.map(e => e.i18n_key)
    expect.soft(keys.indexOf('log.export_failed'), JSON.stringify(rows.map(e => e.message))).toBeGreaterThanOrEqual(0)
    expect.soft(keys.indexOf('log.export_cancelled')).toBeGreaterThan(keys.indexOf('log.export_failed'))
    expect.soft(rows.find(e => e.i18n_key === 'log.export_cancelled'))
      .toMatchObject({ source: { kind: 'User' }, details: { output, cancelled_by: { kind: 'user' } } })
    await expectReleasedAndReusable(app, page, output)
  } finally { await app.close() }
})
