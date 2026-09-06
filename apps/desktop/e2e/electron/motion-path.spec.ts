import { expect, test, type Page } from '@playwright/test'
import { invokeCmd, launchApp, newProject, summary, tmpDir, waitForHook } from './helpers/driver'
import type { PositionAnimation } from '../../src/shared/position'

async function position(page: Page, id: string): Promise<PositionAnimation> {
  const s = await summary(page)
  const layer = s.tracks.flatMap(t => t.layers).find(l => l.id === id)!
  return (layer.params as unknown as { position: PositionAnimation }).position
}

test('motion path creation, point dragging, conversion preview/cancel/apply and undo', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-path-'), name: `path-${Date.now()}`, canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 } })
    const id = await invokeCmd<string>(page, 'add_text_layer', { tStartUs: 0, durationUs: 2_000_000, content: 'Motion path' })
    await waitForHook(page, 'revealLayer')
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), id)
    const fields = page.getByTestId('position-fields')
    await expect(fields).toBeVisible()
    const original = await position(page, id)
    await fields.getByRole('button', { name: /Create motion path|创建.*路径/ }).click()
    await expect.poll(async () => (await position(page, id)).mode).toBe('Path')
    const before = await position(page, id)
    if (before.mode !== 'Path') throw new Error('Path not created')
    const node = page.getByTestId('path-0-point')
    await expect(node).toBeVisible()
    const box = (await node.boundingBox())!
    const canvas = (await page.locator('.pixi-preview-canvas').boundingBox())!
    expect(box.x + box.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0)
    expect(box.y + box.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 0)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 20, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => {
      const p = await position(page, id)
      return p.mode === 'Path' ? p.path.nodes[0]!.point.x : 0
    }).toBeGreaterThan(before.path.nodes[0]!.point.x + 10)
    const moved = await position(page, id)
    if (moved.mode !== 'Path') throw new Error('Path lost during edit')
    expect(moved.path.nodes[0]!.point.x - before.path.nodes[0]!.point.x).toBeCloseTo(30 / (canvas.width / 1280), 0)
    expect(moved.progress).toEqual(before.progress)
    await fields.getByRole('button', { name: /Line \/ curve|直线.*曲线/ }).click()
    await expect(page.getByTestId('path-0-outHandle')).toBeVisible()
    const curved = await position(page, id)
    if (curved.mode !== 'Path') throw new Error('Path lost during curve edit')
    expect(curved.path.nodes[0]!.segment).toBe('Cubic')
    expect(curved.path.nodes[1]!.inHandle).not.toEqual({ x: 0, y: 0 })
    const control = page.getByTestId('path-0-outHandle')
    const controlBox = (await control.boundingBox())!
    await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(controlBox.x + 20, controlBox.y - 20, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await position(page, id), 'Escape cancels the uncommitted handle edit').toEqual(curved)
    await page.screenshot({ path: test.info().outputPath('path-editor.png') })
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(moved)
    await fields.getByRole('button', { name: /Bake to XY|烘焙.*XY/ }).click()
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    await expect(page.getByTestId('conversion-error')).toBeVisible()
    expect(await position(page, id), 'preview never commits').toEqual(moved)
    await page.getByTestId('position-conversion').getByRole('button', { name: /Cancel|取消/ }).click()
    expect(await position(page, id)).toEqual(moved)
    await fields.getByRole('button', { name: /Bake to XY|烘焙.*XY/ }).click()
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    await page.getByRole('button', { name: /Apply conversion|应用转换/ }).click()
    await expect.poll(async () => (await position(page, id)).mode).toBe('XY')
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(moved)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(before)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(original)
    await fields.getByRole('button', { name: /Show trajectory|显示轨迹/ }).click()
    await expect(page.getByTestId('motion-path-overlay')).toBeVisible()
    expect(await position(page, id), 'trajectory display is not a conversion').toEqual(original)
    await fields.getByRole('button', { name: /Convert XY to path|XY.*路径/ }).click()
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    expect(await position(page, id)).toEqual(original)
    await page.getByRole('button', { name: /Apply conversion|应用转换/ }).click()
    await expect.poll(async () => (await position(page, id)).mode).toBe('Path')
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(original)
  } finally { await app.close() }
})
