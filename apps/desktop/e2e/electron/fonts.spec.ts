import { test, expect } from '@playwright/test'
import { launchApp, invokeCmd, newProject, tmpDir } from './helpers/driver'
import type { AppSettings } from '../../src/shared/app-settings'
import type { ProjectSummary } from '../../src/renderer/ipc'

test('system font picker persists a preference and new text uses it through real IPC', async () => {
  const { app, page } = await launchApp()
  try {
    const families = await page.evaluate(() => window.api.font.listFamilies())
    expect(new Set(families.map((family) => family.toLowerCase())).size).toBe(families.length)
    // Headless machines can legitimately have no system fonts; bundled choices
    // must still make the setting usable there.
    const family = families[0] ?? 'Liberation Sans'
    if (families.length) {
      const length = await page.evaluate(async (name) => (await window.api.font.resolve(name))?.byteLength, family)
      expect(length).toBeGreaterThan(0)
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const picker = page.getByRole('combobox', { name: 'Default text font' })
    await expect(picker).toContainText('App default')
    await expect(page.getByText('Loading installed fonts…')).toHaveCount(0)
    await picker.click()
    const popup = page.locator('.font-select-popup')
    await expect(popup).toBeVisible()
    const height = await popup.evaluate((el) => el.getBoundingClientRect().height)
    expect(height).toBeLessThanOrEqual(360)
    await page.getByRole('option', { name: family, exact: true }).click()
    await expect.poll(async () => (await invokeCmd<AppSettings>(page, 'app_settings_get')).default_text_font).toBe(family)
    await page.keyboard.press('Escape')
    await newProject(page, { parentFolder: tmpDir('weftcut-fonts-'), name: 'Font preference', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    const id = await invokeCmd<string>(page, 'add_text_layer', { tStartUs: 0 })
    const summary = await invokeCmd<ProjectSummary>(page, 'project_summary')
    const layer = summary.compositions[summary.root_id].tracks.flatMap((track) => track.layers).find((item) => item.id === id)
    expect(layer?.params).toMatchObject({ kind: 'Text', font_family: family })
    // The settings reader is main-owned disk state, not the picker state.
    await invokeCmd(page, 'app_settings_set', { patch: { default_text_font: '' } })
    expect((await invokeCmd<AppSettings>(page, 'app_settings_get')).default_text_font).toBeUndefined()
  } finally {
    await app.close()
  }
})
