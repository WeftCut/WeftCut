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
// write, main's state, the status-bar badge, the System panel's card, and the
// recovery through Retry now (docs/data-model.md § Saving).
//
// The failure is a DIRECTORY named like atomicWrite's temp file: opening it for
// writing fails on every OS, so every write of project.json fails until it goes.

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
/** The badge appears at the first failed write once the edit has waited the
 *  interval — a liveness bound, generous for a loaded runner. */
const BADGE_WITHIN_MS = AUTOSAVE_INTERVAL_MIN_SECS * 1000 * 6

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
  test.setTimeout(120_000 + BADGE_WITHIN_MS)
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

    const badge = page.getByTestId('save-status-badge')
    expect(await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)).toMatchObject({ state: 'ok' })
    const blocker = projectFile + ATOMIC_TEMP_SUFFIX
    fs.mkdirSync(blocker)
    const layerId = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 0, durationUs: 1_000_000, color: { r: 200, g: 40, b: 40, a: 255 },
    })

    await expect(badge).toBeVisible({ timeout: BADGE_WITHIN_MS })
    await expect(badge).toHaveText(enUS.save_status.badge)
    const status = await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)
    if (status.state !== 'failing') throw new Error(`the pull disagrees with the badge: ${JSON.stringify(status)}`)
    expect(fs.realpathSync(status.path)).toBe(fs.realpathSync(projectFile))
    const title = await badge.getAttribute('title')
    expect(title?.split('\n')[0]).toBe(reasonText(status.code))
    expect(layerIds(projectFile)).not.toContain(layerId)

    // Agent mode has no status bar: the badge rides its titlebar, and leads
    // back to the editor's System panel.
    await page.locator('.menu-trigger').nth(2).click()
    await page.locator('.app-menu-item').filter({ hasText: /^Enter Agent Mode$/ }).click()
    await expect(page.locator('.agent-mode-shell')).toBeVisible()
    await page.locator('.agent-titlebar').getByTestId('save-status-badge').click()
    await expect(page.locator('.agent-mode-shell')).toHaveCount(0)

    const card = page.getByTestId('save-failure-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText(enUS.save_status.card_title)
    await expect(card).toContainText(reasonText(status.code))
    await expect(card).toContainText(status.path)

    // The cause goes; Retry now saves, and the state clears with it.
    fs.rmSync(blocker, { recursive: true })
    await card.getByRole('button', { name: enUS.save_status.retry }).click()
    await expect(badge).toHaveCount(0, { timeout: 15_000 })
    await expect(card).toHaveCount(0)
    expect(layerIds(projectFile)).toContain(layerId)
    expect(await invokeCmd<SaveStatus>(page, SAVE_STATUS_CHANNEL)).toMatchObject({ state: 'ok' })
  } finally {
    await app.close()
  }
})
