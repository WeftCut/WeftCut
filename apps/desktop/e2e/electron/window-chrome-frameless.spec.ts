import { test, expect, type ElectronApplication, type Page } from '@playwright/test'

import { launchApp } from './helpers/driver'

// The frameless main window off macOS (`frame: false`, src/main/index.ts). The
// OS draws nothing, so the renderer supplies the caption: a drag region (the
// preload bridges `data-drag-region` to `-webkit-app-region`, with interactive
// descendants opted back out), Windows-styled caption buttons, and a 1px inset
// edge on <html>::after (base.css). Chromium rounds frameless windows at 8px on
// Linux and Windows 11, so the edge carries the same radius — a square hairline
// reads as cut corners. Nothing here needs a GPU or media, so it runs on the
// xvfb leg; the maximize half is skipped where no window manager honors it.

const isDarwin = process.platform === 'darwin'

/// The startup screen's title strip — the surface on show at launch.
const TITLEBAR = '.startup-titlebar'

const isMaximized = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())

/// `-webkit-app-region` as Chromium resolves it for an element: 'drag',
/// 'no-drag', or 'none'. Read through the standard alias first.
function appRegion(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return `missing:${sel}`
    const cs = getComputedStyle(el)
    return cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region')
  }, selector)
}

interface EdgeStyle {
  display: string
  borderRadius: string
  content: string
}

/// The self-drawn window edge is <html>::after; its display flips off while
/// the window is maximized/fullscreen (the OS squares the window there).
function edgeStyle(page: Page): Promise<EdgeStyle> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement, '::after')
    return { display: cs.display, borderRadius: cs.borderRadius, content: cs.content }
  })
}

const htmlHasClass = (page: Page, cls: string): Promise<boolean> =>
  page.evaluate((c) => document.documentElement.classList.contains(c), cls)

test.describe('frameless window chrome (Windows/Linux)', () => {
  test.skip(isDarwin, 'macOS keeps the native frame and traffic lights; see window-chrome.spec.ts')

  test('the caption strip is a drag region and its buttons opt out', async () => {
    const { app, page } = await launchApp()
    try {
      await expect(page.locator(TITLEBAR)).toBeVisible()
      expect(await appRegion(page, TITLEBAR)).toBe('drag')
      // Any button inside the strip must be clickable, i.e. subtracted from the
      // drag rect list the browser process hands to the OS.
      expect(await appRegion(page, `${TITLEBAR} button`)).toBe('no-drag')
    } finally {
      await app.close()
    }
  })

  test('the inset edge is drawn with the frameless 8px corner radius', async () => {
    const { app, page } = await launchApp()
    try {
      await expect.poll(() => htmlHasClass(page, 'app-window-framed')).toBe(true)
      const edge = await edgeStyle(page)
      expect(edge.content).not.toBe('none')
      expect(edge.display).not.toBe('none')
      expect(edge.borderRadius).toBe('8px')
    } finally {
      await app.close()
    }
  })

  test('maximizing squares the window: the edge hides and restore brings it back', async () => {
    const { app, page } = await launchApp()
    try {
      await expect.poll(() => htmlHasClass(page, 'app-window-framed')).toBe(true)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize())
      // Maximize is a window-manager operation: a real WM applies it a few
      // frames later, and bare xvfb runs without one, so the request can be a
      // no-op there. Wait briefly, then skip rather than assert a state the
      // platform never entered (same guard as window-geometry.spec.ts).
      const honored = await expect
        .poll(() => isMaximized(app), { timeout: 3_000 })
        .toBe(true)
        .then(() => true, () => false)
      test.skip(!honored, 'window manager did not honor maximize()')

      await expect.poll(() => htmlHasClass(page, 'app-window-maximized')).toBe(true)
      expect((await edgeStyle(page)).display).toBe('none')

      // Restore through the bridge the caption button uses (WindowControls →
      // window.toggleMaximize); it must round-trip via main's maximize-changed
      // broadcast back into the <html> class and the edge.
      await page.evaluate(() =>
        (window as unknown as { api: { window: { toggleMaximize(): Promise<void> } } }).api.window.toggleMaximize(),
      )
      await expect.poll(() => isMaximized(app)).toBe(false)
      await expect.poll(() => htmlHasClass(page, 'app-window-maximized')).toBe(false)
      const edge = await edgeStyle(page)
      expect(edge.display).not.toBe('none')
      expect(edge.borderRadius).toBe('8px')
    } finally {
      await app.close()
    }
  })
})
