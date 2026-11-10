// e2e gate: one WeftCut per profile (ADR 0163). A second launch on the same
// userData exits and hands itself to the running instance; a launch on another
// profile is a separate app. Raising and focusing the window are not asserted:
// a CI display server without a window manager has neither.

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { GL_SWITCHES, MAIN, launchApp, tmpDir } from './helpers/driver'

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string

/// Count the `second-instance` events the running app receives from here on.
async function countSecondInstances(app: ElectronApplication): Promise<() => Promise<number>> {
  await app.evaluate(({ app: electronApp }) => {
    const g = globalThis as { weftcutSecondInstances?: number }
    g.weftcutSecondInstances = 0
    electronApp.on('second-instance', () => { g.weftcutSecondInstances! += 1 })
  })
  return () => app.evaluate(() => (globalThis as { weftcutSecondInstances?: number }).weftcutSecondInstances ?? -1)
}

/// How a bare launch ended: its exit code and signal, or 'still running' once
/// the bound passed (it is then killed), with the tail of its stderr.
type LaunchEnd = { end: string; stderr: string }

/// Launch a bare process on `userDataDir` and report how it ended. Only for a
/// launch expected to exit by itself: Playwright's launcher would wait for a
/// window that never opens.
function launchExpectingExit(userDataDir: string, boundMs: number): Promise<LaunchEnd> {
  // Playwright's Electron launcher adds --no-sandbox on Linux; without it the
  // GitHub Ubuntu runner, which cannot start Chromium's sandbox, kills the
  // process with SIGTRAP before the app's code runs.
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : []
  const child = spawn(ELECTRON, [...sandbox, ...GL_SWITCHES, `--user-data-dir=${userDataDir}`, MAIN], {
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve({ end: 'still running', stderr })
    }, boundMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ end: signal ? `signal ${signal}` : `code ${code}`, stderr })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

test('a second launch on the same profile exits and reaches the running app', async () => {
  test.setTimeout(150_000)
  const userDataDir = tmpDir('wc-single-instance-')
  const { app } = await launchApp({ userDataDir })
  try {
    const secondInstances = await countSecondInstances(app)

    // Another profile is another app: launchApp resolves only once it has its
    // own window, and the running instance hears nothing of it.
    const other = await launchApp()
    await other.app.close()
    expect(await secondInstances(), 'a launch on another profile reached the running app').toBe(0)

    // The same profile: the new process quits on its own, cleanly, and the
    // running instance is told.
    const second = await launchExpectingExit(userDataDir, 60_000)
    expect(second.end, `the second launch did not exit cleanly; its stderr ended with:\n${second.stderr}`).toBe('code 0')
    await expect.poll(secondInstances, { timeout: 20_000, message: 'the running app never received second-instance' }).toBe(1)
  } finally {
    await app.close()
  }
})
