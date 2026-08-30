import { expect, test, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { invokeCmd, launchApp, newProject, tmpDir, waitForHook, rootSummary } from './helpers/driver'

/**
 * Markers painted in the timeline's marker lane, and the one switch that
 * silences them.
 *
 * Everything here is unreachable from the colocated Vitest suites, which mock the
 * IPC surface and render the lane in isolation: the assertions below are about
 * the REAL wiring — a marker created OUTSIDE the renderer reaching the lane's
 * own store selector, and one app-level setting reaching the strip button, the
 * View menu checkbox and the marker layer at once.
 *
 * The visibility test seeds its markers over MCP — no longer the only path
 * (the authoring slice gave `add_marker` a renderer channel and `M` a human
 * hand on it; the second test below drives those), but still the AGENT path,
 * which is the upstream that test is about: two hundred shot markers arriving
 * from outside are exactly what the toggle exists to silence. The connection
 * details come from the same `get_mcp_info` IPC the Settings → Agent tab
 * reads, so this can boot through `launchApp` like every other UI spec
 * instead of parsing the connect log.
 *
 * The third test drives the lane's own gesture — the drag — which no unit test
 * can reach the far side of: whether a press that travels across this row also
 * moves the PLAYHEAD is a question about two live surfaces sharing one window,
 * and the colocated suite renders the lane with no ruler beside it.
 *
 * Cross-restart persistence is deliberately NOT here — it is asserted in the
 * main-process app-settings suite, because every spec in this suite boots
 * Electron.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

/// An MCP client on this app's own loopback server, as an agent would connect.
async function mcpClient(page: Page): Promise<Client> {
  const info = await page.evaluate(
    () =>
      (window as any).api.mcp.getInfo() as Promise<{
        url: string
        bearer_token: string
      } | null>,
  )
  if (!info) throw new Error('MCP server not up')
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  })
  const client = new Client({ name: 'e2e-timeline-markers', version: '0.0.0' })
  await client.connect(transport)
  return client
}

test('the lane paints markers, and one toggle silences them from either surface', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-markers-')
    await newProject(page, { parentFolder: parent, name: 'timeline-markers', canvas: CANVAS })
    // REQUIRED before any pointer gesture: the splash overlay outlives the
    // first dock render and swallows mousedown while the target is visible.
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    const marks = page.locator('[data-testid="timeline-marker"]')
    const markerLane = page.locator('[data-testid="timeline-marker-lane"]')
    const markerLayer = page.locator('[data-testid="timeline-marker-layer"]')
    const labels = page.locator('[data-testid="timeline-marker-label"]')
    const stripButton = page.locator('button[data-quick-action="toggleMarkersVisible"]')
    const viewMenu = page.locator('.menu-trigger').nth(2)
    const showMarkersItem = page
      .locator('.app-menu-item')
      .filter({ hasText: /^Show markers$/ })

    // ── Seed a point and a region, from outside the app ───────────────────
    // The lane holds its row before anything is in it: it is a permanent row,
    // not one that appears with the first marker.
    await expect(markerLane).toHaveCount(1)
    await expect(marks).toHaveCount(0)
    // Frame-grid times at 30 fps (ADR 0037 rejects an off-grid marker). Two
    // different authored colours, because the colour IS the content here — a
    // taxonomy an agent applied is the thing the lane has to make legible.
    const client = await mcpClient(page)
    try {
      await client.callTool({
        name: 'add_marker',
        arguments: {
          t_us: 1_000_000,
          label: 'cut here',
          color: { r: 255, g: 136, b: 0, a: 255 },
        },
      })
      await client.callTool({
        name: 'add_marker',
        arguments: {
          t_us: 2_000_000,
          end_t_us: 3_000_000,
          label: 'needs VO',
          color: { r: 34, g: 204, b: 85, a: 255 },
        },
      })
    } finally {
      await client.close()
    }

    // Both appear with no project reload and no user action: the lane reads the
    // markers through a store selector, so an agent's `add_marker` lands the
    // moment it commits — the whole point of the slice.
    await expect(marks).toHaveCount(2)
    await expect(
      page.locator('[data-testid="timeline-marker"][data-shape="point"]'),
    ).toHaveCount(1)
    const regionMark = page.locator('[data-testid="timeline-marker"][data-shape="region"]')
    await expect(regionMark).toHaveCount(1)
    // Every glyph is in the lane and none is in the ruler: one object, one hit
    // region, so a press on the ruler is a scrub and only a scrub.
    await expect(markerLane.locator('[data-testid="timeline-marker"]')).toHaveCount(2)
    await expect(
      page.locator('[data-testid="timeline-ruler"] [data-testid="timeline-marker"]'),
    ).toHaveCount(0)
    // Both authored freehand, so both are FREE — hollow, with the colour its
    // author gave it carried as a ring rather than a fill. Still the authored
    // colour and not a semantic marker colour, which is the part that matters.
    await expect(regionMark).toHaveAttribute('data-anchored', 'false')
    expect(
      await regionMark.evaluate((el) => getComputedStyle(el).boxShadow),
    ).toContain('rgb(34, 204, 85)')
    // Each name readable without a hover, which is what the lane exists for.
    await expect(labels).toHaveCount(2)
    await expect(labels.filter({ hasText: 'cut here' })).toHaveCount(1)
    await expect(labels.filter({ hasText: 'needs VO' })).toHaveCount(1)
    // Hover text carries what the glyph cannot say, and a region's carries both
    // ends.
    await expect(regionMark).toHaveAttribute(
      'title',
      'needs VO · 00:00:02:00 – 00:00:03:00',
    )

    // ── Hide from the strip ───────────────────────────────────────────────
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')
    await stripButton.click()
    // Not "hidden" — GONE, wrapper included (see the landmine on the layer).
    await expect(marks).toHaveCount(0)
    await expect(markerLayer).toHaveCount(0)
    // The LANE stays. The flag governs what it paints, never whether it exists —
    // a row bound to it would reflow the timeline under the pointer, since `M`
    // force-enables the same flag.
    await expect(markerLane).toHaveCount(1)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'false')
    await expect(stripButton).toHaveAttribute(
      'aria-label',
      'Timeline markers hidden. Click to show.',
    )
    // A canvas-noise control and nothing more: the markers are still project
    // content, so the search palette can still find and navigate to them.
    const state = await rootSummary<{ markers: unknown[] }>(page)
    expect(state.markers).toHaveLength(2)

    // ── Show again from the strip ─────────────────────────────────────────
    await stripButton.click()
    await expect(marks).toHaveCount(2)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')

    // ── …and from the View menu, which is the same one setting ────────────
    await viewMenu.click()
    await expect(showMarkersItem).toHaveCount(1)
    await showMarkersItem.click()
    await expect(marks).toHaveCount(0)
    // The proof that it is ONE setting and not two: flipping it in the menu
    // un-presses the strip button.
    await expect(stripButton).toHaveAttribute('aria-pressed', 'false')

    await viewMenu.click()
    await showMarkersItem.click()
    await expect(marks).toHaveCount(2)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await app.close()
  }
})

test('markers are authorable from the keyboard and the lane — no MCP client anywhere', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-marker-authoring-')
    await newProject(page, { parentFolder: parent, name: 'marker-authoring', canvas: CANVAS })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    const marks = page.locator('[data-testid="timeline-marker"]')
    const labels = page.locator('[data-testid="timeline-marker-label"]')
    const stripButton = page.locator('button[data-quick-action="toggleMarkersVisible"]')
    const renameInput = page.getByLabel('Marker label')

    // Give the composition real duration BEFORE parking the playhead. The
    // ruler seek clamps to the last frame anchor, and an empty composition's
    // autofitted duration is 0 (ADR 0005) — so over an empty timeline the park
    // below silently snaps back to frame 0. A layer via the renderer's own
    // command bridge keeps this spec's premise: still no MCP client anywhere.
    await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 5_000_000 })

    // Park the playhead away from the row head: a frame-0 diamond is centred
    // on the lane's left edge, so half of it sits under the sticky header
    // column — a poor right-click target for the step below. Asserted, not
    // assumed: a park that quietly clamped home would fail HERE, instead of as
    // an interception mystery at the right-click.
    await waitForHook(page, 'getPlayheadUs')
    await page.locator('[data-testid="timeline-ruler"]').click({ position: { x: 200, y: 10 } })
    await expect
      .poll(() => page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs()))
      .toBeGreaterThan(0)

    // ── M drops an unlabelled point marker at the playhead's frame ─────────
    await page.keyboard.press('M')
    await expect(marks).toHaveCount(1)
    // Unlabelled by design: the tooltip's translated fallback is the name, and
    // the lane prints nothing beside a mark that has none — "Marker" written out
    // next to every unnamed one would be noise, not information.
    await expect(marks).toHaveAttribute('title', /^Marker · /)
    await expect(labels).toHaveCount(0)
    const summary = await rootSummary<{ markers: Array<{ label: string }> }>(page)
    expect(summary.markers).toHaveLength(1)
    expect(summary.markers[0].label).toBe('')

    // ── M again on the same frame means rename, not a stacked duplicate ────
    await page.keyboard.press('M')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('cut here')
    await page.keyboard.press('Enter')
    await expect(renameInput).toHaveCount(0)
    await expect(marks).toHaveCount(1)
    await expect(marks).toHaveAttribute('title', /^cut here · /)
    // The name is now on the timeline, with no hover and no panel. That is the
    // lane's whole reason to exist.
    await expect(labels).toHaveText(['cut here'])

    // ── Right-click, Delete: two inputs, nothing asked first ───────────────
    await marks.click({ button: 'right' })
    await page.locator('.app-menu-item', { hasText: 'Delete marker' }).click()
    await expect(marks).toHaveCount(0)
    const afterDelete = await rootSummary<{ markers: unknown[] }>(page)
    expect(afterDelete.markers).toHaveLength(0)

    // ── M under a hidden layer turns the layer back on with the new mark ───
    await stripButton.click()
    await expect(stripButton).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('M')
    await expect(marks).toHaveCount(1)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await app.close()
  }
})

test('a marker moves by being dragged in its lane, and a drag that goes nowhere records nothing', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-marker-drag-')
    await newProject(page, { parentFolder: parent, name: 'marker-drag', canvas: CANVAS })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    const marks = page.locator('[data-testid="timeline-marker"]')
    const markerTUs = async (): Promise<number> =>
      (await rootSummary<{ markers: Array<{ t_us: number }> }>(page)).markers[0].t_us
    const playheadUs = () =>
      page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs() as number)

    // Same premise as the authoring spec above: real duration first, or the
    // ruler seek clamps back to frame 0 over an autofitted-to-nothing timeline.
    await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 5_000_000 })
    await waitForHook(page, 'getPlayheadUs')
    await page.locator('[data-testid="timeline-ruler"]').click({ position: { x: 200, y: 10 } })
    await expect.poll(playheadUs).toBeGreaterThan(0)

    await page.keyboard.press('M')
    await expect(marks).toHaveCount(1)
    const before = await markerTUs()
    const parkedPlayheadUs = await playheadUs()

    // ── Carry the mark down the lane ──────────────────────────────────────
    // One event per protocol round trip, as every other drag spec does: fired
    // inside one page task, React would still be uncommitted from the
    // pointerdown when the move arrived.
    const box = await marks.boundingBox()
    if (!box) throw new Error('the marker glyph has no layout box')
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 120, from.y)
    await page.mouse.up()

    await expect.poll(markerTUs).toBeGreaterThan(before)

    // The gesture the ruler could never have hosted: this lane is not a scrub
    // surface, so a press that travelled 120 px across it moved the mark and
    // left the film exactly where it was.
    expect(await playheadUs()).toBe(parkedPlayheadUs)
    // Still a marker, still right-clickable — the drag did not swallow the
    // menu the other two operations live in.
    await marks.click({ button: 'right' })
    await expect(page.locator('.app-menu-item', { hasText: 'Rename' })).toHaveCount(1)
    await page.keyboard.press('Escape')

    // ── ONE history entry for the whole drag ──────────────────────────────
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(markerTUs).toBe(before)

    // ── A drag that lands where it started is not an edit ──────────────────
    const still = await marks.boundingBox()
    if (!still) throw new Error('the marker glyph has no layout box')
    await page.mouse.move(still.x + still.width / 2, still.y + still.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    expect(await markerTUs()).toBe(before)
    // The proof that it recorded nothing: the next undo pops the mark's own
    // CREATION, not a no-op move standing in front of it.
    await invokeCmd(page, 'project_undo', {})
    await expect(marks).toHaveCount(0)
  } finally {
    await app.close()
  }
})
