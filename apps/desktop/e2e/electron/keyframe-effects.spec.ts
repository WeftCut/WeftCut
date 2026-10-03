import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import type { AnimTrack, EffectView, LayerSummary, TrackSummary } from '../../src/renderer/ipc'
import type { PositionAnimation } from '../../src/shared/position'
import { dockPanel, invokeCmd, launchApp, newProject, rootSummary, tmpDir, waitForHook } from './helpers/driver'

async function layerState(page: Page, id: string): Promise<LayerSummary> {
  const s = await rootSummary<{ tracks: TrackSummary[] }>(page)
  const layer = s.tracks.flatMap(t => t.layers).find(l => l.id === id)
  if (!layer) throw new Error(`Missing test layer ${id}`)
  return layer
}

function keys(track: AnimTrack<number> | undefined) {
  return track?.mode === 'Keyframed' ? track.value : []
}

async function capture(page: Page, name: string) {
  const cdp = await page.context().newCDPSession(page)
  try {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = test.info().outputPath(name)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    await test.info().attach(name, { path: file, contentType: 'image/png' })
  } finally { await cdp.detach() }
}

async function seek(page: Page, us: number) {
  // The hook is installed before async Pixi initialization registers the
  // transport. Seeking in that gap is a no-op, even though the timeline exists.
  await page.waitForFunction(() => (window as any).__weftcutTest?.previewResourceProbe?.() != null)
  await page.evaluate(us => (window as any).__weftcutTest.transportSeekUs(us), us)
  await expect.poll(() => page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs())).toBe(us)
}

test('visual effect keyframes: inspector, timeline editing, navigation, easing, drag and instance identity', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  try {
    // Match the compact desktop used by the hosted Windows runner.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720))
    await newProject(page, { parentFolder: tmpDir('weftcut-effect-channels-'), name: 'Effect channels',
      canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 } })
    const id = await invokeCmd<string>(page, 'add_text_layer', {
      tStartUs: 0, durationUs: 4_000_000, content: 'KEYFRAME CHANNELS',
    })
    await waitForHook(page, 'revealLayer')
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), id)
    await page.locator('.weft-dock-tab[data-panel-kind="effect"]').click()
    const panel = dockPanel(page, 'effect')
    const addBlur = async () => {
      await panel.getByTestId('effect-add').click()
      await page.getByTestId('effect-pick-blur').click()
    }
    await addBlur()
    await expect.poll(async () => (await layerState(page, id)).effects.length).toBe(1)
    const firstId = (await layerState(page, id)).effects[0]!.id
    const effect = async (effectId: string): Promise<EffectView | undefined> =>
      (await layerState(page, id)).effects.find(e => e.id === effectId)
    const firstKeys = async () => keys((await effect(firstId))?.params.strength)
    const field = panel.getByTestId(`effect-param-${firstId}-strength`)
    await seek(page, 0)
    await field.locator('.anim-stopwatch').click()
    await expect.poll(async () => (await firstKeys()).length).toBe(1)
    const twirl = page.locator('[data-testid="kf-lane-twirl"]:not([disabled])')
    await expect(twirl).toBeEnabled()
    await twirl.click()
    const rows = page.getByTestId('kf-sublane')
    await expect(rows).toHaveCount(1)
    await expect(page.getByText('Blur #1 · Strength', { exact: true })).toBeVisible()
    await capture(page, 'effect-inspector-and-lane.png')

    // The timeline number field authors the second key at the transport time.
    await seek(page, 1_000_000)
    // Panel readouts subscribe at 100 ms; wait for the row to observe the seek
    // before editing (the numeric value is still 8 on a one-key track).
    await expect(page.getByTestId('kf-nav-set')).toHaveAttribute('aria-pressed', 'false')
    const value = page.locator('.kf-value-row .app-number-input')
    await expect(value).toHaveValue('8')
    await value.fill('30')
    await value.press('Tab')
    await expect.poll(async () => (await firstKeys()).map(k => [k.t_us, k.value]))
      .toEqual([[0, 8], [1_000_000, 30]])
    await expect(field.getByRole('textbox')).toHaveValue('30')
    await page.getByTestId('kf-nav-prev').click()
    await expect(value).toHaveValue('8')
    await page.getByTestId('kf-nav-next').click()
    await expect(value).toHaveValue('30')
    await invokeCmd(page, 'project_undo')
    await expect.poll(async () => (await firstKeys()).length).toBe(1)
    await invokeCmd(page, 'project_redo')
    await expect.poll(async () => (await firstKeys()).length).toBe(2)

    const firstKeyId = (await firstKeys())[0]!.id
    const lastKeyId = (await firstKeys())[1]!.id
    const diamond = (keyId: string) => page.locator(`.kf-sublane-diamond[data-kf-id="${keyId}"]`)
    // At time zero the sticky header clips the diamond's left half. Use its
    // visible right half, as a user does, instead of Playwright's centre click.
    const clickFirst = async (button: 'left' | 'right' = 'left') => {
      // Raw mouse coordinates do not auto-scroll: on compact CI desktops the
      // expanded curve's low-value key can be below the timeline viewport.
      await diamond(firstKeyId).scrollIntoViewIfNeeded()
      const box = (await diamond(firstKeyId).boundingBox())!
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2, { button })
    }
    await clickFirst('right')
    await page.getByTestId('easing-cmd-hold').click()
    await expect.poll(async () => (await firstKeys())[0]?.segment.kind).toBe('Hold')
    await diamond(lastKeyId).scrollIntoViewIfNeeded()
    const box = (await diamond(lastKeyId).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await firstKeys()).find(k => k.id === lastKeyId)!.t_us).toBeGreaterThan(1_000_000)
    const preserved = (await effect(firstId))!.params.strength
    await capture(page, 'effect-curve-edited.png')

    // Another blur has its own address even when both kinds and param names match.
    await addBlur()
    await expect.poll(async () => (await layerState(page, id)).effects.length).toBe(2)
    const secondId = (await layerState(page, id)).effects[1]!.id
    await panel.getByTestId(`effect-param-${secondId}-strength`).locator('.anim-stopwatch').click()
    await expect(rows).toHaveCount(2)
    await expect(page.getByText('Blur #2 · Strength', { exact: true })).toBeVisible()
    await panel.getByTestId('effect-menu-1').click()
    await page.getByTestId('effect-up-1').click()
    await expect.poll(async () => (await layerState(page, id)).effects[0]!.id).toBe(secondId)
    expect((await effect(firstId))!.params.strength).toEqual(preserved)
    await panel.getByTestId('effect-menu-0').click()
    await page.getByTestId('effect-remove-0').click()
    await expect(rows).toHaveCount(1)
    expect((await effect(firstId))!.params.strength).toEqual(preserved)

    // Inspector visibility must not register/unregister timeline channels.
    await page.locator('.weft-dock-tab[data-panel-kind="attribute"]').click()
    await expect(rows).toHaveCount(1)
    await expect(diamond(firstKeyId)).toBeVisible()
    await clickFirst()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await firstKeys()).length).toBe(1)
    await invokeCmd(page, 'project_undo')
    await expect.poll(async () => (await firstKeys()).length).toBe(2)
    await capture(page, 'effect-lane-with-inspector-hidden.png')
    expect(errors).toEqual([])
  } catch (error) {
    await capture(page, 'failure.png').catch(() => {})
    throw error
  } finally { await app.close() }
})

test('path progress is discovered and editable as a timeline channel', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-progress-channel-'), name: 'Progress channel',
      canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 } })
    const id = await invokeCmd<string>(page, 'add_text_layer', {
      tStartUs: 0, durationUs: 3_000_000, content: 'PATH PROGRESS',
    })
    await waitForHook(page, 'revealLayer')
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), id)
    await page.getByTestId('position-fields').getByRole('button', { name: /^Path$/ }).click()
    const progress = page.getByTestId('position-fields').locator('.anim-field').filter({ hasText: /progress/i })
    // A mode switch preserves the static position. Explicitly animate progress
    // before asking the timeline to discover its channel.
    await seek(page, 0)
    await progress.locator('.anim-stopwatch').click()
    await page.locator('[data-testid="kf-lane-twirl"]:not([disabled])').click()
    await expect(page.getByTestId('kf-sublane')).toHaveCount(1)
    await seek(page, 1_000_000)
    await expect(page.getByTestId('kf-nav-set')).toHaveAttribute('aria-pressed', 'false')
    const value = page.locator('.kf-value-row .app-number-input')
    await value.fill('50')
    await value.press('Tab')
    await expect.poll(async () => {
      const params = (await layerState(page, id)).params as unknown as { position: PositionAnimation }
      return keys(params.position.mode === 'Path' ? params.position.progress : undefined).map(k => [k.t_us, k.value])
    }).toEqual([[0, 0], [1_000_000, 0.5]])
    await capture(page, 'path-progress-lane.png')
  } catch (error) {
    await capture(page, 'failure.png').catch(() => {})
    throw error
  } finally { await app.close() }
})
