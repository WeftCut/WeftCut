import { expect, test, type Locator } from '@playwright/test'
import { PNG } from 'pngjs'
import path from 'node:path'
import { importAndPlaceMedia, invokeCmd, launchApp, newProject, placeMediaLayer, tmpDir } from './helpers/driver'

// Inspect PAINTED pixels, not CSS widths: positioned thumbnail content can
// cover an inset parent outline even while getComputedStyle reports 2px.
async function paintedSelectionRows(clip: Locator, primary = false): Promise<number> {
  const png = PNG.sync.read(await clip.screenshot({ animations: 'disabled' }))
  const x = Math.floor(png.width * 0.8)
  let rows = 0
  for (let y = png.height - 8; y < png.height; y++) {
    const offset = (y * png.width + x) * 4
    // Primary is the pale-blue accent; secondary is --ring. Avoid image content: the fixture's
    // thumbnail is centered, leaving this column on the clip's plain fill.
    const color = primary ? [136, 175, 241] : [59, 130, 246]
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
      expect(await paintedSelectionRows(second)).toBeGreaterThan(0)
      expect(await paintedSelectionRows(first, true)).toBeGreaterThanOrEqual((await paintedSelectionRows(second)) + 1)
      await second.click({ position: { x: 80, y: 12 } })
      await expect(page.locator('.attribute-panel').getByLabel('Label', { exact: true })).toHaveValue('Clip B')
      await page.screenshot({ path: testInfo.outputPath(`primary-b-${linked ? 'linked' : 'multi'}.png`) })
      expect(await paintedSelectionRows(first)).toBeGreaterThan(0)
      expect(await paintedSelectionRows(second, true)).toBeGreaterThanOrEqual((await paintedSelectionRows(first)) + 1)
    }
  } finally {
    await app.close()
  }
})
