// e2e gate: a file the OS hands WeftCut opens in the editor (ADR 0181), by
// each route it arrives on: the command line of the launch it starts, the
// handoff of a second launch to the running app, and macOS `open-file`. The
// OS side (an installer's registration, a double-click) is outside the suite;
// these are the arguments and events it produces.

import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { invokeCmd, launchApp, launchExpectingExit, newProject, tmpDir, waitForHook } from './helpers/driver'
import { PROJECT_FILE } from '../../src/shared/projectFile'

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const NEW_WORKSPACE = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

/// The project main has open, and the one the editor on screen shows: both
/// must name it before the open counts as followed.
async function shown(page: Page): Promise<{ open: string | null; editor: string | null }> {
  const open = (await invokeCmd<{ dir: string } | null>(page, 'project_open_state'))?.dir ?? null
  const editor = await page.evaluate(() => (window as any).__weftcutTest?.projectStoreSummary?.()?.name ?? null) as string | null
  return { open, editor }
}

test('the file a launch names opens, before the last project', async () => {
  test.setTimeout(180_000)
  const userDataDir = tmpDir('wc-file-open-launch-')
  const parent = tmpDir('wc-file-open-launch-projects-')
  const first = await launchApp({ userDataDir })
  let named = ''
  try {
    named = await invokeCmd<string>(first.page, 'project_new_workspace', { parentFolder: parent, name: 'Named', ...NEW_WORKSPACE })
    await invokeCmd(first.page, 'project_new_workspace', { parentFolder: parent, name: 'Last', ...NEW_WORKSPACE })
    // Reopening the last project would open Last: the named file comes first.
    await invokeCmd(first.page, 'recents_set_reopen_on_launch', { value: true })
  } finally {
    await first.app.close()
  }

  const { app, page } = await launchApp({ userDataDir, appArgs: [path.join(named, PROJECT_FILE)] })
  try {
    await waitForHook(page, 'projectStoreSummary')
    await expect.poll(() => shown(page), { timeout: 60_000, message: 'the launch file never opened in the editor' })
      .toEqual({ open: named, editor: 'Named' })
  } finally {
    await app.close()
  }
})

test('a running app opens the file of a second launch, and of a macOS open-file', async () => {
  test.setTimeout(180_000)
  const userDataDir = tmpDir('wc-file-open-running-')
  const parent = tmpDir('wc-file-open-running-projects-')
  const { app, page } = await launchApp({ userDataDir })
  try {
    const handed = await invokeCmd<string>(page, 'project_new_workspace', { parentFolder: parent, name: 'Handed', ...NEW_WORKSPACE })
    await newProject(page, { parentFolder: parent, name: 'Current', canvas: CANVAS })
    const current = path.join(parent, 'Current')
    await waitForHook(page, 'projectStoreSummary')
    await expect.poll(() => shown(page)).toEqual({ open: current, editor: 'Current' })

    // The second launch quits by itself and the running editor moves to its file.
    const second = await launchExpectingExit(userDataDir, 60_000, [path.join(handed, PROJECT_FILE)])
    expect(second.end, `the second launch did not exit cleanly; its stderr ended with:\n${second.stderr}`).toBe('code 0')
    await expect.poll(() => shown(page), { timeout: 60_000, message: "the second launch's file never opened" })
      .toEqual({ open: handed, editor: 'Handed' })

    // What macOS sends the running app instead of starting another.
    await app.evaluate(({ app: electronApp }, file) => {
      electronApp.emit('open-file', { preventDefault() {} }, file)
    }, path.join(current, PROJECT_FILE))
    await expect.poll(() => shown(page), { timeout: 60_000, message: 'the open-file never opened' })
      .toEqual({ open: current, editor: 'Current' })
  } finally {
    await app.close()
  }
})
