import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import type { AppSettings } from '../../src/shared/app-settings'
import { GRID_DIVISIONS_MAX } from '../../src/shared/preview-grid'
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

/** Every preview-bar control shares one height and one centre line: the bar
 *  never wraps, and no control sits taller than the rest. */
async function expectOneRowOfEqualControls(page: Page) {
  const rects = await page.evaluate(() => {
    const selectors = [
      '.preview-target-select',
      '.preview-zoom-select',
      '.preview-grid-count .app-input',
      '[data-testid="grid-columns-visible"]',
      '[data-testid="grid-rows-visible"]',
      '[data-testid="grid-eye"]',
    ]
    return selectors.map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      if (!rect) throw new Error(`missing preview bar control: ${selector}`)
      return { selector, height: rect.height, centerY: rect.top + rect.height / 2 }
    })
  })
  for (const rect of rects) {
    expect(rect.height, `${rect.selector} height`).toBe(rects[0]!.height)
    expect(rect.centerY, `${rect.selector} centre line`).toBe(rects[0]!.centerY)
  }
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

test('Quick Actions toggles the grid; the preview bar edits columns, rows and axes', async () => {
  const { app, page } = await launchApp()
  try {
    const width = 1600, height = 900
    await startPreview(page, width, height)
    const beforeProject = await invokeCmd(page, 'project_summary')
    const bar = page.locator('.preview-target-bar')
    const baselineHeight = (await bar.boundingBox())!.height
    const gridButton = page.locator('[data-quick-action="togglePreviewGrid"]')
    const snapButton = page.locator('[data-quick-action="togglePreviewSnap"]')
    const toolbar = page.getByTestId('preview-grid-toolbar')
    await expect(gridButton).toHaveAttribute('aria-pressed', 'false')
    await expect(toolbar).toHaveCount(0)
    await expect(overlay(page)).toHaveCount(0)
    await gridButton.click()
    await expect(gridButton).toHaveAttribute('aria-pressed', 'true')
    await expect(toolbar).toBeVisible()
    await expectOneRowOfEqualControls(page)
    await expect.poll(async () => (await bar.boundingBox())!.height).toBe(baselineHeight)
    await expect(toolbar.getByLabel('Columns', { exact: true })).toHaveValue('3')
    await expect(toolbar.getByLabel('Rows', { exact: true })).toHaveValue('3')
    await expectGridSpacing(page, 1 / 3, 1 / 3)

    const columns = toolbar.getByLabel('Columns', { exact: true })
    const rows = toolbar.getByLabel('Rows', { exact: true })
    await columns.fill('12')
    await expect.poll(async () => (await settings(page)).preview_grid.column_divisions).toBe(12)
    await rows.fill('5')
    await expect.poll(async () => (await settings(page)).preview_grid.row_divisions).toBe(5)
    await expectGridSpacing(page, 1 / 12, 1 / 5)

    await toolbar.getByTestId('grid-rows-visible').click()
    await expect(toolbar.getByTestId('grid-rows-visible')).toHaveAttribute('aria-pressed', 'false')
    await expect(overlay(page).locator('.preview-grid-line')).toHaveCount(1)
    await expect(rows).toHaveValue('5')
    await toolbar.getByTestId('grid-columns-visible').click()
    await expect(overlay(page)).toHaveCount(0)
    await toolbar.getByTestId('grid-columns-visible').click()
    await toolbar.getByTestId('grid-rows-visible').click()
    await expectGridSpacing(page, 1 / 12, 1 / 5)

    await snapButton.click()
    await expect(snapButton).toHaveAttribute('aria-pressed', 'false')
    await snapButton.click()
    await expect(snapButton).toHaveAttribute('aria-pressed', 'true')
    // The eye hides the lines only: the grid stays on (and snapping with it).
    const eye = toolbar.getByTestId('grid-eye')
    await invokeCmd(page, 'app_settings_set', { patch: { preview_grid: { opacity: 47 } } })
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await expect(overlay(page)).toHaveCount(0)
    expect((await settings(page)).preview_grid).toMatchObject({ enabled: true, hidden: true, opacity: 47 })
    await expect(gridButton).toHaveAttribute('aria-pressed', 'true')
    await expect(snapButton).toHaveAttribute('aria-pressed', 'true')
    await expect(toolbar).toBeVisible()
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    await expectGridSpacing(page, 1 / 12, 1 / 5)

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
      enabled: true, hidden: false, opacity: 47, column_divisions: 12, row_divisions: 5,
    })
  } finally {
    await app.close()
  }
})

test('a hidden grid stays hidden across a restart and comes back at its own opacity', async () => {
  const userDataDir = tmpDir('weftcut-e2e-grid-profile-')
  const first = await launchApp({ userDataDir })
  try {
    await startPreview(first.page, 1280, 720)
    await invokeCmd(first.page, 'app_settings_set', { patch: { preview_grid: { enabled: true, opacity: 40 } } })
    const eye = first.page.getByTestId('grid-eye')
    await expect(overlay(first.page).locator('g[opacity="0.4"]').first()).toBeAttached()
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await settings(first.page)).preview_grid.hidden).toBe(true)
  } finally {
    await first.app.close()
  }

  const second = await launchApp({ userDataDir })
  try {
    const { page } = second
    await page.locator('.startup-recent-item').filter({ hasText: 'preview-grid' }).click()
    await expect(page.getByTestId('pixi-preview-initializing')).toBeHidden()
    const eye = page.getByTestId('grid-eye')
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await expect(overlay(page)).toHaveCount(0)
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    await expect(overlay(page).locator('g[opacity="0.4"]').first()).toBeAttached()
  } finally {
    await second.app.close()
  }
})

test('Enter and Escape return focus from grid fields to the preview region', async () => {
  const { app, page } = await launchApp()
  try {
    await startPreview(page, 1280, 720)
    await page.locator('[data-quick-action="togglePreviewGrid"]').click()
    const count = page.getByTestId('preview-grid-toolbar').getByLabel('Columns', { exact: true })
    await count.fill('12')
    await count.press('Enter')
    await expect.poll(async () => (await settings(page)).preview_grid.column_divisions).toBe(12)
    await expect(page.locator('[data-focus-region="preview"]')).toBeFocused()
    // Escape leaves the field and returns to canvas. Whether a preceding edit
    // has already auto-committed depends on the number field's debounce.
    await count.focus()
    await count.press('Escape')
    await expect(page.locator('[data-focus-region="preview"]')).toBeFocused()
    expect((await settings(page)).preview_grid.column_divisions).toBe(12)
  } finally {
    await app.close()
  }
})

test('the count fields hold the largest count with the steppers clear of the digits', async () => {
  const { app, page } = await launchApp()
  try {
    await startPreview(page, 853, 480)
    await page.locator('[data-quick-action="togglePreviewGrid"]').click()
    const toolbar = page.getByTestId('preview-grid-toolbar')
    const columns = toolbar.getByLabel('Columns', { exact: true })
    const rows = toolbar.getByLabel('Rows', { exact: true })
    const max = String(GRID_DIVISIONS_MAX)
    for (const field of [columns, rows]) await field.fill(max)
    await expect.poll(async () => (await settings(page)).preview_grid.column_divisions).toBe(GRID_DIVISIONS_MAX)
    await expect.poll(async () => (await settings(page)).preview_grid.row_divisions).toBe(GRID_DIVISIONS_MAX)
    await expect(columns).toHaveValue(max)
    await expect(rows).toHaveValue(max)
    // The text stays centred even on hover; the chevrons must not cover either digit.
    for (const field of [columns, rows]) {
      await field.hover()
      const clearance = await field.evaluate((input) => {
        const fieldBounds = input.getBoundingClientRect()
        const stepper = input.closest('.app-number-field')?.querySelector('.app-number-steppers')
        if (!stepper) throw new Error('missing number-field chevrons')
        const stepperBounds = stepper.getBoundingClientRect()
        if (stepperBounds.width === 0) throw new Error('number-field chevrons are not visible on hover')
        const style = getComputedStyle(input)
        if (style.textAlign !== 'center') throw new Error('grid count is no longer centred')
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')!
        context.font = style.font
        const textWidth = context.measureText((input as HTMLInputElement).value).width
        const textRight = fieldBounds.left + (fieldBounds.width + textWidth) / 2
        return stepperBounds.left - textRight
      })
      expect(clearance, 'chevrons must clear a centred two-digit number').toBeGreaterThanOrEqual(2)
    }
    await expectGridSpacing(page, 1 / GRID_DIVISIONS_MAX, 1 / GRID_DIVISIONS_MAX)
    // Typing past the limit settles on the limit.
    await columns.fill(String(GRID_DIVISIONS_MAX + 1))
    await columns.press('Tab')
    await expect(columns).toHaveValue(max)
    expect((await settings(page)).preview_grid.column_divisions).toBe(GRID_DIVISIONS_MAX)
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
      preview_grid: { enabled: true, column_divisions: 12, row_divisions: 5 },
    } })
    await expect(overlay(page)).toBeVisible()
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    expect(await exportFrameHash('visible')).toBe(baseline)
  } finally {
    await app.close()
  }
})

test('turning the grid on keeps the preview bar one row at every panel width', async () => {
  const { app, page } = await launchApp()
  try {
    await startPreview(page, 1280, 720)
    const bar = page.locator('.preview-target-bar')
    const grid = page.getByTestId('preview-grid-toolbar')
    for (const width of [1100, 850, 650, 500]) {
      await page.setViewportSize({ width, height: 840 })
      await invokeCmd(page, 'app_settings_set', { patch: { preview_grid: { enabled: false } } })
      await expect(grid).toHaveCount(0)
      const before = (await bar.boundingBox())!.height
      await invokeCmd(page, 'app_settings_set', { patch: { preview_grid: { enabled: true } } })
      await expect(grid).toBeAttached()
      await expect.poll(async () => (await bar.boundingBox())!.height).toBe(before)
      await expectOneRowOfEqualControls(page)
    }
  } finally {
    await app.close()
  }
})
