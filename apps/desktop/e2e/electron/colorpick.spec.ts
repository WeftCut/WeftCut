// Chromakey eyedropper closed loop: pick a BLUE canvas → keyR/G/B land as one
// batched write → ONE undo reverts all three. Blue (not green) because the
// chroma defaults ARE green — a green pick would assert nothing.
import { test, expect } from '@playwright/test'
import { launchApp, newProject, invokeCmd, summary, tmpDir, waitForHook } from './helpers/driver'

interface ParamTrack { mode: string; value?: number }
interface LayerLite { id: string; effects?: Array<{ id: string; params: Record<string, ParamTrack> }> }

function chromaParams(s: { tracks: Array<{ layers: LayerLite[] }> }, layerId: string): Record<string, ParamTrack> {
  for (const t of s.tracks) {
    for (const l of t.layers) {
      if (l.id === layerId) return l.effects?.[0]?.params ?? {}
    }
  }
  throw new Error(`layer ${layerId} not in summary`)
}

/// Warm-up: force a real Pixi render and read back the center pixel through the
/// existing e2e composite-sample bridge (same one effects-smoke.spec.ts uses),
/// polling until it reads solid blue. The picker's own captureFrame() renders
/// whatever the LIVE Compositor currently holds; add_color_layer/add_effect
/// land via an async project:changed → setProject round trip, so without this
/// wait the picker can freeze a stale (pre-mutation) frame and sample the
/// dark preview letterbox surround instead of the color layer.
async function waitForBlueComposite(page: import('@playwright/test').Page): Promise<void> {
  const deadline = Date.now() + 15_000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await page.evaluate(async () => {
      try {
        const w = window as any
        if (typeof w.__weftcutTest?.weftcutSeekUs !== 'function') return null
        w.__weftcutTest.weftcutSeekUs(500_000)
        return (await w.__weftcutTest.weftcutSampleComposite(320, 180)) as { r: number; g: number; b: number; a: number }
      } catch {
        return null
      }
    })
    if (r && r.r === 0 && r.g === 0 && r.b === 255 && r.a === 255) return
    if (Date.now() > deadline) throw new Error('composite never rendered the blue color layer (warmup failed)')
    await page.waitForTimeout(300)
  }
}

test('colorpick: chromakey eyedropper picks canvas blue; one undo reverts', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'needs a real-GL extract.pixels readback; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = tmpDir('weftcut-colorpick-')
  await newProject(page, {
    parentFolder: parent,
    name: 'colorpick',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  const layerId = await invokeCmd<string>(page, 'add_color_layer', {
    tStartUs: 0,
    durationUs: 2_000_000,
    color: { r: 0, g: 0, b: 255, a: 255 },
  })
  await invokeCmd<string>(page, 'add_effect', { layerId, kind: 'chromakey' })
  await waitForBlueComposite(page)

  // Select the layer so PropertyPanel mounts the effects section.
  await waitForHook(page, 'revealLayer')
  await page.evaluate(
    (id) => (window as unknown as { __weftcutTest: { revealLayer(a: { layerId: string }): void } }).__weftcutTest.revealLayer({ layerId: id }),
    layerId,
  )
  // Bring the Effect tab forward: the pristine baseline docks it inactive behind
  // Attribute (workspaceLayout.ts contextual group, activeView "attribute"), which
  // leaves effect-colorpick-0 rendered but visibility:hidden. Mirrors
  // effects-smoke.spec.ts.
  await page.locator('.weft-dock-tab-label', { hasText: 'Effect' }).click()
  const pickBtn = page.getByTestId('effect-colorpick-0')
  await pickBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await pickBtn.click()

  const overlay = page.getByTestId('colorpick-overlay')
  await overlay.waitFor({ state: 'visible', timeout: 15_000 })

  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('preview canvas not found')

  // Hover across the canvas first: live-apply must stay TRANSIENT — the
  // project's chromakey params record nothing until the click commits.
  //
  // Wait on the magnifier's hex readout, not on a fixed settle. The readout is
  // written in the same rAF pass that calls `onHover` (PickOverlayHost.tsx), so
  // it is the witness that a hover was actually SAMPLED. A sleep proves only
  // that time passed: on a loaded runner the moves might not have been
  // processed yet, and the assertion below would go green for exactly the
  // reason it must never mean.
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('colorpick-hex')).toHaveText(/^#[0-9a-f]{6}$/i, {
    timeout: 10_000,
  })
  const during = chromaParams(await summary(page), layerId)
  expect(during.keyB?.value).toBeUndefined()

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await overlay.waitFor({ state: 'hidden', timeout: 10_000 })

  const near = (v: number | undefined, want: number) => {
    expect(v).toBeDefined()
    expect(Math.abs((v as number) - want)).toBeLessThan(0.02)
  }
  // The batched write lands async after the overlay settles; poll the summary.
  await expect
    .poll(async () => chromaParams(await summary(page), layerId).keyB?.value, { timeout: 10_000 })
    .toBeDefined()
  let p = chromaParams(await summary(page), layerId)
  near(p.keyR?.value, 0)
  near(p.keyG?.value, 0)
  near(p.keyB?.value, 1)

  // ONE undo reverts all three (single batched entry). add_effect creates
  // params:{} and undo restores that snapshot verbatim, so the lazily-created
  // tracks deterministically vanish (src/main/state/mutations/effects.ts +
  // history.ts snapshot restore).
  await invokeCmd(page, 'project_undo', {})
  p = chromaParams(await summary(page), layerId)
  expect(p.keyR?.value).toBeUndefined()
  expect(p.keyG?.value).toBeUndefined()
  expect(p.keyB?.value).toBeUndefined()

  await app.close()
})

async function setupDesktopPick() {
  const { app, page } = await launchApp()
  await newProject(page, {
    parentFolder: tmpDir('weftcut-screen-pick-'), name: 'screen-pick',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })
  const layerId = await invokeCmd<string>(page, 'add_color_layer', {
    tStartUs: 0, durationUs: 2_000_000, color: { r: 0, g: 0, b: 255, a: 255 },
  })
  await invokeCmd(page, 'add_effect', { layerId, kind: 'chromakey' })
  await waitForBlueComposite(page)
  await waitForHook(page, 'revealLayer')
  await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId)
  await page.locator('.weft-dock-tab-label', { hasText: 'Effect' }).click()
  return { app, page, layerId, button: page.getByTestId('effect-colorpick-0') }
}

test('colorpick: desktop overlay commits once, undo restores, Escape cancels @serial', async ({}, info) => {
  test.skip(process.platform !== 'win32' || process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'real interactive Windows desktop capture; other platforms need their own capture/permission gate')
  test.setTimeout(120_000)
  const { app, page, layerId, button } = await setupDesktopPick()
  try {
    // Generated content covers each display so no private desktop content is
    // captured by this test. The editor still receives the CDP-driven gesture.
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      const fixtures = []
      for (const display of screen.getAllDisplays()) {
        const fixture = new BrowserWindow({ ...display.bounds, frame: false, show: false,
          skipTaskbar: true, backgroundColor: '#1234a0', webPreferences: { sandbox: true } })
        await fixture.loadURL('data:text/html,<style>body{margin:0;background:%231234a0}</style>')
        fixture.setAlwaysOnTop(true, 'pop-up-menu'); fixture.showInactive(); fixtures.push(fixture)
      }
      ;(globalThis as any).__screenPickFixtures = fixtures
    })
    // Wait for the OS compositor to finish presenting the fixture, including
    // native window fade-in. A DOM-ready window can still capture mid-animation.
    await expect.poll(() => app.evaluate(async ({ desktopCapturer, screen }) => {
      const d=screen.getPrimaryDisplay()
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{
        width:Math.round(d.bounds.width*d.scaleFactor),height:Math.round(d.bounds.height*d.scaleFactor)}})
      const image=sources.find(s=>s.display_id===String(d.id))!.thumbnail
      const i=(100*image.getSize().width+120)*4,b=image.toBitmap()
      return [b[i+2],b[i+1],b[i]]
    }), {timeout:10_000}).toEqual([18,52,160])
    await button.click()
    await expect(page.getByTestId('colorpick-overlay')).toBeVisible()
    await page.keyboard.press('s')
    await expect(page.getByTestId('colorpick-overlay')).toBeHidden()
    const visibleOverlays = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed() && w.webContents?.getURL().includes('/screen-pick.html') && w.isVisible()).length)
    await expect.poll(visibleOverlays, { timeout: 20_000 }).toBeGreaterThan(0)
    const desktop = app.windows().find(w => w.url().includes('/screen-pick.html'))!
    await desktop.mouse.move(120, 100)
    await expect(desktop.locator('#hex')).toHaveText('#1234a0')
    expect(await desktop.evaluate(() => typeof (window as any).api)).toBe('undefined')
    expect(chromaParams(await summary(page), layerId).keyB?.value).toBeUndefined()
    await desktop.screenshot({ path: info.outputPath('desktop-picker.png') })
    await desktop.mouse.click(120, 100)
    await expect.poll(visibleOverlays).toBe(0)
    // Authored effect parameters are quantized to three decimal places.
    await expect.poll(async () => chromaParams(await summary(page), layerId).keyB?.value).toBeCloseTo(160 / 255, 3)
    const picked = chromaParams(await summary(page), layerId)
    expect(picked.keyR?.value).toBeCloseTo(18 / 255, 3)
    expect(picked.keyG?.value).toBeCloseTo(52 / 255, 3)
    await invokeCmd(page, 'project_undo', {})
    expect(chromaParams(await summary(page), layerId)).toEqual({})

    await button.click()
    await expect(page.getByTestId('colorpick-overlay')).toBeVisible()
    await page.keyboard.press('s')
    await expect.poll(visibleOverlays, { timeout: 20_000 }).toBeGreaterThan(0)
    const second = app.windows().find(w => !w.isClosed() && w.url().includes('/screen-pick.html'))!
    await second.mouse.move(200, 180)
    await expect(second.locator('#hex')).toHaveText('#1234a0')
    // Escape destroys the overlay in main's before-input-event handler. Send
    // through Electron: CDP keyboard.press otherwise waits for keyup on a page
    // that has already been destroyed as the intended result of keydown.
    await app.evaluate(({ BrowserWindow }) => {
      const overlay=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed() && w.webContents?.getURL().includes('/screen-pick.html'))
      if (!overlay) throw new Error('No live desktop picker')
      overlay.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
    })
    await expect.poll(visibleOverlays).toBe(0)
    await expect(page.getByTestId('colorpick-overlay')).toBeHidden()
    expect(chromaParams(await summary(page), layerId)).toEqual({})
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('index.html'))).toBe(true)
  } finally { await app.close() }
})

test('colorpick: desktop capture failure returns to usable in-app picking @serial', async () => {
  test.skip(process.env.WEFTCUT_E2E_NO_EXPORT === '1', 'real preview pixel extraction')
  test.setTimeout(120_000)
  const { app, page, layerId, button } = await setupDesktopPick()
  try {
    await app.evaluate(({ desktopCapturer }) => {
      desktopCapturer.getSources = async () => { throw new Error('injected capture failure') }
    })
    await button.click()
    await expect(page.getByTestId('colorpick-overlay')).toBeVisible()
    await page.keyboard.press('s')
    await expect(page.getByTestId('colorpick-overlay').getByRole('alert')).toContainText('Could not capture the screen')
    await expect(page.getByTestId('colorpick-overlay')).toBeVisible()
    const box = await page.locator('canvas').first().boundingBox()
    if (!box) throw new Error('No preview canvas')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(async () => chromaParams(await summary(page), layerId).keyB?.value).toBe(1)
    await invokeCmd(page, 'project_undo', {})
    expect(chromaParams(await summary(page), layerId)).toEqual({})
  } finally { await app.close() }
})
