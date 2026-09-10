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
    await call('lock_history', { reason: '' })
    await expect(page.getByRole('button', { name: 'Unlock undo' })).toBeVisible()
    await page.locator('.agent-exit-button').click()
    expect((await snapshot()).session?.id).toBe(first.id)
    expect((await snapshot()).lock_reason).toBe('')
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
    await call('unlock_history')
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
    await call('lock_history', { reason: 'Check batch' })
    expect((await call('end_agent_session')).isError).not.toBe(true)
    expect((await snapshot()).session).toBeNull()
    expect((await snapshot()).lock_reason).toBeNull()
    expect((await call('end_agent_session')).isError).not.toBe(true)
    await expect(page.locator('.agent-mode-shell')).toBeVisible()

    await call('begin_agent_session', { reason: 'Final review' })
    await call('lock_history', { reason: 'Review batch' })
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
