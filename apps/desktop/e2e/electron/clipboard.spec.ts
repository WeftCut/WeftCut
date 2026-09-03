import { test, expect } from '@playwright/test'

import { launchApp } from './helpers/driver'

// Every copy affordance in the renderer (log console, About dialog, agent
// settings) goes through `navigator.clipboard`; Electron's own `clipboard`
// module is main-process only. This is the one real-engine check that the web
// API reaches the OS clipboard from a sandboxed, context-isolated renderer —
// no unit test can stand in for it. It overwrites the machine's clipboard with
// a throwaway token when run locally.

test('navigator.clipboard writes reach the OS clipboard and read back', async () => {
  const { app, page } = await launchApp()
  try {
    // Clipboard access is gated on document focus; make sure the window has it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5_000 }).toBe(true)

    const token = `weftcut-clipboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await page.evaluate((t) => navigator.clipboard.writeText(t), token)

    // Oracle: the main-process clipboard module reads what the OS holds.
    // (`await` covers both the synchronous pre-44 and the Promise-returning
    // Electron 44 signatures.)
    await expect
      .poll(() => app.evaluate(async ({ clipboard }) => await clipboard.readText()), { timeout: 5_000 })
      .toBe(token)

    // And the renderer reads it back through the same web API it writes with.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token)
  } finally {
    await app.close()
  }
})
