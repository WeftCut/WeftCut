import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { launchApp, invokeCmd, tmpDir } from './helpers/driver'
import type { AppSettings } from '../../src/shared/app-settings'
import { DEFAULT_RESOURCE_POLICY, resolveResourcePolicy } from '../../src/shared/resource-policy'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))

test('IPC and native resource entries reject numeric truncation without creating leases', async ({}, testInfo) => {
  const { app, page } = await launchApp()
  try {
    const nativeResults = await app.evaluate((_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      return [
        [0, 2 ** 32], [0, 2 ** 32 + 64], [0, Number.MAX_SAFE_INTEGER],
        [2 ** 32, 64], [-1, 64], [1.5, 64], [0, 0], [0, -1], [0, NaN], [0, Infinity],
      ].map(([threads, memoryMiB]) => {
        try {
          const id = native.resourcesReserve(threads, memoryMiB)
          native.resourcesRelease(id)
          return { threads: String(threads), memoryMiB: String(memoryMiB), rejected: false }
        } catch {
          return { threads: String(threads), memoryMiB: String(memoryMiB), rejected: true }
        }
      })
    }, addon)
    expect(nativeResults.every(result => result.rejected), JSON.stringify(nativeResults)).toBe(true)
    const ipcResults = await page.evaluate(async () => {
      const results: boolean[] = []
      for (const memoryMiB of [2 ** 32, 2 ** 32 + 64, Number.MAX_SAFE_INTEGER]) {
        try {
          await window.api.resources.acquire({ id: 'numeric-overflow', threads: 0, memoryMiB })
          window.api.resources.release('numeric-overflow')
          results.push(false)
        } catch { results.push(true) }
      }
      return results
    })
    expect(ipcResults).toEqual([true, true, true])
    await testInfo.attach('numeric-resource-boundaries', { contentType: 'application/json', body: JSON.stringify({ nativeResults, ipcResults }, null, 2) })
  } finally { await app.close() }
})

test('resource intent survives an application restart and defaults use the actual host', async ({}, testInfo) => {
  const userDataDir = tmpDir('weftcut-resource-restart-')
  let { app, page } = await launchApp({ userDataDir, locale: 'zh-CN' })
  try {
    const host = await app.evaluate(async ({ app }) => {
      const os = process.getBuiltinModule('os')
      const info = await app.getGPUInfo('complete') as { gpuDevice?: Array<{ active?: boolean; vendorId?: number }> }
      return { memoryMiB: os.totalmem() / 1048576, cores: os.availableParallelism(), platform: process.platform,
        arch: process.arch, graphicsVendor: info.gpuDevice?.find(device => device.active)?.vendorId }
    })
    const initial = await invokeCmd<AppSettings>(page, 'app_settings_get')
    expect(initial.resource_allocation).toEqual(resolveResourcePolicy(DEFAULT_RESOURCE_POLICY, host.memoryMiB, host.cores))
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: {
      memory_mib: 3072, processing: 'low', disk_cache_mib: 1024, background_playback: true,
    } } })
    const saved = await invokeCmd<AppSettings>(page, 'app_settings_get')
    await expect(invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: -1 } } })).rejects.toThrow()
    await app.close()
    ;({ app, page } = await launchApp({ userDataDir, locale: 'zh-CN' }))
    const restored = await invokeCmd<AppSettings>(page, 'app_settings_get')
    expect(restored.resource_policy).toEqual(saved.resource_policy)
    expect(restored.resource_allocation).toEqual(saved.resource_allocation)
    expect(restored.decode_engine).toBe(initial.decode_engine)
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { processing: 'high' } } })
    const high = await invokeCmd<AppSettings>(page, 'app_settings_get')
    expect(high.resource_allocation).toEqual(resolveResourcePolicy(high.resource_policy!, host.memoryMiB, host.cores))
    expect(high.resource_allocation!.memory_mib).toBe(3072)
    expect(high.resource_allocation!.disk_cache_mib).toBe(1024)
    const calibration = await page.evaluate(() => window.api.performanceCalibration.status())
    if (host.platform !== 'win32') {
      expect(calibration).toMatchObject({ available: false, unavailableReason: 'platform', running: false })
      await page.locator('.startup-settings-toggle').click()
      await page.getByRole('tab', { name: '性能', exact: true }).click()
      const pane = page.locator('#settings-panel-performance')
      await expect(pane.getByRole('button', { name: '进行基准测试', exact: true })).toBeDisabled()
      await expect(pane.getByText('测试目前仅支持 Windows。', { exact: true })).toBeVisible()
      const resources = await page.evaluate(() => window.api.performanceResources.info())
      if (host.platform === 'darwin' && host.arch === 'arm64' && host.graphicsVendor === 0x106b) {
        expect(resources.graphics?.memory_kind).toBe('unified')
        expect(resources.graphics?.name).toBeTruthy()
        await expect(pane.getByText(resources.graphics!.name!, { exact: true })).toBeVisible()
        await expect(pane.getByText('图形内存', { exact: true })).toBeVisible()
        await expect(pane.getByText('使用共享内存', { exact: true })).toBeVisible()
      }
      await page.screenshot({ path: testInfo.outputPath('platform-resource-settings.png'), animations: 'disabled' })
    }
    await testInfo.attach('host-resource-allocation', { contentType: 'application/json', body: JSON.stringify({ host, initial: initial.resource_allocation, restored: restored.resource_allocation, high: high.resource_allocation, calibration }, null, 2) })
  } finally { await app.close() }
})

test('process-tree memory includes native children and grandchildren and falls after teardown @serial', async ({}, testInfo) => {
  const { app, page } = await launchApp()
  try {
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).memory_scope).toBe('process-tree')
    const before = await app.evaluate(async (_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      return native.resourcesMemory()
    }, addon)
    const descendants = await app.evaluate(async () => {
      const spawn = process.getBuiltinModule('child_process').spawn
      const grandchildScript = `
        globalThis.memory = Buffer.alloc(96 * 1048576, 1);
        process.stdout.write(JSON.stringify({ pid: process.pid, rss: process.memoryUsage().rss }));
        process.stdin.resume();
        process.stdin.on('end', () => process.exit(0));
      `
      const childScript = `
        globalThis.memory = Buffer.alloc(96 * 1048576, 1);
        const grandchild = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
        grandchild.stdout.once('data', data => process.stdout.write(JSON.stringify({ child: { pid: process.pid, rss: process.memoryUsage().rss }, grandchild: JSON.parse(data.toString()) })));
        process.stdin.resume();
        process.stdin.on('end', () => grandchild.stdin.end());
        grandchild.on('exit', () => process.exit(0));
      `
      const child = spawn(process.execPath, ['-e', childScript], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'],
      })
      ;(globalThis as any).__resourceMemoryChild = child
      return new Promise<any>((resolve, reject) => {
        child.once('error', reject)
        child.stdout.once('data', data => resolve(JSON.parse(data.toString())))
        child.once('exit', code => reject(new Error(`Memory fixture exited before sampling: ${code}`)))
      })
    })
    const during = await app.evaluate(async (_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      return native.resourcesMemory()
    }, addon)
    const descendantMiB = (descendants.child.rss + descendants.grandchild.rss) / 1048576
    expect(during.processMib - before.processMib).toBeGreaterThan(128)
    // Independent child RSS readings bound both missed descendants and double
    // counting, with headroom for Chromium's concurrent startup/allocator drift.
    expect(Math.abs(during.processMib - before.processMib - descendantMiB)).toBeLessThan(128)
    expect(during.availableMib).toBeGreaterThan(0)
    await app.evaluate(async () => {
      const child = (globalThis as any).__resourceMemoryChild
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.stdin.end() })
      delete (globalThis as any).__resourceMemoryChild
    })
    const after = await app.evaluate(async (_electron, addon) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      return native.resourcesMemory()
    }, addon)
    expect(during.processMib - after.processMib).toBeGreaterThan(128)
    await testInfo.attach('process-tree-memory', { contentType: 'application/json', body: JSON.stringify({ before, during, after, descendants, descendantMiB }, null, 2) })
  } finally {
    await app.evaluate(() => { (globalThis as any).__resourceMemoryChild?.stdin.end() }).catch(() => {})
    await app.close()
  }
})
