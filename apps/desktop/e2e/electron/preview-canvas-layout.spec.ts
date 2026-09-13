import { expect, test, type Page } from '@playwright/test'

import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

type LayoutSnapshot = {
  surface: { x: number; y: number; width: number; height: number }
  canvas: { x: number; y: number; width: number; height: number }
  panelBackground: string
  previewBackground: string
  pixiHostBackground: string
}

async function layoutAt(
  page: Page,
  size: { width: number; height: number },
): Promise<LayoutSnapshot> {
  return page.evaluate(async ({ width, height }) => {
    const surface = document.querySelector<HTMLElement>('#video-surface')
    const preview = surface?.closest<HTMLElement>('.preview')
    const previewVideo = surface?.querySelector<HTMLElement>('.preview-video')
    const canvas = surface?.querySelector<HTMLCanvasElement>('.pixi-preview-canvas')
    const pixiHost = canvas?.parentElement
    if (!surface || !preview || !previewVideo || !canvas || !pixiHost) {
      throw new Error('preview layout did not mount')
    }

    Object.assign(surface.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: `${width}px`,
      height: `${height}px`,
      flex: 'none',
      zIndex: '10000',
    })

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )

    const surfaceRect = surface.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()

    return {
      surface: {
        x: surfaceRect.x,
        y: surfaceRect.y,
        width: surfaceRect.width,
        height: surfaceRect.height,
      },
      canvas: {
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height,
      },
      panelBackground: getComputedStyle(preview).backgroundColor,
      previewBackground: getComputedStyle(previewVideo).backgroundColor,
      pixiHostBackground: getComputedStyle(pixiHost).backgroundColor,
    }
  }, size)
}

test('preview panel owns both letterbox axes while the Pixi canvas stays centered', async () => {
  const launched = await launchApp()
  const { app, page } = launched
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-preview-layout-'),
      name: `e2e-preview-layout-${Date.now()}`,
      canvas: { width: 1600, height: 900, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(page, 'add_color_layer', {
      tStartUs: 0,
      durationUs: 1_000_000,
    })
    await expect(page.locator('.pixi-preview-canvas')).toBeVisible()
    await expect(page.getByTestId('pixi-preview-initializing')).toBeHidden()

    // Below a fit of 1 the canvas box is the buffer's own size in whole device
    // pixels, centred on the device grid (ADR 0071), so it may sit up to one
    // pixel off the ideal contain box on either axis and up to half a pixel
    // off centre.
    const withinOnePx = (actual: number, expected: number): void => {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)
    }

    const wide = await layoutAt(page, { width: 600, height: 240 })
    withinOnePx(wide.canvas.width, wide.surface.height * (16 / 9))
    withinOnePx(wide.canvas.height, wide.surface.height)
    withinOnePx(wide.canvas.x + wide.canvas.width / 2, wide.surface.x + wide.surface.width / 2)
    withinOnePx(wide.canvas.y + wide.canvas.height / 2, wide.surface.y + wide.surface.height / 2)

    const tall = await layoutAt(page, { width: 240, height: 500 })
    withinOnePx(tall.canvas.width, tall.surface.width)
    withinOnePx(tall.canvas.height, tall.surface.width / (16 / 9))
    withinOnePx(tall.canvas.x + tall.canvas.width / 2, tall.surface.x + tall.surface.width / 2)
    withinOnePx(tall.canvas.y + tall.canvas.height / 2, tall.surface.y + tall.surface.height / 2)

    expect(wide.panelBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(wide.previewBackground).toBe('rgba(0, 0, 0, 0)')
    expect(wide.pixiHostBackground).toBe('rgba(0, 0, 0, 0)')
  } finally {
    await app.close()
  }
})

test('the preview zooms about the pointer and pans with no tool armed', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-preview-zoom-'),
      name: `preview-zoom-${Date.now()}`,
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 1_000_000 })
    const canvas = page.locator('.pixi-preview-canvas')
    await expect(canvas).toBeVisible()
    await expect(page.getByTestId('pixi-preview-initializing')).toBeHidden()
    const beforeProject = await invokeCmd(page, 'project_summary', {})
    const box = async () => (await canvas.boundingBox())!
    const dpr = await page.evaluate(() => window.devicePixelRatio)
    const zoom = page.locator('.preview-zoom-select')

    // ── The readout is the control, exercised in the ordinary dock layout ──
    const pick = async (stop: RegExp) => {
      await zoom.click()
      await page.locator('.app-menu-item').filter({ hasText: stop }).click()
    }
    // Over the preview wherever the dock put it, so the wheel below lands on
    // the picture and not on a neighbouring panel.
    const overPreview = async () => {
      const s = (await page.locator('#video-surface').boundingBox())!
      await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    }
    await expect(zoom).toContainText('Fit')
    await pick(/^75%$/)
    await expect(zoom).toContainText('75%')
    // A notch off that stop: the readout now names a value its own menu does
    // not list.
    await overPreview()
    await page.mouse.wheel(0, -40)
    await expect(zoom).not.toContainText('75%')
    await expect(zoom).not.toContainText('Fit')
    // ...and back onto a listed one. The value the trigger was rendering from
    // leaves the list here — where a value-controlled Select fell back to its
    // first entry and threw the whole view back to Fit.
    await pick(/^100%$/)
    await expect(zoom).toContainText('100%')
    // 100 % is one composition pixel per DEVICE pixel. The panel's size has
    // nothing to do with it — the picture simply overflows the panel.
    await expect.poll(async () => (await box()).width).toBeCloseTo(1920 / dpr, 0)
    await page.screenshot({ path: test.info().outputPath('preview-zoom-toolbar.png') })
    await page.keyboard.press('Z')
    await expect(zoom).toContainText('Fit')

    // ── A fixed surface, so every number below is the composition's own ────
    const { surface } = await layoutAt(page, { width: 480, height: 270 })
    const cx = surface.x + surface.width / 2
    const cy = surface.y + surface.height / 2
    await expect.poll(async () => (await box()).width).toBeCloseTo(480, 0)

    // The wheel zooms with nothing armed and no mode to enter, and holds the
    // point under the pointer still: the same fraction of the picture stays
    // beneath it afterwards.
    const probeX = surface.x + 120
    const under = async () => {
      const frame = await box()
      return (probeX - frame.x) / frame.width
    }
    const beforeWheel = await under()
    await page.mouse.move(probeX, cy)
    await page.mouse.wheel(0, -240)
    await expect.poll(async () => (await box()).width).toBeGreaterThan(480)
    expect(await under()).toBeCloseTo(beforeWheel, 2)
    await expect(zoom).not.toContainText('Fit')

    // A trackpad pinch reaches the page as a ctrl-wheel whose deltas are an
    // order of magnitude smaller, so the same −20 that barely nudges a scroll
    // has to move the picture.
    await page.keyboard.press('Z')
    await expect.poll(async () => (await box()).width).toBeCloseTo(480, 0)
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, -20)
    const scrolled = (await box()).width
    await page.keyboard.press('Z')
    await expect.poll(async () => (await box()).width).toBeCloseTo(480, 0)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -20)
    await expect.poll(async () => (await box()).width).toBeGreaterThan(scrolled)
    const pinched = (await box()).width
    await page.mouse.wheel(0, -40)
    await page.keyboard.up('Control')
    await expect.poll(async () => (await box()).width).toBeGreaterThan(pinched)

    // ── The middle button pans, under the Selection tool ───────────────────
    const panned = await box()
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(cx + 40, cy + 30, { steps: 8 })
    await page.mouse.up({ button: 'middle' })
    await expect.poll(async () => (await box()).x).toBeCloseTo(panned.x + 40, 0)
    expect((await box()).y).toBeCloseTo(panned.y + 30, 0)

    // Zoom and pan are view state: the project is untouched by either.
    expect(await invokeCmd(page, 'project_summary', {})).toEqual(beforeProject)

    // ── The Hand tool remains the path for a pointer with no middle button ─
    // Clicked through the element: the fixed test surface can overlap the dock
    // strip, and the button's location is not part of this geometry.
    const run = (id: string) =>
      page.locator(`[data-quick-action="${id}"]`).evaluate((b: HTMLButtonElement) => b.click())
    await run('selectHandTool')
    await expect(page.getByTestId('preview-hand-tool')).toHaveCount(1)
    const handStart = await box()
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 30, cy - 20, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await box()).x).toBeCloseTo(handStart.x - 30, 0)

    // Capture continues outside the preview, and each axis stops with the
    // picture's edge on the panel's.
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(1000, 750, { steps: 8 })
    await page.mouse.up()
    // The origin is snapped to the ABSOLUTE device-pixel grid so the buffer
    // blits 1:1, so the picture stops on the grid point NEAREST the panel's
    // edge — half a device pixel short of it when the panel's own origin sits
    // on one, which is where a dock layout can legitimately put it. Device
    // pixels are also the only space this compares exactly in: a CSS box comes
    // back quantised, so under a fractional DPR it never divides back out.
    const onGrid = (v: number) => Math.round(v * dpr)
    const edge = await box()
    expect(onGrid(edge.x)).toBe(onGrid(surface.x))
    expect(onGrid(edge.y)).toBe(onGrid(surface.y))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('preview-hand-tool')).toHaveCount(0)

    // ── Z refits and recentres; zoom raises raster density, the knob caps it ─
    await page.keyboard.press('Z')
    await expect.poll(async () => (await box()).width).toBeCloseTo(480, 0)
    expect((await box()).x).toBeCloseTo(surface.x, 0)
    await page.mouse.move(cx, cy)
    for (let notch = 0; notch < 12; notch++) await page.mouse.wheel(0, -240)
    await expect.poll(() => canvas.evaluate(el => el.width)).toBe(1920)
    await run('cyclePlaybackResolution')
    await expect.poll(() => canvas.evaluate(el => el.width)).toBe(960)
  } finally {
    await app.close()
  }
})
