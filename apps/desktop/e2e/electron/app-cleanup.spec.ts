import { test, expect, _electron as electron } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { forceCloseApp, GL_SWITCHES, tmpDir } from './helpers/driver'

// A child holding Electron's stdout open reproduces #367: killing only the
// main process emits 'exit', but not 'close', so Playwright's worker cleanup
// still waits for the app after all test assertions have passed.
test('force-close releases inherited pipes before the worker tears down', async () => {
  const dir = tmpDir('weftcut-e2e-cleanup-')
  const main = path.join(dir, 'main.cjs')
  const childScript = `
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    process.send('ready')
  `
  writeFileSync(main, `
    const { app, BrowserWindow } = require('electron')
    const { spawn } = require('node:child_process')
    global.childReady = new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      child.once('message', () => resolve(child.pid))
    })
    app.whenReady().then(() => {
      new BrowserWindow({ show: false }).loadURL('about:blank')
    })
  `)
  const app = await electron.launch({ args: [...GL_SWITCHES, `--user-data-dir=${dir}`, main] })
  const proc = app.process()
  let closed = false
  const onClose = new Promise<void>(resolve => proc.once('close', () => {
    closed = true
    resolve()
  }))
  let childPid: number | undefined
  try {
    childPid = await app.evaluate(() => (globalThis as any).childReady)
    forceCloseApp(app)
    await expect.poll(() => closed, {
      timeout: 3_000,
      message: 'Electron exited but a descendant still holds its stdio pipes open',
    }).toBe(true)
  } finally {
    // Reap the synthetic child even against the broken implementation, so a
    // failed regression assertion cannot itself strand the Playwright worker.
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    await app.close().catch(() => {})
    await onClose
  }
})
