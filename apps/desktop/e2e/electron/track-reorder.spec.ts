import { expect, test, type Page } from '@playwright/test'
import { invokeCmd, launchApp, newProject, rootSummary, tmpDir } from './helpers/driver'

interface Summary {
  history: { len: number }
  tracks: Array<{ id: string; role: string | null; label: string | null; layers: Array<{ id: string; t_start_us: number; t_end_us: number }> }>
}
const summary = (page: Page) => rootSummary<Summary>(page)
const row = (page: Page, id: string) => page.locator(`[data-testid="timeline-track-row"][data-track-id="${id}"]`)
const toggle = (page: Page) => page.locator('button[data-quick-action="toggleDisplayMode"]')

test('All Tracks reorders a whole populated track between A/B, with menu, cancellation and one-step undo', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      if (win.isMaximized()) win.unmaximize()
      win.setBounds({ x: 0, y: 0, width: 1440, height: 1000 })
    })
    await newProject(page, { parentFolder: tmpDir('weftcut-track-reorder-'), name: 'track-order', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await expect(page.locator('.splash-screen')).toHaveCount(0)
    const clip = await invokeCmd<string>(page, 'add_color_layer', { tStartUs: 0, durationUs: 2_000_000 })
    const initial = await summary(page)
    const id = initial.tracks.find((track) => track.layers.some((layer) => layer.id === clip))!.id
    await invokeCmd(page, 'rename_track', { trackId: id, label: 'Overlays' })
    await invokeCmd(page, 'add_color_layer', { trackId: id, tStartUs: 10_000_000, durationUs: 2_000_000 })
    await expect(page.getByTestId('track-reorder-grip')).toHaveCount(0)
    await toggle(page).click()
    const before = await summary(page)
    const a = before.tracks.find((track) => track.role === 'a-roll')!
    const b = before.tracks.find((track) => track.role === 'b-roll')!
    await expect(row(page, a.id).getByTestId('track-reorder-grip')).toBeDisabled()
    const grip = row(page, id).getByTestId('track-reorder-grip')
    await expect(grip).toBeEnabled()
    const source = (await grip.boundingBox())!
    const target = (await row(page, a.id).boundingBox())!
    const x = source.x + source.width / 2
    await page.mouse.move(x, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, target.y + 3, { steps: 12 })
    await expect(row(page, id)).toHaveAttribute('data-reordering', 'true')
    await expect(page.getByTestId('track-reorder-indicator')).toBeVisible()
    await page.getByTestId('timeline-layout').screenshot({ path: testInfo.outputPath('track-insertion.png') })
    expect((await summary(page)).history.len).toBe(before.history.len)
    await page.mouse.up()
    await expect.poll(async () => (await summary(page)).tracks.map((track) => track.id)).toEqual([a.id, id, b.id])
    const after = await summary(page)
    expect(after.tracks.find((track) => track.id === id)).toEqual(before.tracks.find((track) => track.id === id))
    expect(after.history.len).toBe(before.history.len + 1)
    await invokeCmd(page, 'project_undo')
    await expect.poll(async () => (await summary(page)).tracks).toEqual(before.tracks)
    await invokeCmd(page, 'project_redo')
    await expect.poll(async () => (await summary(page)).tracks).toEqual(after.tracks)

    // Menu is the precise equivalent, with no changed clip timing or track id.
    await row(page, id).getByTestId('track-header').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move track to bottom', exact: true }).click()
    await expect.poll(async () => (await summary(page)).tracks[0]!.id).toBe(id)
    const bottom = await summary(page)
    await expect(row(page, id)).toBeInViewport()
    const from = (await grip.boundingBox())!
    const top = (await row(page, b.id).boundingBox())!
    await page.mouse.move(x, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, top.y + 2, { steps: 10 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect((await summary(page)).tracks).toEqual(bottom.tracks)
    expect((await summary(page)).history.len).toBe(bottom.history.len)

    await toggle(page).click()
    await expect(page.getByTestId('track-reorder-grip')).toHaveCount(0)
    await row(page, a.id).getByTestId('track-header').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move track up', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await toggle(page).click()
    await expect(page.getByTestId('timeline-track-row').last()).toHaveAttribute('data-track-id', id)
    await page.getByTestId('timeline-layout').screenshot({ path: testInfo.outputPath('track-reordered.png') })
  } finally { await app.close() }
})

test('Move to a new track reveals the new row without losing selection or the horizontal window', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-track-reveal-'), name: 'track-reveal', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await expect(page.locator('.splash-screen')).toHaveCount(0)
    const clip = await invokeCmd<string>(page, 'add_color_layer', { tStartUs: 0, durationUs: 30_000_000 })
    const id = (await summary(page)).tracks.find((track) => track.layers.some((layer) => layer.id === clip))!.id
    // Keep the source populated, so this also checks the split-off workflow.
    await invokeCmd(page, 'add_color_layer', { trackId: id, tStartUs: 40_000_000, durationUs: 2_000_000 })
    for (let i = 0; i < 10; i++) await invokeCmd(page, 'add_track', { label: `Row ${i}` })
    await toggle(page).click()
    const viewport = page.getByTestId('timeline-track-viewport')
    await row(page, id).getByTestId('track-header').scrollIntoViewIfNeeded()
    const left = await viewport.evaluate(el => { el.scrollLeft = 80; return el.scrollLeft })
    expect(left).toBeGreaterThan(0)
    expect(await viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    // Let the deliberate scroll finish publishing before opening a menu whose
    // contract is to close when its viewport scrolls.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const sourceBox = (await row(page, id).getByTestId('track-header').boundingBox())!
    // A real right click in the visible part of the long clip. Locator.click
    // would first scroll the clip's offscreen left edge into view.
    await page.mouse.click(sourceBox.x + sourceBox.width + 100, sourceBox.y + 20, { button: 'right' })
    expect(await viewport.evaluate(el => el.scrollLeft)).toBe(left)
    await page.getByRole('menuitem', { name: 'Move to a new track', exact: true }).click()
    await expect.poll(async () => (await summary(page)).tracks.at(-1)!.layers.some((layer) => layer.id === clip)).toBe(true)
    const newTrack = (await summary(page)).tracks.at(-1)!
    expect(newTrack.id).not.toBe(id)
    await expect(row(page, newTrack.id).getByTestId('track-header')).toBeInViewport()
    expect(await viewport.evaluate(el => el.scrollLeft)).toBe(left)
    expect((await summary(page)).tracks.find((track) => track.id === id)!.layers).toHaveLength(1)
    await expect(row(page, newTrack.id).locator(`[data-layer-id="${clip}"]`).first()).toHaveClass(/outline-ring/)

    // Complete the create-then-reorder workflow through a long scrolling list.
    // Holding the pointer still at the bottom must keep revealing more rows.
    const grip = (await row(page, newTrack.id).getByTestId('track-reorder-grip').boundingBox())!
    const bounds = (await viewport.boundingBox())!
    const x = grip.x + grip.width / 2
    await page.mouse.move(x, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, bounds.y + bounds.height - 2, { steps: 8 })
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(200)
    await expect.poll(() => viewport.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(2)
    await page.mouse.up()
    await expect.poll(async () => (await summary(page)).tracks[0]!.id).toBe(newTrack.id)
    expect(await viewport.evaluate(el => el.scrollLeft)).toBe(left)
  } finally { await app.close() }
})
