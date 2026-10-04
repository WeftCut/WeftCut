import { expect, test } from '@playwright/test'
import { invokeCmd, launchApp, newProject, rootSummary, tmpDir } from './helpers/driver'

test('link badges stay outside the sticky header column when horizontally scrolled', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-link-header-'), name: 'link-header',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })
    await expect(page.locator('.splash-screen')).toHaveCount(0)
    const { tracks } = await rootSummary<{ tracks: Array<{ id: string; role: string | null }> }>(page)
    const topTrack = tracks.find(track => track.role === 'b-roll')!
    const anchor = await invokeCmd<string>(page, 'add_color_layer', {
      trackId: topTrack.id, tStartUs: 0, durationUs: 10_000_000,
    })
    const hidden = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 0, durationUs: 10_000_000,
    })
    await invokeCmd(page, 'links_create', { layerIds: [anchor, hidden] })
    const badge = page.getByTestId('link-hidden-badge')
    await expect(badge).toHaveText('+1')
    const viewport = page.getByTestId('timeline-track-viewport')
    await viewport.evaluate(el => { el.scrollLeft = 80 })
    await expect.poll(() => viewport.evaluate(el => el.scrollLeft)).toBe(80)
    // The badge's box moves behind the header, but its paint and pointer
    // target must be covered even in the reserved space above the first row.
    const covered = await badge.evaluate(el => {
      const box = el.getBoundingClientRect()
      const header = document.querySelector('[data-testid="track-header"]')!.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      return {
        insideHeaderColumn: x > header.left && x < header.right,
        badgeHit: !!document.elementFromPoint(x, y)?.closest('[data-testid="link-tab-anchor"]'),
      }
    })
    await page.getByTestId('timeline-layout').screenshot({ path: test.info().outputPath('link-header.png') })
    expect(covered).toEqual({ insideHeaderColumn: true, badgeHit: false })

    // Preserve the upward tab and its reveal action in the time area.
    await viewport.evaluate(el => { el.scrollLeft = 0 })
    const box = (await badge.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.locator(`.timeline-layer[data-layer-id="${hidden}"]`)).toBeVisible()
    await expect(badge).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('playhead stays continuous from the ruler through fixed rows to the tracks', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-playhead-layout-'), name: 'playhead-layout',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })
    await expect(page.locator('.splash-screen')).toHaveCount(0)
    await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 10_000_000 })
    await page.locator('button[data-quick-action="toggleDisplayMode"]').click()
    for (let i = 0; i < 3; i++) {
      await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 10_000_000 })
    }
    const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!
    await page.mouse.click(ruler.x + 100, ruler.y + 10)

    // One painted line means gradients, glow and frame shading cannot restart
    // at row boundaries. Check its real geometry rather than individual rows.
    await expect(page.locator('[data-testid$="playhead"]')).toHaveCount(1)
    const continuity = () => page.getByTestId('timeline-layout').evaluate(layout => {
      const line = layout.querySelector('[data-testid="timeline-playhead"]')!.getBoundingClientRect()
      const ruler = layout.querySelector('[data-testid="timeline-ruler"]')!.getBoundingClientRect()
      const viewport = layout.querySelector('[data-testid="timeline-track-viewport"]')!.getBoundingClientRect()
      return Math.max(Math.abs(line.top - ruler.top), Math.abs(line.bottom - viewport.bottom))
    })
    const expectContinuous = async () => {
      await expect.poll(continuity).toBeLessThan(0.1)
    }
    await expectContinuous()
    await page.locator('button[data-quick-action="toggleMarkersVisible"]').click()
    await expect(page.getByTestId('timeline-marker-lane')).toHaveCount(0)
    await expectContinuous()
    await page.locator('button[data-quick-action="toggleMarkersVisible"]').click()
    await expect(page.getByTestId('timeline-marker-lane')).toBeVisible()
    await expectContinuous()

    // Position follows the time axis while vertical track scrolling leaves it fixed.
    await page.mouse.click(ruler.x + 200, ruler.y + 10)
    await expect.poll(async () => (await page.getByTestId('timeline-playhead').boundingBox())!.x).toBeGreaterThan(ruler.x + 150)
    await expectContinuous()
    const headX = (await page.getByTestId('timeline-playhead').boundingBox())!.x
    const scroll = await page.getByTestId('timeline-track-viewport').evaluate(el => {
      el.scrollLeft = 80; el.scrollTop = 30
      return { left: el.scrollLeft, top: el.scrollTop }
    })
    expect(scroll.left).toBeGreaterThan(0)
    expect(scroll.top).toBeGreaterThan(0)
    await expect.poll(async () => (await page.getByTestId('timeline-playhead').boundingBox())!.x).toBeCloseTo(headX - scroll.left, 0)
    await expectContinuous()
    await page.getByTestId('timeline-layout').screenshot({ path: test.info().outputPath('playhead-continuity.png') })
  } finally {
    await app.close()
  }
})

test('track resize handles cannot cover the ruler after vertical scrolling', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-timeline-layout-'), name: 'layout',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })
    await expect(page.locator('.splash-screen')).toHaveCount(0)
    await page.locator('button[data-quick-action="toggleDisplayMode"]').click()
    for (let i = 0; i < 12; i++) {
      await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 10_000_000 })
    }
    await expect.poll(() => page.getByTestId('track-lane').count()).toBeGreaterThanOrEqual(12)
    const hit = await page.evaluate(async () => {
      const ruler = document.querySelector<HTMLElement>('[data-testid="timeline-ruler"]')!
      const lane = document.querySelector<HTMLElement>('[data-testid="track-lane"]')!
      let viewport = lane.parentElement!
      while (getComputedStyle(viewport).overflowY !== 'auto') viewport = viewport.parentElement!
      const rulerRect = ruler.getBoundingClientRect()
      // Put the first row's splitter exactly over the ruler in the old layout.
      viewport.scrollTop += lane.getBoundingClientRect().bottom - (rulerRect.top + 10)
      await new Promise(requestAnimationFrame)
      const target = document.elementFromPoint(rulerRect.left + 100, rulerRect.top + 10)
      return { ruler: !!target?.closest('[data-testid="timeline-ruler"]'), cursor: target && getComputedStyle(target).cursor }
    })
    expect(hit).toEqual({ ruler: true, cursor: 'ew-resize' })

    const viewport = page.getByTestId('timeline-track-viewport')
    const chrome = ['timeline-ruler', 'timeline-marker-lane', 'timeline-drop-strip']
    for (const id of chrome) {
      const hitOwnSurface = await page.getByTestId(id).evaluate(async (surface, id) => {
        const viewport = document.querySelector<HTMLElement>('[data-testid="timeline-track-viewport"]')!
        const lane = document.querySelector<HTMLElement>('[data-testid="track-lane"]')!
        const rect = surface.getBoundingClientRect()
        const y = rect.top + rect.height / 2
        viewport.scrollTop += lane.getBoundingClientRect().bottom - y
        await new Promise(requestAnimationFrame)
        return !!document.elementFromPoint(rect.left + 100, y)?.closest(`[data-testid="${id}"]`)
      }, id)
      expect(hitOwnSurface, `${id} must own its hit area`).toBe(true)
    }
    await viewport.evaluate(el => { el.scrollTop = 0 })
    const before = await Promise.all(chrome.map(id => page.getByTestId(id).boundingBox()))
    const lane = page.getByTestId('track-lane').first()
    const laneBefore = (await lane.boundingBox())!
    const handle = (await page.getByTestId('track-height-handle').first().boundingBox())!
    await page.mouse.move(handle.x + 100, handle.y + 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 100, handle.y + 20)
    await expect.poll(async () => (await lane.boundingBox())!.height).toBeCloseTo(laneBefore.height + 18, 0)
    // Height edits cannot move fixed rows or spread the resize cursor to them.
    expect(await Promise.all(chrome.map(id => page.getByTestId(id).boundingBox()))).toEqual(before)
    for (const id of chrome) {
      expect(await page.getByTestId(id).evaluate(el => getComputedStyle(el).cursor)).not.toBe('ns-resize')
    }
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect.poll(async () => (await lane.boundingBox())!.height).toBe(laneBefore.height)

    // All time surfaces share x while headers stay fixed. The store fan-out
    // settles on the next animation frame without a track-tree render.
    const headerX = (await page.getByTestId('track-header').first().boundingBox())!.x
    await viewport.evaluate(el => { el.scrollLeft = 160; el.scrollTop = 90 })
    await expect.poll(async () => {
      const boxes = await Promise.all(chrome.map(id => page.getByTestId(id).boundingBox()))
      const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!
      return Math.max(...boxes.map(b => Math.abs(b!.x - canvas.x)))
    }).toBeLessThan(0.1)
    expect((await page.getByTestId('track-header').first().boundingBox())!.x).toBe(headerX)
    expect((await Promise.all(chrome.map(id => page.getByTestId(id).boundingBox()))).map(b => b!.y)).toEqual(before.map(b => b!.y))

    // The marker row collapses as a pair without entering the track scroll.
    const top = (await viewport.boundingBox())!.y
    await page.locator('button[data-quick-action="toggleMarkersVisible"]').click()
    await expect(page.getByTestId('timeline-marker-lane')).toHaveCount(0)
    await expect(page.getByTestId('timeline-marker-lane-header')).toHaveCount(0)
    await expect.poll(async () => (await viewport.boundingBox())!.y).toBe(top - before[1]!.height)
    await page.locator('button[data-quick-action="toggleMarkersVisible"]').click()
    await expect(page.getByTestId('timeline-marker-lane')).toBeVisible()
    await viewport.evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0 })
    await page.getByTestId('timeline-layout').screenshot({ path: test.info().outputPath('timeline-layout.png') })
  } finally {
    await app.close()
  }
})
