import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import type { AppSettings } from '../../src/shared/app-settings'
import { DEFAULT_PREVIEW_GRID } from '../../src/shared/preview-grid'
import { driveExport, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

const canvas = (page: Page) => page.locator('.pixi-preview-canvas')
const overlay = (page: Page) => page.getByTestId('preview-grid')
const settings = (page: Page) => invokeCmd<AppSettings>(page, 'app_settings_get')

async function startPreview(page: Page, width: number, height: number) {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-e2e-grid-'),
    name: 'preview-grid',
    canvas: { width, height, fpsNum: 30, fpsDen: 1 },
  })
  await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 500_000 })
  await expect(canvas(page)).toBeVisible()
  await expect(page.getByTestId('pixi-preview-initializing')).toBeHidden()
  await expect(page.locator('.splash-screen')).toHaveCount(0)
}

async function expectGridSpacing(page: Page, xFraction: number, yFraction: number) {
  await expect.poll(() => overlay(page).evaluate((svg, { x, y }) => {
    const canvasBox = svg.parentElement!.querySelector('.pixi-preview-canvas')!.getBoundingClientRect()
    const lines = svg.querySelectorAll<SVGPathElement>('.preview-grid-line')
    if (!lines[0] || !lines[1]) return Infinity
    const at = (line: SVGPathElement) => line.getPointAtLength(0).matrixTransform(line.getScreenCTM()!)
    return Math.max(
      Math.abs(at(lines[0]).x - canvasBox.left - x * canvasBox.width),
      Math.abs(at(lines[1]).y - canvasBox.top - y * canvasBox.height),
      Math.abs(at(lines[0]).y - canvasBox.top),
      Math.abs(at(lines[1]).x - canvasBox.left),
    )
  }, { x: xFraction, y: yFraction })).toBeLessThanOrEqual(1)
}

test('Quick Actions edits independent grid preferences, and the grid follows fit, zoom and pan', async () => {
  const { app, page } = await launchApp()
  try {
    const width = 1600, height = 900
    await startPreview(page, width, height)
    const beforeProject = await invokeCmd(page, 'project_summary')
    const trigger = page.getByRole('button', { name: 'Grid', exact: true })
    const popup = page.getByRole('dialog', { name: 'Grid', exact: true })
    const number = (name: string) => popup.getByLabel(name, { exact: true })
    const fill = async (name: string, value: number) => {
      await number(name).fill(String(value))
      await number(name).press('Enter')
      // The number fields write through async IPC. Observe the committed
      // setting before editing the next axis to avoid racing their updates.
      const key = name === 'Columns' ? 'column_divisions' : 'row_divisions'
      await expect.poll(async () => (await settings(page)).preview_grid[key]).toBe(value)
    }
    await expect(overlay(page)).toHaveCount(0)
    await trigger.hover()
    await expect(popup).toBeVisible()
    await expect(trigger).toHaveAttribute('data-active', 'false')
    // Clicking the icon toggles snapping, not grid visibility.
    await trigger.click()
    await expect(trigger).toHaveAttribute('data-active', 'true')
    await expect(overlay(page)).toHaveCount(0)
    await expect(popup).toBeVisible()
    // The hover surface includes the portal menu, even across its positioner gap.
    await number('Columns').hover()
    await page.waitForTimeout(450)
    await expect(popup).toBeVisible()
    await expect(popup.locator('input.app-number-input')).toHaveCount(2)
    await expect(popup.getByRole('switch')).toHaveCount(0)
    await expect(popup.getByRole('combobox')).toHaveCount(0)
    await expect(popup.locator('.preview-grid-colon')).toHaveText(':')
    await expect(popup.getByTestId('preview-grid-visibility')).toHaveCount(1)
    await expect.poll(async () => (await popup.boundingBox())?.width ?? Infinity).toBeLessThan(220)
    await expect(number('Columns')).toHaveValue('3')
    await expect(number('Rows')).toHaveValue('3')
    await expect(popup.getByRole('button', { name: 'Show grid' })).toBeVisible()
    await popup.getByRole('button', { name: 'Show grid' }).click()
    await expect(overlay(page)).toBeVisible()
    await expect(overlay(page)).toHaveCSS('pointer-events', 'none')
    await expectGridSpacing(page, 1 / DEFAULT_PREVIEW_GRID.column_divisions, 1 / DEFAULT_PREVIEW_GRID.row_divisions)
    await fill('Columns', 12)
    await fill('Rows', 5)
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    await fill('Rows', 1)
    await expect(overlay(page).locator('.preview-grid-line')).toHaveCount(1)
    await fill('Columns', 1)
    await expect(overlay(page).locator('.preview-grid-line')).toHaveCount(0)
    await fill('Columns', 12)
    await fill('Rows', 5)
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    await popup.getByRole('button', { name: 'Hide grid' }).click()
    await expect(overlay(page)).toHaveCount(0)
    await expect(trigger).toHaveAttribute('data-active', 'true')
    await expect(popup).toBeVisible()
    await popup.getByRole('button', { name: 'Show grid' }).click()
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    await page.keyboard.press('Escape')
    await expect(popup).toBeHidden()

    const zoom = page.locator('.preview-zoom-select')
    await expect(zoom).toContainText('Fit')
    const surface = await page.locator('#video-surface').boundingBox()
    if (!surface) throw new Error('missing preview surface')
    const x = surface.x + surface.width / 2, y = surface.y + surface.height / 2
    const fit = (await canvas(page).boundingBox())!
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, -360)
    await expect.poll(async () => (await canvas(page).boundingBox())!.width).toBeGreaterThan(fit.width)
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    const beforePan = (await canvas(page).boundingBox())!
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(x + 30, y + 20, { steps: 5 })
    await page.mouse.up({ button: 'middle' })
    await expect.poll(async () => (await canvas(page).boundingBox())!.x).toBeGreaterThan(beforePan.x)
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    await page.keyboard.press('Z')
    await expect(zoom).toContainText('Fit')
    await expectGridSpacing(page, 1 / 12, 1 / 5)

    expect(await invokeCmd(page, 'project_summary')).toEqual(beforeProject)
    expect((await settings(page)).preview_grid).toMatchObject({
      visible: true, snap: true, column_divisions: 12, row_divisions: 5,
    })
  } finally {
    await app.close()
  }
})

test('the grid hover popup never sticks after repeated snap-icon clicks', async () => {
  const { app, page } = await launchApp()
  try {
    await startPreview(page, 1280, 720)
    const trigger = page.getByRole('button', { name: 'Grid', exact: true })
    const popup = page.getByRole('dialog', { name: 'Grid', exact: true })
    // Use a clear corner of the workspace, not the video surface: depending
    // on docking, the popup can cover the surface's hover point.
    const leaveMenu = async () => {
      const size = await page.evaluate(() => ({ x: innerWidth - 30, y: innerHeight - 30 }))
      await page.mouse.move(size.x, size.y)
    }
    // Start outside the trigger to guarantee a real pointer-enter even when
    // the test window was created with the cursor already over Quick Actions.
    await leaveMenu()
    for (let n = 0; n < 12; n++) {
      await trigger.hover()
      await expect(popup, 'grid popup must open in cycle ' + n).toBeVisible()
      await trigger.click()
      await expect(trigger).toHaveAttribute('data-active', n % 2 === 0 ? 'true' : 'false')
      await leaveMenu()
      await expect(popup).toBeHidden({ timeout: 2000 })
    }
    await trigger.hover()
    await expect(popup).toBeVisible()
    await popup.getByLabel('Columns', { exact: true }).hover()
    await page.waitForTimeout(450)
    await expect(popup).toBeVisible()
    await leaveMenu()
    await expect(popup).toBeHidden({ timeout: 2000 })

    // Interacting with the menu must not permanently pin it either.
    await trigger.hover()
    await expect(popup).toBeVisible()
    await popup.getByRole('button', { name: 'Show grid' }).click()
    await expect(popup).toBeVisible()
    await leaveMenu()
    await expect(popup).toBeHidden({ timeout: 2000 })

    await trigger.hover()
    await expect(popup).toBeVisible()
    await popup.getByLabel('Columns', { exact: true }).click()
    await expect(popup).toBeVisible()
    await leaveMenu()
    await expect(popup).toBeHidden({ timeout: 2000 })
  } finally {
    await app.close()
  }
})

test('the portrait grid follows the canvas and leaves exported frame pixels unchanged', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await startPreview(page, 360, 640)
    const folder = tmpDir('weftcut-e2e-grid-export-')
    const platform = process.platform === 'win32' ? 'win/ffmpeg.exe'
      : process.platform === 'darwin' ? 'mac/ffmpeg' : 'linux/ffmpeg'
    const ffmpeg = process.env.FFMPEG ?? fileURLToPath(new URL('../../resources/ffmpeg/' + platform, import.meta.url))
    const exportFrameHash = async (name: string) => {
      const outputAbsPath = path.join(folder, name + '.mp4')
      const result = await driveExport(page, { outputAbsPath }, { hook: 'exportTimeline' })
      expect(result.done.ok, result.done.error).toBe(true)
      return execFileSync(ffmpeg, [
        '-v', 'error', '-i', outputAbsPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'hash', '-',
      ], { encoding: 'utf8' }).trim()
    }

    const baseline = await exportFrameHash('hidden')
    expect(baseline).toMatch(/^SHA256=[\da-f]{64}$/)
    await invokeCmd(page, 'app_settings_set', { patch: {
      preview_grid: { visible: true, column_divisions: 12, row_divisions: 5 },
    } })
    await expect(overlay(page)).toBeVisible()
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    expect(await exportFrameHash('visible')).toBe(baseline)
  } finally {
    await app.close()
  }
})
