// e2e gate: one WeftCut per profile (ADR 0163). A second launch on the same
// userData exits and hands itself to the running instance; a launch on another
// profile is a separate app. Raising and focusing the window are not asserted:
// a CI display server without a window manager has neither.

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { launchApp, launchExpectingExit, tmpDir } from './helpers/driver'

/// Count the `second-instance` events the running app receives from here on.
async function countSecondInstances(app: ElectronApplication): Promise<() => Promise<number>> {
  await app.evaluate(({ app: electronApp }) => {
    const g = globalThis as { weftcutSecondInstances?: number }
    g.weftcutSecondInstances = 0
    electronApp.on('second-instance', () => { g.weftcutSecondInstances! += 1 })
  })
  return () => app.evaluate(() => (globalThis as { weftcutSecondInstances?: number }).weftcutSecondInstances ?? -1)
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
