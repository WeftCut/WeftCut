// The companion page an agent hands the user through `open_companion`: it
// opens in a browser of this machine, follows the project, works inside a
// sandboxed frame, outlives a restart of the app, and its key opens nothing
// but its own routes. A second window of the app under test stands in for a
// host's built-in browser.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { launchApp, tmpDir } from './helpers/driver'
import type { WeftcutApi } from '../../src/shared/ipc'

interface Info { url: string; bearer_token: string }

async function connect(page: Page): Promise<{ client: Client; info: Info }> {
  const info = await page.evaluate(() => (window as unknown as { api: WeftcutApi }).api.mcp.getInfo()) as Info
  const client = new Client({ name: 'companion-page-e2e', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  }))
  return { client, info }
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, `${name}: ${JSON.stringify(result)}`).toBeFalsy()
  return result.structuredContent as T
}

/** A new window of the app, loading `url`: what a host's side browser is here. */
async function openWindow(app: ElectronApplication, url: string): Promise<Page> {
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true } })
    void win.loadURL(target)
  }, url)
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return page
}

const pageKey = (link: string) => /#k=([0-9a-f]{64})$/.exec(link)![1]!

test('the link opens the page, whose timeline follows an MCP edit, in a window and in a sandboxed frame', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  let client: Client | undefined
  try {
    ;({ client } = await connect(page))
    await call(client, 'create_project', {
      parent_folder: tmpDir('weftcut-companion-project-'), name: 'Companion',
      width: 640, height: 360, fps: { num: 30, den: 1 },
    })
    const { url } = await call<{ url: string }>(client, 'open_companion')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/companion#k=[0-9a-f]{64}$/)

    const companion = await openWindow(app, url)
    const root = companion.locator('#companion')
    // `ready` needs the editor's bridge attached: the editor followed the
    // agent's project and can be driven.
    await expect(root).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })

    const track = await call<{ track_id: string }>(client, 'add_track', { label: 'Sequence' })
    const { layers } = await call<{ layers: Array<{ layer_id: string }> }>(client, 'add_layers', { layers: [
      { track_id: track.track_id, t_start_us: 0, t_end_us: 1_000_000, label: 'Companion clip', content: { kind: 'color', color: { r: 200, g: 40, b: 40, a: 255 } } },
    ] })
    const clip = `.cw-clip[data-layer-id="${layers[0]!.layer_id}"]`
    await expect(companion.locator(clip)).toHaveText('Companion clip')

    // The same link in a frame with an opaque origin, as a host may embed it.
    const host = await openWindow(app, 'about:blank')
    await host.setContent(`<iframe sandbox="allow-scripts" width="800" height="400" src="${url}"></iframe>`)
    const framed = host.frameLocator('iframe')
    await expect(framed.locator('#companion')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
    await expect(framed.locator(clip)).toHaveText('Companion clip')
  } finally {
    await client?.close().catch(() => {})
    await app.close()
  }
})

test('a link outlives a restart of the app, and its key opens nothing under /mcp', async () => {
  test.setTimeout(120_000)
  const userDataDir = tmpDir('weftcut-companion-profile-')
  let url: string
  const first = await launchApp({ userDataDir })
  try {
    const { client } = await connect(first.page)
    ;({ url } = await call<{ url: string }>(client, 'open_companion'))
    await client.close()
  } finally {
    await first.app.close()
  }

  const second = await launchApp({ userDataDir })
  try {
    const { client, info } = await connect(second.page)
    await client.close()
    const link = new URL(url)
    // The port is only reused, never promised (`mcp/bind.ts`): a different
    // one here is the cause of any failure below, so it is named first.
    expect(new URL(info.url).port, 'the app came back on its stored port').toBe(link.port)
    const key = pageKey(url)

    expect((await fetch(`${link.origin}${link.pathname}`)).status).toBe(200)
    expect((await fetch(`${link.origin}/companion/state`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(200)
    // Neither key opens the other's routes.
    expect((await fetch(`${link.origin}/companion/state`, { headers: { Authorization: `Bearer ${info.bearer_token}` } })).status).toBe(401)
    const mcp = await fetch(info.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'companion-page-e2e', version: '1' } } }),
    })
    expect(mcp.status).toBe(401)
  } finally {
    await second.app.close()
  }
})
