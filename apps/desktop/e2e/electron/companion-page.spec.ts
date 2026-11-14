// The companion page an agent hands the user through `open_companion`: it
// opens in a browser of this machine, follows the project, works inside a
// sandboxed frame, shows the preview's picture only once the user asks and
// steps it aside for an export, outlives a restart of the app, and its key
// opens nothing but its own routes. A second window of the app under test
// stands in for a host's built-in browser.
import path from 'node:path'
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
    // A host's side browser is on screen; this hidden stand-in must not be
    // throttled as a background page would be.
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
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

test('the picture is captured only once the user turns it on, and an export holds it', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()
  let client: Client | undefined
  try {
    ;({ client } = await connect(page))
    await call(client, 'create_project', {
      parent_folder: tmpDir('weftcut-companion-picture-'), name: 'Companion picture',
      width: 640, height: 360, fps: { num: 30, den: 1 },
    })
    // Long enough that playback is still running when the picture starts.
    const track = await call<{ track_id: string }>(client, 'add_track', { label: 'Sequence' })
    await call(client, 'add_layers', { layers: [
      { track_id: track.track_id, t_start_us: 0, t_end_us: 20_000_000, label: 'Picture clip', content: { kind: 'color', color: { r: 40, g: 120, b: 200, a: 255 } } },
    ] })

    // Every capture of a canvas in the editor, counted where the encoder
    // would make it.
    await page.evaluate(() => {
      const w = window as unknown as { __captures: number }
      w.__captures = 0
      const original = HTMLCanvasElement.prototype.captureStream
      HTMLCanvasElement.prototype.captureStream = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
        w.__captures++
        return original.apply(this, args)
      }
    })
    const captures = () => page.evaluate(() => (window as unknown as { __captures: number }).__captures)

    const { url } = await call<{ url: string }>(client, 'open_companion')
    const companion = await openWindow(app, url)
    const root = companion.locator('#companion')
    const stage = companion.locator('.cw-stage')
    await expect(root).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
    await expect(stage).toHaveAttribute('data-picture', 'off')

    // Witness: the editor reports its playhead moving, so it has been
    // playing, page open, for a while.
    await companion.locator('.cw-play').click()
    const link = new URL(url)
    const transport = async () => {
      const r = await fetch(`${link.origin}/companion/state`, { headers: { Authorization: `Bearer ${pageKey(url)}` } })
      return ((await r.json()) as { transport: { t_us: number; playing: boolean } }).transport
    }
    await expect.poll(async () => { const t = await transport(); return t.playing && t.t_us > 0 }, { timeout: 30_000 }).toBe(true)
    expect(await captures(), 'no capture while the picture is off').toBe(0)

    await companion.locator('.cw-show-picture').click()
    // `live` is set by the page's decoder drawing a frame: encoded, sent and
    // decoded. No rate is asked of it.
    await expect(stage).toHaveAttribute('data-picture', 'live', { timeout: 60_000 })
    expect(await captures()).toBeGreaterThan(0)

    // Every stage the page shows from here on, in order.
    await companion.evaluate(() => {
      const el = document.querySelector('.cw-stage')!
      const seen: string[] = []
      ;(window as unknown as { __stages: string[] }).__stages = seen
      new MutationObserver(() => { seen.push(el.getAttribute('data-picture') ?? '') }).observe(el, { attributes: true, attributeFilter: ['data-picture'] })
    })
    const output = path.join(tmpDir('weftcut-companion-export-'), 'picture.mp4')
    const { job_id } = await call<{ job_id: string }>(client, 'start_export', {
      request_id: 'companion-picture', output_path: output, preset_id: 'builtin:match',
      settings: { encoder_engine: 'native', hw_accel: 'software', include_audio: false, fps: 30 },
    })
    await expect.poll(async () => (await call<{ job: { state: string } }>(client!, 'get_export_status', { job_id })).job.state, { timeout: 120_000 }).toBe('completed')
    await expect(stage).not.toHaveAttribute('data-picture', 'export')
    expect(await companion.evaluate(() => (window as unknown as { __stages: string[] }).__stages), 'the page said an export held the picture').toContain('export')
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
