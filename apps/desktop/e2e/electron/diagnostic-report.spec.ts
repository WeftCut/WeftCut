import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'
import { forceCloseApp, launchApp, tmpDir } from './helpers/driver'

test('diagnostic export works before opening a project and normal quit does not prompt', async () => {
  const userDataDir = tmpDir('weftcut-report-clean-')
  const output = path.join(userDataDir, 'report.zip')
  const first = await launchApp({ userDataDir })
  try {
    await first.app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
    }, output)
    await first.page.getByRole('button', { name: 'Report an Issue…' }).click()
    await first.page.getByRole('button', { name: 'Export Diagnostic Bundle…' }).click()
    await expect(first.page.getByRole('status')).toContainText('Saved to')
    const files = unzipSync(fs.readFileSync(output))
    const env = JSON.parse(strFromU8(files['current/environment.json']!))
    const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
    expect(env).toMatchObject({ app: version, platform: process.platform, logicalCores: expect.any(Number) })
    const logs = strFromU8(files['current/events.jsonl']!)
    expect(logs).toContain('startup')
    expect(logs).toContain('resources')
    expect(logs).not.toContain(userDataDir)
  } finally { await first.app.close() }
  const second = await launchApp({ userDataDir })
  try {
    const summary = await second.page.evaluate(() => window.api.diagnostics.summary())
    expect(summary.previousSession).toBeNull()
    await expect(second.page.getByRole('button', { name: 'Report an Issue…' })).toBeVisible()
    await expect(second.page.getByRole('dialog')).toHaveCount(0)
  } finally { await second.app.close() }
})

/** Sends WM_ENDSESSION with wParam TRUE to `hwnd`, as Windows does to every
 *  window when the session ends. The receiver ends inside the call. */
function sendEndSession(hwnd: string): void {
  const script = [
    `$user32 = Add-Type -Namespace WeftCutE2E -Name User32 -PassThru -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);'`,
    `$result = [IntPtr]::Zero`,
    `[void]$user32::SendMessageTimeoutW([IntPtr]${hwnd}, 0x0016, [IntPtr]1, [IntPtr]::Zero, 0x0002, 30000, [ref]$result)`,
  ].join('\n')
  // Encoded: the quotes of the C# signature do not survive a -Command argument.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
}

test('a Windows session end is an orderly exit: the app ends itself and the next start does not prompt', async () => {
  test.skip(process.platform !== 'win32', 'WM_ENDSESSION is a Windows message')
  test.setTimeout(90_000)
  const userDataDir = tmpDir('weftcut-report-session-end-')
  const first = await launchApp({ userDataDir })
  const closed = first.app.waitForEvent('close')
  const editor = await first.app.browserWindow(first.page)
  sendEndSession(await editor.evaluate(win => win.getNativeWindowHandle().readBigUInt64LE(0).toString()))
  // No kill from the test: Electron terminates the process once the window's
  // `session-end` listeners return.
  await closed
  await first.app.close().catch(() => {})
  const sessionsDir = path.join(userDataDir, 'diagnostics-dev')
  const [session] = fs.readdirSync(sessionsDir)
  expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, session!, 'session.json'), 'utf8')))
    .toMatchObject({ closed: true, failed: false })
  expect(fs.readFileSync(path.join(sessionsDir, session!, 'events.jsonl'), 'utf8')).toContain('"kind":"session-end"')

  const second = await launchApp({ userDataDir })
  try {
    expect((await second.page.evaluate(() => window.api.diagnostics.summary())).previousSession).toBeNull()
    await expect(second.page.getByRole('dialog')).toHaveCount(0)
  } finally { await second.app.close() }
})

test('forced termination prompts on restart, exports the previous session and dismisses persistently', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataDir = tmpDir('weftcut-report-abrupt-')
  const first = await launchApp({ userDataDir })
  const closed = first.app.waitForEvent('close')
  // The cleanup helper sends SIGTERM on POSIX, which lets Electron quit cleanly.
  // A crash simulation must bypass quit handlers on every platform.
  if (process.platform === 'win32') forceCloseApp(first.app)
  else first.app.process().kill('SIGKILL')
  await closed
  await first.app.close().catch(() => {})
  const sessionsDir = path.join(userDataDir, 'diagnostics-dev')
  const [session] = fs.readdirSync(sessionsDir)
  expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, session!, 'session.json'), 'utf8')).closed).toBe(false)

  const second = await launchApp({ userDataDir })
  const output = path.join(userDataDir, 'abrupt.zip')
  try {
    await expect(second.page.getByRole('dialog', { name: 'WeftCut did not close normally last time' })).toBeVisible()
    await second.page.screenshot({ path: testInfo.outputPath('restart-report.png') })
    await second.app.evaluate(({ dialog, shell }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
      // Never open a real browser or submit a real issue during a test.
      shell.openExternal = async (url) => { (globalThis as any).__diagnosticIssueUrl = url }
    }, output)
    await second.page.getByRole('button', { name: 'Export Diagnostic Bundle…' }).click()
    await expect(second.page.getByRole('status')).toContainText('Saved to')
    const files = unzipSync(fs.readFileSync(output))
    expect(JSON.parse(strFromU8(files['previous/session.json']!)).closed).toBe(false)
    expect(strFromU8(files['previous/events.jsonl']!)).toContain('startup')
    await second.page.getByRole('button', { name: 'Open GitHub Issue' }).click()
    await expect.poll(() => second.app.evaluate(() => (globalThis as any).__diagnosticIssueUrl)).toContain('github.com/WeftCut/WeftCut/issues/new?')
    const issueUrl = new URL(await second.app.evaluate(() => (globalThis as any).__diagnosticIssueUrl))
    expect(issueUrl.searchParams.get('template')).toBe('bug_report.yml')
    expect(issueUrl.searchParams.get('what')).toContain('unclean-exit')
    await second.page.getByRole('button', { name: 'Not Now' }).click()
    await expect(second.page.getByRole('dialog')).toHaveCount(0)
  } finally { await second.app.close() }
  const third = await launchApp({ userDataDir })
  try {
    expect((await third.page.evaluate(() => window.api.diagnostics.summary())).previousSession).toBeNull()
  } finally { await third.app.close() }
})
