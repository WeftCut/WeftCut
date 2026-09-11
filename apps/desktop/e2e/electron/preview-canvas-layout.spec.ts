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
