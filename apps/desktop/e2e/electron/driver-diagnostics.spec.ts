import { test, expect } from '@playwright/test'
import { driveExport, importAndPlaceMedia, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'
import { resourceDiagnostics } from './helpers/resourceDiagnostics'

const canvas = { width: 320, height: 240, fpsNum: 30, fpsDen: 1 }

test('resource failure diagnostics preserve the real rejection and its ledger', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-diag-'), name: 'Diagnostics', canvas })
    const settings = await invokeCmd<{ resource_allocation: { work_mib: number } }>(page, 'app_settings_get')
    const memoryMiB = settings.resource_allocation.work_mib + 1
    // An impossible request is deterministic on every host, without lowering
    // the app target or changing how admission behaves.
    await page.evaluate(memoryMiB => {
      const hook = (window as any).__weftcutTest
      hook.diagnosticExport = () => (window as any).api.resources.acquire({ id: 'diagnostic-request', memoryMiB, threads: 0 })
    }, memoryMiB)
    const result = await driveExport(page, {}, { hook: 'diagnosticExport' })
    expect(result.done.ok).toBe(false)
    expect(result.done.error).toContain('resource-capacity-exceeded')
    const diagnostic = JSON.parse(result.done.error!.split('; diag=')[1]!)
    expect(diagnostic.resources.main.failures.at(-1)).toMatchObject({
      channel: 'resources:acquire', request: { id: 'diagnostic-request', memoryMiB, threads: 0 },
      ledger: { reserved_mib: expect.any(Number), cpu_threads: expect.any(Number) },
    })
    expect(diagnostic.resources.renderer.allocation.work_mib).toBe(settings.resource_allocation.work_mib)
    // Successful acquisitions still pass through and release normally.
    await page.evaluate(async () => {
      await (window as any).api.resources.acquire({ id: 'diagnostic-small', memoryMiB: 1, threads: 0 })
      ;(window as any).api.resources.release('diagnostic-small')
    })
  } finally { await app.close() }
})

test('a pending export timeout reports no observed progress and resource state', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-diag-'), name: 'Pending', canvas })
    await page.evaluate(() => {
      ;(window as any).__weftcutTest.diagnosticPending = () => new Promise(() => {})
    })
    const error = await driveExport(page, {}, { hook: 'diagnosticPending', timeout: 100 }).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('no progress observed')
    expect(error.message).toContain('renderer=responsive')
    expect(error.message).toContain('reserved_mib')
    expect(error.message).not.toContain('STILL TICKING')
  } finally { await app.close() }
})

test('a blocked import has its own deadline and preserves main diagnostics when the renderer read fails', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-diag-'), name: 'Import', canvas })
    await app.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('backend:invoke')!
      ipcMain._invokeHandlers.set('backend:invoke', (event: any, request: any) => {
        if (request.channel === 'import_media') return new Promise(() => {})
        return handler(event, request)
      })
    })
    await expect(importAndPlaceMedia(page, { mediaAbsPath: 'unused-by-hook' }, { timeout: 100 }))
      .rejects.toThrow(/importAndPlaceMedia did not complete within 100ms.*reserved_mib/)
    // Fail the renderer's settings read without disturbing native telemetry.
    await app.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('backend:invoke')!
      ipcMain._invokeHandlers.set('backend:invoke', (event: any, request: any) => {
        if (request.channel === 'app_settings_get') throw new Error('diagnostic-settings-unavailable')
        return handler(event, request)
      })
    })
    const diagnostic = await resourceDiagnostics(page)
    expect(diagnostic.main).toHaveProperty('ledger.reserved_mib')
    expect(diagnostic.renderer).toHaveProperty('unavailable')
  } finally { await app.close() }
})
