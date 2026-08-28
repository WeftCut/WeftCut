import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
  waitForHook,
  type ProjectSummaryWire,
} from './helpers/driver'

/**
 * The editor opens ONE composition at a time (spec § Navigation and scope):
 * the timeline shows its lanes, the ruler runs to its duration, and the Insert
 * menu lands new layers inside it. Nothing here draws a Group clip or a
 * tab strip — the switch is driven through the e2e hook, which is the same
 * `openComposition` a double-click on a Group clip calls.
 *
 * The two-composition fixture (`fixtures/projects/v1.json`) is opened as a
 * workspace: a 5 s root with four lanes, holding a 2 s Group with the reserved
 * A/B pair and one Color layer. Both sides of every assertion are read off the
 * live `project_summary`, so the ids are never hard-coded.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../../fixtures/projects/v1.json')
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

const wire = (page: Page) => invokeCmd<ProjectSummaryWire>(page, 'project_summary', {})

/// The lanes the ACTIVE timeline Panel draws, by track id. Scoped to the
/// visible Panel because several timelines can stand open at once (ADR 0053) —
/// a background tab keeps its own lanes mounted behind this one.
const laneIds = (page: Page): Promise<string[]> =>
  page
    .locator(
      '.weft-dock-panel[data-panel-kind="timeline"][data-panel-visible="true"] [data-testid="track-lane"]',
    )
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-track-id') ?? ''))

const openComposition = (page: Page): Promise<{ id: string; crumbs: unknown[] } | null> =>
  page.evaluate(() => (window as any).__weftcutTest.getOpenComposition())

const playheadUs = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs())

const layerIdsOf = (c: { tracks: Array<{ layers: Array<{ id: string }> }> }) =>
  c.tracks.flatMap((t) => t.layers.map((l) => l.id)).sort()

/// An MCP client on this app's own loopback server — the read surface an agent
/// sees, so `project://tracks?composition=` confirms where the layer landed
/// independently of the renderer's own summary.
async function mcpClient(page: Page): Promise<Client> {
  const info = await page.evaluate(
    () => (window as any).api.mcp.getInfo() as Promise<{ url: string; bearer_token: string } | null>,
  )
  if (!info) throw new Error('MCP server not up')
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  })
  const client = new Client({ name: 'e2e-composition-scope', version: '0.0.0' })
  await client.connect(transport)
  return client
}

test('the timeline, the ruler and the Insert menu follow the open composition', async () => {
  test.setTimeout(150_000)
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-scope-')
    await newProject(page, { parentFolder: parent, name: 'scope-blank', canvas: CANVAS })

    // Swap in the two-composition fixture as a workspace of its own and reopen
    // into it — the only in-session way to switch projects.
    const dir = path.join(parent, 'two-compositions')
    fs.mkdirSync(dir)
    fs.copyFileSync(FIXTURE, path.join(dir, 'project.json'))
    await waitForHook(page, 'motifReopenProject')
    await page.evaluate((p) => (window as any).__weftcutTest.motifReopenProject({ path: p }), dir)
    await waitForHook(page, 'setOpenComposition')
    await waitForHook(page, 'getPlayheadUs')
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    const s0 = await wire(page)
    const rootId = s0.root_id
    const groupId = Object.keys(s0.compositions).find((id) => id !== rootId)
    if (!groupId) throw new Error('fixture carries no Group composition')
    const root = s0.compositions[rootId]!
    const group = s0.compositions[groupId]!
    expect(root.duration_us).toBe(5_000_000)
    expect(group.duration_us).toBe(2_000_000)
    const rootTrackIds = root.tracks.map((t) => t.id)
    const groupTrackIds = group.tracks.map((t) => t.id)

    // ── At the root: every drawn lane is the root's ──────────────────────
    await expect.poll(() => openComposition(page)).toMatchObject({ id: rootId, crumbs: [] })
    await expect.poll(() => laneIds(page)).not.toHaveLength(0)
    for (const id of await laneIds(page)) expect(rootTrackIds).toContain(id)

    // The ruler's bound is the root's: End parks on the root's last frame.
    await page.locator('[data-testid="timeline-ruler"]').click({ position: { x: 120, y: 10 } })
    await page.keyboard.press('End')
    await expect.poll(() => playheadUs(page)).toBe(4_966_667)

    // ── Open the Group ────────────────────────────────────────────────────
    expect(
      await page.evaluate((id) => (window as any).__weftcutTest.setOpenComposition(id), groupId),
    ).toBe(true)
    await expect.poll(() => openComposition(page)).toMatchObject({ id: groupId })

    // Its lanes, and only its lanes. The reserved pair both carry roles, so the
    // default A/B Roll display shows exactly the two.
    await expect.poll(() => laneIds(page)).toHaveLength(groupTrackIds.length)
    for (const id of await laneIds(page)) {
      expect(groupTrackIds).toContain(id)
      expect(rootTrackIds).not.toContain(id)
    }

    // One moment, read on the Group's clock (ADR 0053): the switch leaves the
    // film where it is, and Home/End move to the ends of the GROUP — which are
    // the moments its placement [3 s, 5 s) sits at on the film.
    expect(await playheadUs(page)).toBe(4_966_667)
    await page.keyboard.press('Home')
    await expect.poll(() => playheadUs(page)).toBe(3_000_000)
    await page.keyboard.press('End')
    await expect.poll(() => playheadUs(page)).toBe(4_966_667)

    // ── Insert → Color layer lands INSIDE the Group ───────────────────────
    const rootLayersBefore = layerIdsOf(root)
    const groupLayersBefore = layerIdsOf(group)
    await page.locator('.menu-trigger').filter({ hasText: /^Insert$/ }).click()
    await page.locator('.app-menu-item').filter({ hasText: /^Color layer$/ }).click()

    await expect
      .poll(async () => layerIdsOf((await wire(page)).compositions[groupId]!).length)
      .toBe(groupLayersBefore.length + 1)
    const s1 = await wire(page)
    expect(layerIdsOf(s1.compositions[rootId]!)).toEqual(rootLayersBefore)
    const added = layerIdsOf(s1.compositions[groupId]!).filter((id) => !groupLayersBefore.includes(id))
    expect(added).toHaveLength(1)

    // The agent's read surface agrees: the layer is on a track of the Group.
    const client = await mcpClient(page)
    try {
      const res = await client.readResource({ uri: `project://tracks?composition=${groupId}` })
      const tracks = JSON.parse((res.contents[0] as { text: string }).text) as Array<{
        layers: Array<{ id: string; params: { kind: string } }>
      }>
      const inGroup = tracks.flatMap((t) => t.layers).find((l) => l.id === added[0])
      expect(inGroup?.params.kind).toBe('Color')
      const rootRes = await client.readResource({ uri: 'project://tracks' })
      const rootTracks = JSON.parse((rootRes.contents[0] as { text: string }).text) as Array<{
        layers: Array<{ id: string }>
      }>
      expect(rootTracks.flatMap((t) => t.layers).some((l) => l.id === added[0])).toBe(false)
    } finally {
      await client.close()
    }

    // ── Back to the root: its lanes again, and the same moment ──────────
    expect(
      await page.evaluate((id) => (window as any).__weftcutTest.setOpenComposition(id), rootId),
    ).toBe(true)
    await expect.poll(() => openComposition(page)).toMatchObject({ id: rootId, crumbs: [] })
    for (const id of await laneIds(page)) expect(rootTrackIds).toContain(id)
    expect(await playheadUs(page)).toBe(4_966_667)
  } finally {
    await app.close()
  }
})
