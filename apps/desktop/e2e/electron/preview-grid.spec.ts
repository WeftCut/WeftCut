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
    const trigger = page.getByRole('button', { name: 'Canvas snapping and grid', exact: true })
    const popup = page.getByRole('dialog', { name: 'Canvas snapping and grid' })
    const toggle = (name: string) => popup.getByRole('switch', { name, exact: true })
    const number = (name: string) => popup.getByLabel(name, { exact: true })
    const fill = async (name: string, value: number) => {
      await number(name).fill(String(value))
      await number(name).press('Enter')
    }

    await expect(overlay(page)).toHaveCount(0)
    await trigger.click()
    await expect(popup).toBeVisible()
    const horizontalPadding = await popup.evaluate((element) => {
      const style = getComputedStyle(element)
      const intended = 12 * Number(style.getPropertyValue('--layout-font-scale'))
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight), intended }
    })
    expect(horizontalPadding.left).toBeCloseTo(horizontalPadding.intended)
    expect(horizontalPadding.right).toBeCloseTo(horizontalPadding.intended)
    await expect(popup.getByLabel('Timeline snap strength', { exact: true })).toHaveCount(0)
    await fill('Canvas snap strength', 23)
    await expect.poll(async () => (await settings(page)).preview_snap_strength_px).toBe(23)

    await toggle('Snap to frame and layers').click()
    await expect(toggle('Snap to frame and layers')).toHaveAttribute('aria-checked', 'false')
    await toggle('Snap to grid').click()
    await expect(toggle('Snap to grid')).toHaveAttribute('aria-checked', 'true')
    await expect(overlay(page)).toHaveCount(0)
    await expect(number('Canvas snap strength')).toBeEnabled()

    await toggle('Show grid').click()
    await expect(overlay(page)).toBeVisible()
    await expect(overlay(page)).toHaveCSS('pointer-events', 'none')
    await expectGridSpacing(page, 1 / DEFAULT_PREVIEW_GRID.column_divisions, 1 / DEFAULT_PREVIEW_GRID.row_divisions)
    await fill('Columns', 12)
    await fill('Rows', 5)
    await expectGridSpacing(page, 1 / 12, 1 / 5)
    await toggle('Horizontal grid lines').click()
    await expect(number('Rows')).toBeDisabled()
    await expect(overlay(page).locator('.preview-grid-line')).toHaveCount(1)
    await toggle('Vertical grid lines').click()
    await expect(number('Columns')).toBeDisabled()
    await expect(overlay(page)).toHaveCount(0)
    await toggle('Vertical grid lines').click()
    await toggle('Horizontal grid lines').click()
    await toggle('Snap to grid').click()
    await expect(toggle('Snap to grid')).toHaveAttribute('aria-checked', 'false')
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
      visible: true, snap: false, column_divisions: 12, row_divisions: 5,
    })
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
