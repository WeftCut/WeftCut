import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'
import { AUTOSAVE_INTERVAL_MIN_SECS, SAVE_STATUS_CHANNEL, type SaveStatus } from '../../src/shared/save-status'
import { ATOMIC_TEMP_SUFFIX } from '../../src/main/atomicWrite'
import { saveFailureReasonKey } from '../../src/renderer/components/saveFailure'
import type { RendererOS } from '../../src/renderer/platform'
import enUS from '../../src/renderer/i18n/locales/en-US'

// A project whose saves fail end to end: the real autosave, the real atomic
// write, main's state, the Not saved pill and its popover in the status bar
// and in agent mode's titlebar, and the recovery through Retry now
// (docs/data-model.md § Saving).
//
// The failure is a DIRECTORY named like atomicWrite's temp file: opening it for
// writing fails on every OS, so every write of project.json fails until it goes.

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
/** The pill appears at the first failed write once the edit has waited the
 *  interval — a liveness bound, generous for a loaded runner. */
const PILL_WITHIN_MS = AUTOSAVE_INTERVAL_MIN_SECS * 1000 * 6

const OS: RendererOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'

/** The en-US reason the renderer shows for `code`. */
function reasonText(code: string | null): string {
  const key = saveFailureReasonKey(code, OS).replace('save_status.reason.', '') as keyof typeof enUS.save_status.reason
  return enUS.save_status.reason[key].replace('{{code}}', code ?? '')
}

function layerIds(projectFile: string): string[] {
  const p = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as { compositions: Record<string, { tracks: Array<{ layers: Array<{ id: string }> }> }> }
  return Object.values(p.compositions).flatMap((c) => c.tracks.flatMap((t) => t.layers.map((l) => l.id)))
}

test('a project that cannot be saved shows Not saved, offers recovery, and clears on the next good save', async () => {
  test.setTimeout(120_000 + PILL_WITHIN_MS)
  const { app, page } = await launchApp()
  try {
    // A project with the shortest autosave interval, so the state turns within seconds.
    const parent = tmpDir('weftcut-save-failure-')
    await newProject(page, { parentFolder: parent, name: 'seed', canvas: CANVAS })
    await invokeCmd(page, 'project_save')
    const seed = JSON.parse(fs.readFileSync(path.join(parent, 'seed', 'project.json'), 'utf8'))
    seed.settings.autosave_interval_secs = AUTOSAVE_INTERVAL_MIN_SECS
    const dir = path.join(parent, 'fast-autosave')
    const projectFile = path.join(dir, 'project.json')
    fs.mkdirSync(dir)
    fs.writeFileSync(projectFile, JSON.stringify(seed))
    await invokeCmd(page, 'project_open', { path: dir })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    const pill = page.locator('.status-bar').getByTestId('not-saved-pill')
    expect(await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)).toMatchObject({ state: 'ok' })
    const blocker = projectFile + ATOMIC_TEMP_SUFFIX
    fs.mkdirSync(blocker)
    const layerId = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 0, durationUs: 1_000_000, color: { r: 200, g: 40, b: 40, a: 255 },
    })

    await expect(pill).toBeVisible({ timeout: PILL_WITHIN_MS })
    await expect(pill).toHaveText(enUS.save_status.badge)
    const status = await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)
    if (status.state !== 'failing') throw new Error(`the pull disagrees with the pill: ${JSON.stringify(status)}`)
    expect(fs.realpathSync(status.path)).toBe(fs.realpathSync(projectFile))
    await expect(pill).toHaveAccessibleName(`${enUS.save_status.badge}: ${reasonText(status.code)}`)
    expect(layerIds(projectFile)).not.toContain(layerId)

    // The pill's popover is the recovery: the reason first, the folder, and
    // the three ways out. Escape closes it and hands focus back.
    const details = page.getByTestId('not-saved-details')
    await pill.click()
    await expect(details).toBeVisible()
    await expect(details.locator('.not-saved-reason')).toHaveText(reasonText(status.code))
    await expect(details).toContainText(status.dir)
    for (const name of [enUS.save_status.retry, enUS.save_status.save_as, enUS.save_status.open_folder]) {
      await expect(details.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(pill).toBeFocused()

    // Agent mode has no status bar: the pill rides its titlebar, and its
    // popover opens in place, below it, without leaving agent mode.
    await page.locator('.menu-trigger').nth(2).click()
    await page.locator('.app-menu-item').filter({ hasText: /^Enter Agent Mode$/ }).click()
    const shell = page.locator('.agent-mode-shell')
    await expect(shell).toBeVisible()
    const agentPill = page.locator('.agent-titlebar').getByTestId('not-saved-pill')
    await agentPill.click()
    await expect(details).toBeVisible()
    await expect(shell).toBeVisible()
    await expect(details).toContainText(reasonText(status.code))
    const below = await page.evaluate(() => {
      const bar = document.querySelector('.agent-titlebar')!.getBoundingClientRect()
      const box = document.querySelector('[data-testid="not-saved-details"]')!.getBoundingClientRect()
      return { barBottom: bar.bottom, top: box.top }
    })
    expect(below.top, `the popover drops below the titlebar: ${JSON.stringify(below)}`).toBeGreaterThanOrEqual(below.barBottom - 0.5)

    // The cause goes; Retry now saves, and the state clears with it, still in agent mode.
    fs.rmSync(blocker, { recursive: true })
    await details.getByRole('button', { name: enUS.save_status.retry, exact: true }).click()
    await expect(agentPill).toHaveCount(0, { timeout: 15_000 })
    await expect(details).toHaveCount(0)
    await expect(shell).toBeVisible()
    expect(layerIds(projectFile)).toContain(layerId)
    expect(await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)).toMatchObject({ state: 'ok' })
    await page.locator('.agent-exit-button').click()
    await expect(shell).toHaveCount(0)
    await expect(page.locator('.status-bar')).toBeVisible()
    await expect(pill).toHaveCount(0)
  } finally {
    await app.close()
  }
})
