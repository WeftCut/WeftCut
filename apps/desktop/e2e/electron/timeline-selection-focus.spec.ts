import { expect, test, type Locator, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import path from 'node:path'
import { importAndPlaceMedia, invokeCmd, launchApp, newProject, placeMediaLayer, tmpDir } from './helpers/driver'

async function selectionColors(page: Page): Promise<{ secondary: number[]; primary: number[] }> {
  // The PNG can carry the display's P3 profile on macOS. Render independent
  // reference swatches through the same capture path instead of treating
  // sRGB CSS bytes as display-profile PNG bytes.
  await page.evaluate(() => {
    const reference = document.createElement('div')
    reference.dataset.testid = 'selection-color-reference'
    reference.style.cssText = 'position:fixed;left:50px;top:80px;z-index:2147483646;display:flex;pointer-events:none'
    for (const color of ['var(--ring)', 'color-mix(in srgb, var(--ring) 55%, var(--foreground))']) {
      const swatch = document.createElement('div')
      swatch.style.cssText = `width:20px;height:20px;background:${color}`
      reference.append(swatch)
    }
    document.body.append(reference)
  })
  const reference = page.getByTestId('selection-color-reference')
  try {
    const buffer = await reference.screenshot()
    await test.info().attach('selection-color-reference', { body: buffer, contentType: 'image/png' })
    const png = PNG.sync.read(buffer)
    const colorAt = (f: number) => {
      const offset = (Math.floor(png.height / 2) * png.width + Math.floor(png.width * f)) * 4
      return [...png.data.subarray(offset, offset + 3)]
    }
    return { secondary: colorAt(0.25), primary: colorAt(0.75) }
  } finally { await reference.evaluate(el => el.remove()) }
}

// Inspect PAINTED pixels, not CSS widths: positioned thumbnail content can
// cover an inset parent outline even while getComputedStyle reports 2px.
async function paintedSelectionRows(clip: Locator, color: number[]): Promise<number> {
  const png = PNG.sync.read(await clip.screenshot({ animations: 'disabled' }))
  const x = Math.floor(png.width * 0.8)
  let rows = 0
  for (let y = png.height - 8; y < png.height; y++) {
    const offset = (y * png.width + x) * 4
    // Primary is the pale-blue accent; secondary is --ring. Avoid image content: the fixture's
    // thumbnail is centered, leaving this column on the clip's plain fill.
    if (color.every((v, i) => Math.abs(png.data[offset + i]! - v) < 10)) rows++
  }
  return rows
}

test('primary selection remains visible over clip thumbnails', async ({}, testInfo) => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-selection-focus-'), name: 'selection-focus',
      canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
    })
    await expect(page.locator('.splash-screen')).toHaveCount(0)
    const { secondary: secondaryColor, primary: primaryColor } = await selectionColors(page)
    expect(primaryColor).not.toEqual(secondaryColor)
    await page.locator('button[data-quick-action="toggleDisplayMode"]').click()
    const a = await importAndPlaceMedia(page, {
      mediaAbsPath: path.resolve('e2e/fixtures/media/test_chart_320x240.png'),
    })
    const b = await placeMediaLayer(page, { mediaId: a.mediaId })
    await invokeCmd(page, 'update_layer', { layerId: a.layerId, patch: { label: 'Clip A' } })
    await invokeCmd(page, 'update_layer', { layerId: b.layerId, patch: { label: 'Clip B' } })
    const first = page.locator(`[data-layer-id="${a.layerId}"]`)
    const second = page.locator(`[data-layer-id="${b.layerId}"]`)
    await first.click({ position: { x: 80, y: 12 } })
    await second.click({ position: { x: 80, y: 12 }, modifiers: ['Shift'] })
    for (const linked of [false, true]) {
      if (linked) await invokeCmd(page, 'links_create', { layerIds: [a.layerId, b.layerId] })
      await first.click({ position: { x: 80, y: 12 } })
      await expect(page.locator('.attribute-panel').getByLabel('Label', { exact: true })).toHaveValue('Clip A')
      await page.screenshot({ path: testInfo.outputPath(`primary-a-${linked ? 'linked' : 'multi'}.png`) })
      expect(await paintedSelectionRows(second, secondaryColor)).toBeGreaterThan(0)
      expect(await paintedSelectionRows(first, primaryColor)).toBeGreaterThanOrEqual((await paintedSelectionRows(second, secondaryColor)) + 1)
      // Negative control: calibration must still detect a covered/missing
      // outline rather than mistake the thumbnail or clip fill for selection.
      const outline = first.getByTestId('layer-selection-outline')
      await outline.evaluate(el => { el.style.visibility = 'hidden' })
      try { expect(await paintedSelectionRows(first, primaryColor)).toBe(0) }
      finally { await outline.evaluate(el => { el.style.visibility = '' }) }
      await second.click({ position: { x: 80, y: 12 } })
      await expect(page.locator('.attribute-panel').getByLabel('Label', { exact: true })).toHaveValue('Clip B')
      await page.screenshot({ path: testInfo.outputPath(`primary-b-${linked ? 'linked' : 'multi'}.png`) })
      expect(await paintedSelectionRows(first, secondaryColor)).toBeGreaterThan(0)
      expect(await paintedSelectionRows(second, primaryColor)).toBeGreaterThanOrEqual((await paintedSelectionRows(first, secondaryColor)) + 1)
    }
  } finally {
    await app.close()
  }
})
