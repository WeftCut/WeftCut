import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { dockPanel, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'
import type { AgentActivitySnapshot } from '../../src/shared/agent-activity'

test('agent panel separates views, work sessions and connection lifetime', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const clients: Client[] = []
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-agent-panel-'), name: 'agent-panel', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
    const snapshot = () => invokeCmd<AgentActivitySnapshot>(page, 'agent_activity_snapshot', {})
    const menu = async (label: RegExp) => {
      await page.locator('.menu-trigger').nth(2).click()
      await page.locator('.app-menu-item').filter({ hasText: label }).click()
    }
    await menu(/^Enter Agent Mode$/)
    await expect(page.locator('.agent-mode-shell')).toBeVisible()
    expect((await snapshot()).session).toBeNull()
    expect((await snapshot()).checkpoints).toHaveLength(0)
    await page.locator('.agent-exit-button').click()
    await expect(page.locator('.agent-mode-shell')).toHaveCount(0)

    const info = await page.evaluate(() => (window as any).api.mcp.getInfo()) as { url: string; bearer_token: string }
    const connect = async (name: string) => {
      const transport = new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } })
      const client = new Client({ name, version: '1.0' })
      await client.connect(transport); clients.push(client)
      return { client, transport }
    }
    const { client, transport } = await connect('Panel test agent')
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
    const trackResource = await client.readResource({ uri: 'project://tracks' })
    const trackId = JSON.parse((trackResource.contents[0] as { text: string }).text)[0].id as string
    expect((await call('begin_agent_session', { reason: 'Interview rough cut' })).isError).not.toBe(true)
    await expect(page.locator('.agent-mode-shell')).toBeVisible()
    await expect(page.locator('.agent-session-header')).toContainText('Interview rough cut')
    const first = (await snapshot()).session!
    await call('set_history_lock', { locked: true, reason: 'Rough cut batch' })
    await expect(page.getByRole('button', { name: 'Unlock undo', exact: true })).toBeVisible()
    await page.locator('.agent-exit-button').click()
    expect((await snapshot()).session?.id).toBe(first.id)
    expect((await snapshot()).lock_reason).toBe('Rough cut batch')
    await menu(/^Agent$/)
    await expect(dockPanel(page, 'agent')).toHaveCount(1)
    await call('begin_agent_session', { reason: 'Retry begin' })
    await expect(page.locator('.agent-mode-shell')).toHaveCount(0)
    expect((await snapshot()).checkpoints).toHaveLength(1)
    const other = await connect('Second client')
    expect((await other.client.callTool({ name: 'begin_agent_session', arguments: { reason: 'Other work' } })).isError).toBe(true)
    await other.client.readResource({ uri: 'project://current' })

    await call('add_color_layer', { track_id: trackId, color: { r: 28, g: 76, b: 128, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 })
    await client.readResource({ uri: 'project://current' })
    await client.readResource({ uri: 'project://tracks' })
    await call('set_history_lock', { locked: false })
    await call('restore_checkpoint', { checkpoint_id: first.checkpoint_id })
    await expect.poll(async () => (await snapshot()).activities.some(a => a.effect === 'reverted')).toBe(true)
    const count = (await snapshot()).activities.length
    await invokeCmd(page, 'log_clear', {})
    expect((await snapshot()).activities.length).toBe(count)
    await page.screenshot({ path: testInfo.outputPath('agent-panel-editor.png') })
    await page.getByRole('button', { name: 'End work session', exact: true }).click()
    await expect.poll(async () => (await snapshot()).session).toBeNull()
    await expect(page.locator('.agent-mode-shell')).toHaveCount(0)
    await call('add_color_layer', { track_id: trackId, color: { r: 51, g: 102, b: 153, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 })
    expect((await snapshot()).activities.at(-1)?.session_id).toBeNull()

    await call('begin_agent_session', { reason: 'Check the result' })
    await call('set_history_lock', { locked: true, reason: 'Check batch' })
    expect((await call('end_agent_session')).isError).not.toBe(true)
    expect((await snapshot()).session).toBeNull()
    expect((await snapshot()).lock_reason).toBeNull()
    expect((await call('end_agent_session')).isError).not.toBe(true)
    await expect(page.locator('.agent-mode-shell')).toBeVisible()

    await call('begin_agent_session', { reason: 'Final review' })
    await call('set_history_lock', { locked: true, reason: 'Review batch' })
    await expect(page.locator('.agent-mode-shell')).toBeVisible()
    await page.getByRole('button', { name: 'MCP service ready' }).click()
    await expect(page.locator('.agent-connection-details')).toContainText('Panel test agent')
    await page.screenshot({ path: testInfo.outputPath('agent-panel-view.png') })
    await transport.terminateSession()
    await expect.poll(async () => (await snapshot()).session).toBeNull()
    expect((await snapshot()).lock_reason).toBeNull()
    expect((await snapshot()).sessions.at(-1)?.end_reason).toBe('disconnected')
    await expect(page.locator('.agent-mode-shell')).toBeVisible()
    expect(await page.getByRole('button', { name: 'Locate object' }).count()).toBe(0)
  } finally {
    await Promise.allSettled(clients.map(c => c.close()))
    await app.close()
  }
})

test('tacks: listed in the panel, chipped in the review lane, converted into one undoable marker', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  let client: Client | null = null
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-agent-tacks-'), name: 'agent-tacks', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
    const info = await page.evaluate(() => (window as any).api.mcp.getInfo()) as { url: string; bearer_token: string }
    client = new Client({ name: 'Tack test agent', version: '1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }))
    const created = await client.callTool({ name: 'create_tacks', arguments: { tacks: [{ label: 'Long pause', body: 'Keep the breath?', kind: 'question', t_us: 0, end_t_us: 1_000_000 }] } })
    expect(created.isError).not.toBe(true)
    const markers = async () => {
      const s = await invokeCmd<{ root_id: string; compositions: Record<string, { markers: Array<{ label: string; note: string }> }> }>(page, 'project_summary', {})
      return s.compositions[s.root_id]!.markers
    }

    // The tack is a chip in the Review lane, a row of its own under the marker
    // lane; the marker lane holds no tack.
    const lane = page.getByTestId('timeline-review-lane')
    await expect(lane.getByTestId('timeline-tack')).toHaveCount(1)
    await expect(page.getByTestId('timeline-marker-lane').getByTestId('timeline-tack')).toHaveCount(0)
    const markerBox = (await page.getByTestId('timeline-marker-lane').boundingBox())!
    expect((await lane.boundingBox())!.y).toBeGreaterThanOrEqual(markerBox.y + markerBox.height - 1)
    // The header switch turns the overlay off and takes the row with it; the
    // View menu turns it back on.
    await page.getByTestId('timeline-review-overlay-toggle').click()
    await expect(lane).toHaveCount(0)
    await expect(page.getByTestId('timeline-tack')).toHaveCount(0)
    await page.locator('.menu-trigger').nth(2).click()
    await page.locator('.app-menu-item').filter({ hasText: /^Review overlay$/ }).click()
    await expect(lane.getByTestId('timeline-tack')).toHaveCount(1)

    // A chip click opens the Agent panel on its Tacks tab with the row selected.
    await page.getByTestId('timeline-tack').click()
    await expect(page.getByTestId('timeline-tack')).toHaveAttribute('data-selected', 'true')
    await expect(dockPanel(page, 'agent')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /Tacks/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.agent-tack[data-selected="true"]')).toContainText('Long pause')
    await page.getByRole('button', { name: 'Convert to marker' }).click()
    await expect(page.locator('.agent-tack')).toHaveCount(0)
    await expect.poll(markers).toEqual([expect.objectContaining({ label: 'Long pause', note: 'Keep the breath?' })])
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(markers).toEqual([])
    expect((await invokeCmd<AgentActivitySnapshot>(page, 'agent_activity_snapshot', {})).tacks).toEqual([])
  } finally {
    await client?.close()
    await app.close()
  }
})

test('changes: an agent edit is listed, highlighted and counted until approved', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  let client: Client | null = null
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-agent-changes-'), name: 'agent-changes', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
    const info = await page.evaluate(() => (window as any).api.mcp.getInfo()) as { url: string; bearer_token: string }
    client = new Client({ name: 'Change test agent', version: '1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }))
    const call = (name: string, args: Record<string, unknown> = {}) => client!.callTool({ name, arguments: args })
    const trackResource = await client.readResource({ uri: 'project://tracks' })
    const trackId = JSON.parse((trackResource.contents[0] as { text: string }).text)[0].id as string

    // The work session pins the Review baseline; the agent's clip is the one change.
    expect((await call('begin_agent_session', { reason: 'Add a title card' })).isError).not.toBe(true)
    await expect(page.locator('.agent-mode-shell')).toBeVisible()
    expect((await call('add_color_layer', { track_id: trackId, color: { r: 28, g: 76, b: 128, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 })).isError).not.toBe(true)
    await expect(page.getByRole('tab', { name: /Changes/ })).toHaveText('Changes1')
    await expect(page.getByTestId('mini-change')).toHaveCount(1)
    await page.locator('.agent-exit-button').click()
    await expect(page.locator('.agent-mode-shell')).toHaveCount(0)

    // Editor: the clip carries the added mark, and the status bar counts it.
    await expect(page.locator('[data-testid="review-clip-mark"][data-review-mark="added"]')).toHaveCount(1)
    const status = page.getByTestId('status-bar-review')
    await expect(status).toHaveText('1 to review')
    await status.click()
    await expect(dockPanel(page, 'agent')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.agent-change')).toHaveCount(1)
    await expect(page.locator('.agent-change')).toContainText('Added')

    // Approve all: the list, the highlight and the count go together.
    await page.getByRole('button', { name: 'Approve all' }).click()
    await expect(page.locator('.agent-change')).toHaveCount(0)
    await expect(page.getByTestId('review-clip-mark')).toHaveCount(0)
    await expect(page.getByTestId('status-bar-review')).toHaveCount(0)
  } finally {
    await client?.close()
    await app.close()
  }
})
