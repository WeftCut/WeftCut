import type { ElectronApplication, Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type { WeftcutApi } from '../../../src/shared/ipc'
import fs from 'node:fs'
import path from 'node:path'

const addon = fileURLToPath(new URL('../../../native/index.js', import.meta.url))
const apps = new WeakMap<Page, ElectronApplication>()

/** Observe real admission without changing limits, return values or errors.
 * Keep the ledger at rejection: export cleanup can release it before Node polls. */
export async function installResourceDiagnostics(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ ipcMain }, addon) => {
    const native = process.getBuiltinModule('module').createRequire(addon)(addon)
    const failures: unknown[] = []
    ;(globalThis as any).__e2eResourceFailures = failures
    for (const channel of ['resources:acquire', 'resources:plan-export', 'backend:invoke']) {
      const handler = ipcMain._invokeHandlers.get(channel)
      if (!handler) throw new Error(`Missing E2E admission boundary: ${channel}`)
      ipcMain._invokeHandlers.set(channel, async (event: any, request: any) => {
        try { return await handler(event, request) }
        catch (error) {
          if (/resource-capacity-exceeded|Resources are busy|working memory/.test(String(error))) {
            try {
              failures.push({
                at: Date.now(), channel, owner: event.sender.id,
                request: channel === 'resources:acquire'
                  ? { id: request.id, memoryMiB: request.memoryMiB, threads: request.threads }
                  : channel === 'resources:plan-export'
                    ? { id: request.id, options: request.options, nativeEncoder: request.nativeEncoder }
                    : { command: request.channel },
                ledger: JSON.parse(native.resourcesSnapshot()),
                error: String(error),
              })
              if (failures.length > 16) failures.shift()
            } catch { /* A diagnostic failure must not replace the product error. */ }
          }
          throw error
        }
      })
    }
  }, addon)
  apps.set(page, app)
}

async function bounded<T>(read: Promise<T>): Promise<T | { unavailable: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read.catch(error => ({ unavailable: String(error) })),
      new Promise<{ unavailable: string }>(resolve => {
        timer = setTimeout(() => resolve({ unavailable: 'diagnostic timed out after 2s' }), 2000)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/** Independent deadlines preserve the main ledger even if the renderer hangs. */
export async function resourceDiagnostics(page: Page) {
  const app = apps.get(page)
  const [main, renderer] = await Promise.all([
    app ? bounded(app.evaluate((_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const os = process.getBuiltinModule('os')
      return {
        at: Date.now(), ledger: JSON.parse(native.resourcesSnapshot()),
        failures: (globalThis as any).__e2eResourceFailures,
        host: { totalMiB: os.totalmem() / 1048576, freeMiB: os.freemem() / 1048576, cores: os.availableParallelism() },
      }
    }, addon)) : Promise.resolve({ unavailable: 'app not registered' }),
    bounded(page.evaluate(async () => {
      const api = (window as unknown as { api: WeftcutApi }).api
      const settings = await api.backend.invoke('app_settings_get') as { resource_allocation?: unknown; resource_policy?: unknown }
      return { allocation: settings.resource_allocation, policy: settings.resource_policy, sampledStatus: await api.resources.status() }
    })),
  ])
  return { main, renderer }
}

/** Persist while the test is running: reporter finalization and attachments
 * cannot be relied on when the renderer or worker is killed mid-test. */
export function startResourceJournal(page: Page, file: string): () => Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let pending: Promise<void> | null = null
  const sample = (reason: string): Promise<void> => {
    if (pending) return pending
    pending = (async () => {
      const [resources, exportState] = await Promise.all([
        resourceDiagnostics(page),
        bounded(page.evaluate(() => {
          const w = window as any
          const s = w.__weftcutExportState
          return { kind: s?.kind, detail: s?.detail, step: s?.step, frame: s?.progress?.frame,
            totalFrames: w.__weftcutExportPerf?.totalFrames }
        })),
      ])
      fs.appendFileSync(file, JSON.stringify({ at: Date.now(), reason, resources, export: exportState }) + '\n')
    })().catch(error => {
      // Recording must neither replace the product failure nor hang cleanup.
      try { fs.appendFileSync(file, JSON.stringify({ at: Date.now(), reason, unavailable: String(error) }) + '\n') } catch { /* Worker exiting. */ }
    }).finally(() => { pending = null })
    return pending
  }
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), reason: 'launched' }) + '\n')
  const timer = setInterval(() => { void sample('running') }, 2000)
  timer.unref()
  return async () => { clearInterval(timer); await pending; await sample('before-close') }
}
