import { expect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { invokeCmd, launchApp, newProject, summary, tmpDir, waitForHook } from './helpers/driver'
import type { PositionAnimation } from '../../src/shared/position'

async function position(page: Page, id: string): Promise<PositionAnimation> {
  const s = await summary(page)
  const layer = s.tracks.flatMap(t => t.layers).find(l => l.id === id)!
  return (layer.params as unknown as { position: PositionAnimation }).position
}

// The position mode switcher's two segments. Exact names: "Path" would also
// match the "Edit path" button in the node well, and the segments are the only
// route to a conversion.
const toPath = (fields: Locator) => fields.getByRole('button', { name: /^(Path|路径)$/ })
const toXY = (fields: Locator) => fields.getByRole('button', { name: /^XY$/ })

test('motion path creation, point dragging, conversion preview/cancel/apply and undo', async () => {
  const { app, page } = await launchApp()
  try {
    // Exercise insertion with the compact preview used by hosted desktops.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1024, height: 768 }))
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-path-'), name: `path-${Date.now()}`, canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 } })
    const id = await invokeCmd<string>(page, 'add_text_layer', { tStartUs: 0, durationUs: 2_000_000, content: 'Motion path' })
    await waitForHook(page, 'revealLayer')
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), id)
    const fields = page.getByTestId('position-fields')
    await expect(fields).toBeVisible()
    const original = await position(page, id)
    // The mode switcher is the only entry to changing representation. Static
    // X/Y carry no timing to preserve, so it takes the instant branch here:
    // one stationary node in one undo, no conversion to fill in.
    await toPath(fields).click()
    await expect(page.getByTestId('position-conversion')).toHaveCount(0)
    await expect.poll(async () => (await position(page, id)).mode).toBe('Path')
    const created = await position(page, id)
    if (created.mode !== 'Path') throw new Error('Path not created')
    expect(created.path.nodes).toHaveLength(1)
    expect(created.progress).toEqual({ mode: 'Static', value: 0 })
    await expect(page.getByTestId('path-0-point')).toBeVisible()
    // Returning the single node to XY is exact, immediate and one undo.
    await toXY(fields).click()
    await expect.poll(() => position(page, id)).toEqual(original)
    await expect(page.getByTestId('position-conversion')).toHaveCount(0)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(created)
    await fields.getByRole('button', { name: /Edit path|编辑路径/ }).click()
    // Extending the route is an explicit action and does not animate it.
    await fields.getByRole('button', { name: /Add point|添加节点/ }).click()
    await expect.poll(async () => {
      const p = await position(page, id)
      return p.mode === 'Path' ? p.path.nodes.length : 0
    }).toBe(2)
    const before = await position(page, id)
    if (before.mode !== 'Path') throw new Error('Path not created')
    expect(before.progress).toEqual(created.progress)
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
    await expect(page.getByTestId('path-0-out_handle')).toBeVisible()
    const curved = await position(page, id)
    if (curved.mode !== 'Path') throw new Error('Path lost during curve edit')
    expect(curved.path.nodes[0]!.segment).toBe('Cubic')
    expect(curved.path.nodes[1]!.in_handle).not.toEqual({ x: 0, y: 0 })
    const control = page.getByTestId('path-0-out_handle')
    const controlBox = (await control.boundingBox())!
    await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(controlBox.x + 20, controlBox.y - 20, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await position(page, id), 'Escape cancels the uncommitted handle edit').toEqual(curved)
    const pathHit = page.getByTestId('path-insert-hit')
    const curvedRoute = await pathHit.getAttribute('d')
    await fields.getByRole('group', { name: /Spatial node|空间节点/ })
      .getByRole('button', { name: /Auto smooth|自动平滑/ }).click()
    await expect.poll(async () => {
      const p = await position(page, id)
      return p.mode === 'Path' ? p.path.nodes[0]!.tangent_mode : ''
    }).toBe('Auto')
    const auto = await position(page, id)
    // The actor summary can arrive before React paints the solved Auto curve.
    // Wait for that geometry, then choose a point clear of the node/handle
    // hit targets (which occupy a larger fraction of a compact CI preview).
    await expect(pathHit).not.toHaveAttribute('d', curvedRoute!)
    await expect(pathHit).toBeVisible()
    const location = await pathHit.evaluate(el => {
      const path = el as SVGPathElement
      for (const fraction of [0.5, 0.25, 0.75, 0.4, 0.6, 0.2, 0.8]) {
        const p = path.getPointAtLength(path.getTotalLength() * fraction)
        const client = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!)
        if (document.elementFromPoint(client.x, client.y) === path) {
          return { x: client.x, y: client.y }
        }
      }
      throw new Error('Motion path has no exposed insertion target')
    })
    await page.mouse.dblclick(location.x, location.y)
    await expect.poll(async () => {
      const p = await position(page, id)
      return p.mode === 'Path' ? p.path.nodes.length : 0
    }).toBe(3)
    const inserted = await position(page, id)
    if (inserted.mode !== 'Path' || auto.mode !== 'Path') throw new Error('Path lost during insertion')
    expect(inserted.progress).toEqual(auto.progress)
    expect(inserted.path.nodes[0]!.tangent_mode).toBe('Smooth')
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(auto)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(curved)
    await page.screenshot({ path: test.info().outputPath('path-editor.png') })
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(moved)
    // Leaving a multi-node path bakes: the switcher opens the conversion rather than
    // dropping the geometry.
    await toXY(fields).click()
    await expect(page.getByTestId('position-conversion')).toBeVisible()
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    await expect(page.getByTestId('conversion-error')).toBeVisible()
    expect(await position(page, id), 'preview never commits').toEqual(moved)
    await page.getByTestId('position-conversion').getByRole('button', { name: /Cancel|取消/ }).click()
    expect(await position(page, id)).toEqual(moved)
    await toXY(fields).click()
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    await page.getByRole('button', { name: /Apply conversion|应用转换/ }).click()
    await expect.poll(async () => (await position(page, id)).mode).toBe('XY')
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(moved)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(before)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(created)
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(() => position(page, id)).toEqual(original)
    // An XY position draws no trajectory until asked, so this toggle is the
    // only way to see the motion on canvas — and asking is not an edit.
    await expect(page.getByTestId('motion-path-overlay')).toHaveCount(0)
    await fields.getByRole('button', { name: /Show trajectory|显示轨迹/ }).click()
    await expect(page.getByTestId('motion-path-overlay')).toBeVisible()
    expect(await position(page, id), 'trajectory display is not a conversion').toEqual(original)
  } finally { await app.close() }
})

test('conversion refuses missed quality targets and jumping positions without changing state', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-e2e-path-quality-'), name: `quality-${Date.now()}`, canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 } })
    const id = await invokeCmd<string>(page, 'add_text_layer', { tStartUs: 0, durationUs: 2_000_000, content: 'Quality guard' })
    const source: PositionAnimation = {
      mode: 'XY', y: { mode: 'Static', value: 360 }, x: {
        mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' },
        value: [0, 1].map(i => ({ id: randomUUID(), t_us: i * 33333, value: 300 + i * 600,
          in: { x: 0.95, y: 1, mode: 'Free' }, out: { x: 0.9, y: 0, mode: 'Free' },
          continuity: 'Broken', segment: { kind: 'Spline' } })),
      },
    }
    await invokeCmd(page, 'set_position', { layerId: id, position: source })
    const applied = await position(page, id)
    await waitForHook(page, 'revealLayer')
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), id)
    const fields = page.getByTestId('position-fields')
    // Keyframed X/Y take the switcher's fitted branch: it opens the conversion
    // instead of building a path, because there is timing to preserve.
    await toPath(fields).click()
    await expect(page.getByTestId('position-conversion')).toBeVisible()
    expect(await position(page, id), 'opening a conversion commits nothing').toEqual(applied)
    await page.getByLabel(/End frame|结束帧/).fill('1')
    await page.getByLabel(/Target error|目标误差/).fill('0.05')
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    await expect(page.getByTestId('position-conversion').getByRole('alert')).toContainText(/frame grid|帧网格/)
    await expect(page.getByRole('button', { name: /Apply conversion|应用转换/ })).toBeDisabled()
    expect(await position(page, id)).toEqual(applied)
    await page.getByTestId('position-conversion').getByRole('button', { name: /Cancel|取消/ }).click()
    if (source.x.mode !== 'Keyframed') throw new Error('test setup')
    source.x.value[0]!.segment = { kind: 'Hold' }
    await invokeCmd(page, 'set_position', { layerId: id, position: source })
    const jumping = await position(page, id)
    await toPath(fields).click()
    await page.getByRole('button', { name: /Preview conversion|预览转换/ }).click()
    await expect(page.getByTestId('position-conversion').getByRole('alert')).toContainText(/instantaneous position jump|瞬间位置跳变/)
    await expect(page.getByRole('button', { name: /Apply conversion|应用转换/ })).toBeDisabled()
    expect(await position(page, id)).toEqual(jumping)
  } finally { await app.close() }
})
