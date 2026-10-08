import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'fflate'
import { launchApp, tmpDir } from './helpers/driver'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))

test('host memory telemetry admits runtime archive extraction under default resource limits', async ({}, testInfo) => {
  // A tiny synthetic runtime archive exercises the exact native installation
  // path that failed on compressed-memory Macs, without downloading a model.
  const dir = tmpDir('weftcut-memory-install-')
  const contents = Buffer.from('synthetic runtime\n')
  const header = Buffer.alloc(512)
  header.write('runtime/cli', 0)
  header.write('0000755\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  const archive = path.join(dir, 'runtime.tar.gz')
  fs.writeFileSync(archive, gzipSync(Buffer.concat([header, contents, Buffer.alloc(512 - contents.length + 1024)])))
  const dest = path.join(dir, 'installed')
  const { app, page } = await launchApp()
  try {
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).memory_scope).toBe('process-tree')
    const status = await page.evaluate(() => window.api.resources.status())
    await testInfo.attach('memory-telemetry', { body: JSON.stringify(status), contentType: 'application/json' })
    expect(status.available_memory_mib).toBeGreaterThan(0)
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).pressure).toBe('normal')
    // Archive extraction is deliberately main-only. Call the native backend
    // in main, sharing the same process-wide governor as the download queue.
    const extracted = await app.evaluate(async ({ app }, { addon, archive, dest }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const backend = new native.Backend(app.getPath('userData'), app.getPath('temp'), () => {})
      await backend.init()
      return JSON.parse(await backend.invoke('content_extract_archive', JSON.stringify({ archivePath: archive, destDir: dest })))
    }, { addon, archive, dest })
    expect(extracted).toBe(1)
    expect(fs.readFileSync(path.join(dest, 'runtime/cli'), 'utf8')).toBe(contents.toString())
  } finally { await app.close() }
})
