import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { format } from 'node:util'
import { DiagnosticsStore, redactDiagnosticText } from './diagnosticsStore'
import type { DiagnosticSummary } from '../shared/diagnostics'

let store: DiagnosticsStore | null = null
let ownerId: number | null = null
let dismissed = false
let exporting = false
let environment: Record<string, unknown> = {}

export function diagnosticOwner(id: number): void { ownerId = id }
export function recordDiagnostic(kind: string, message: string): void { store?.record(kind, message) }

/** Structured project events contribute only their message and classification;
 * tool arguments, project snapshots, details and i18n arguments are excluded. */
export function recordProjectDiagnostic(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const p = payload as Record<string, unknown>
  if (typeof p.message === 'string') recordDiagnostic('project', JSON.stringify({
    level: p.level, category: p.category, message: p.message, op_state: p.op_state,
  }))
}

export function startDiagnostics(): void {
  // Bare `electron out/main/index.js` reports Electron's version from
  // app.getVersion(), so carry the application's identity in every build.
  const version = process.env.WEFTCUT_BUILD_VERSION ?? app.getVersion()
  environment = {
    app: version, commit: process.env.WEFTCUT_BUILD_COMMIT ?? 'unknown',
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch, osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown', logicalCores: os.cpus().length,
    totalMemoryMiB: Math.round(os.totalmem() / 1048576), packaged: app.isPackaged,
  }
  try {
    store = new DiagnosticsStore(path.join(app.getPath('userData'), app.isPackaged ? 'diagnostics' : 'diagnostics-dev'), version)
  } catch { /* Read-only/full disk must not prevent launching the editor. */ }
  recordDiagnostic('startup', JSON.stringify(environment))
  store?.setEnvironment(environment)
  store?.flush()
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try { recordDiagnostic(`main:${level}`, format(...args)) } catch { /* Diagnostic formatting is best effort. */ }
      original(...args)
    }
  }
  // Observe without changing Node/Electron's fatal-error behavior.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    store?.failure(origin, error.stack ?? error.message)
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') store?.failure('render-process-gone', JSON.stringify(details))
    })
    contents.on('preload-error', (_e, _file, error) => store?.failure('preload-error', error.stack ?? error.message))
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') store?.failure('child-process-gone', JSON.stringify({
      type: details.type, reason: details.reason, exitCode: details.exitCode,
    }))
  })
  // before-quit/will-quit can be cancelled while autosave is still in progress.
  // Only an actual successful quit clears the unfinished-session marker.
  app.on('quit', (_event, code) => store?.close(code === 0))
  process.on('exit', () => store?.flush())
  void app.whenReady().then(async () => {
    try {
      const gpu = await app.getGPUInfo('basic') as { gpuDevice?: { vendorId?: number; deviceId?: number; driverVersion?: string }[] }
      environment.gpu = gpu.gpuDevice?.map(d => ({ vendorId: d.vendorId, deviceId: d.deviceId,
        driverVersion: redactDiagnosticText(d.driverVersion ?? 'unknown') })) ?? []
      environment.gpuFeatures = app.getGPUFeatureStatus()
      store?.setEnvironment(environment)
      recordDiagnostic('hardware', JSON.stringify({ gpu: environment.gpu, gpuFeatures: environment.gpuFeatures }))
    } catch { recordDiagnostic('hardware', 'GPU information unavailable') }
  })

  const checkSender = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    if (e.sender.id !== ownerId || e.senderFrame !== e.sender.mainFrame) throw new Error('Diagnostics require the main window')
  }
  ipcMain.handle('diagnostics:summary', e => {
    checkSender(e)
    return {
      available: store?.available ?? false,
      environment: `WeftCut ${version} (${String(environment.commit).slice(0, 12)}) | Electron ${process.versions.electron} | ${process.platform} ${process.arch} ${os.release()} | ${environment.logicalCores} cores | ${environment.totalMemoryMiB} MiB RAM`,
      previousSession: dismissed ? null : store?.previous ?? null,
    } satisfies DiagnosticSummary
  })
  ipcMain.handle('diagnostics:dismiss', e => {
    checkSender(e)
    dismissed = true
    try { store?.dismissPrevious() }
    catch { recordDiagnostic('storage', 'Could not persist dismissal; dismissed for this run') }
  })
  ipcMain.on('diagnostics:error', (e, message: unknown) => {
    if (e.sender.id !== ownerId || e.senderFrame !== e.sender.mainFrame || typeof message !== 'string') return
    recordDiagnostic('renderer:error', message.slice(0, 16_384))
  })
  ipcMain.handle('diagnostics:export', async e => {
    checkSender(e)
    if (exporting) throw new Error('A diagnostic export is already in progress')
    if (!store?.available) throw new Error('Diagnostic storage is unavailable')
    exporting = true
    try {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `WeftCut-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return null
      await fs.writeFile(result.filePath, store.bundle(environment))
      return result.filePath
    } finally { exporting = false }
  })
}
