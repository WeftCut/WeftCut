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

test('forced termination prompts on restart, exports the previous session and dismisses persistently', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataDir = tmpDir('weftcut-report-abrupt-')
  const first = await launchApp({ userDataDir })
  const closed = first.app.waitForEvent('close')
  forceCloseApp(first.app)
  await closed
  await first.app.close().catch(() => {})

  const second = await launchApp({ userDataDir })
  const output = path.join(userDataDir, 'abrupt.zip')
  try {
    await expect(second.page.getByRole('dialog', { name: 'The previous session did not exit normally' })).toBeVisible()
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
