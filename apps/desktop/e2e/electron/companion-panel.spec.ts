// The side-panel view a host with MCP Apps shows beside its chat, end to end:
// listed only to a client that declares the UI capability, loaded from the
// `weftcut` binary over stdio, drawn in a sandboxed frame that may fetch
// nothing, driving the editor through tool calls, decoding the picture from a
// data channel whose answer names only 127.0.0.1, and offering to start the
// app, and reopen its project, after it quit.
//
// The host is played by a page of a separate Electron process (it must outlive
// the app under test), served from 127.0.0.1 so its frame is a secure context
// with WebCodecs; its postMessage bridge runs in this test, over an MCP client
// that spawns the profile's `weftcut mcp`.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { launchApp, tmpDir } from './helpers/driver'

const SHOWS_VIEWS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }
const ENTRY = 'side_preview_panel'
const SYNC = 'side_preview_sync'

/// The CSP a host applies to a view that declares none (MCP Apps 2026-01-26):
/// inline script and style, data: images, and no request of any kind.
const VIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'"

/// The host page: the view in a frame with an opaque origin, and the host's
/// half of MCP Apps. Tool calls go to `window.hostCall`, which this test
/// exposes and answers through its MCP client.
const HOST_HTML = `<!doctype html>
<meta charset="utf-8">
<body style="margin:0;background:#000">
<iframe id="view" sandbox="allow-scripts" style="width:560px;height:720px;border:0"></iframe>
<script>
const frame = document.getElementById('view')
const post = (message) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...message }, '*')
window.addEventListener('message', async (event) => {
  if (event.source !== frame.contentWindow) return
  const m = event.data
  if (!m || m.jsonrpc !== '2.0') return
  if (m.method === 'ui/initialize') {
    post({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: 'e2e-host', version: '1' }, hostCapabilities: {}, hostContext: { locale: 'en-US', displayMode: 'fullscreen' } } })
  } else if (m.method === 'tools/call') {
    const answer = JSON.parse(await window.hostCall(JSON.stringify(m.params)))
    post({ id: m.id, ...answer })
  }
})
window.loadView = (html) => { frame.srcdoc = html }
</script>`

/// The host's own process: one window on the host page, nothing of WeftCut's.
const HOST_MAIN = `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 600, height: 760, show: false, webPreferences: { backgroundThrottling: false } })
  void win.loadURL(process.env.WEFTCUT_E2E_HOST_URL)
})
app.on('window-all-closed', () => {})
`

function cliPath(userDataDir: string): string {
  return path.join(userDataDir, 'cli', process.platform === 'win32' ? 'weftcut.exe' : 'weftcut')
}

async function stdioClient(userDataDir: string, capabilities: Record<string, unknown>): Promise<Client> {
  const client = new Client({ name: 'companion-panel-e2e', version: '1' }, { capabilities })
  await client.connect(new StdioClientTransport({
    command: cliPath(userDataDir),
    args: ['mcp'],
    env: { ...process.env, WEFTCUT_USERDATA: userDataDir } as Record<string, string>,
    stderr: 'ignore',
  }))
  return client
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, `${name}: ${JSON.stringify(result)}`).toBeFalsy()
  return result.structuredContent as T
}

/// Every address an SDP names, in its candidates and connection lines.
const addresses = (sdp: string) => [
  ...[...sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) /gm)].map((m) => m[1]),
  ...[...sdp.matchAll(/^c=IN IP[46] (\S+)/gm)].map((m) => m[1]),
]

test('the side-panel view follows the editor over tool calls, shows the picture over loopback, and brings the app back', async () => {
  test.setTimeout(240_000)
  const userDataDir = tmpDir('weftcut-companion-panel-')
  let app: ElectronApplication | null = (await launchApp({ userDataDir })).app
  let client: Client | null = null
  let hostApp: ElectronApplication | null = null
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HOST_HTML) })
  try {
    // The app copies its binary into the profile at start.
    await expect.poll(() => fs.existsSync(cliPath(userDataDir)), { timeout: 60_000 }).toBe(true)

    // A client that shows no views is listed neither the entry nor its tool.
    const plain = await stdioClient(userDataDir, {})
    const plainTools = (await plain.listTools()).tools.map((t) => t.name)
    expect(plainTools).toContain('read_project')
    expect(plainTools).not.toContain(ENTRY)
    expect(plainTools).not.toContain(SYNC)
    await plain.close()

    client = await stdioClient(userDataDir, SHOWS_VIEWS)
    const tools = (await client.listTools()).tools
    const entry = tools.find((t) => t.name === ENTRY)
    expect(entry, 'the entry is listed to a client that shows views').toBeDefined()
    expect(tools.map((t) => t.name)).toContain(SYNC)
    const uri = (entry!._meta as { ui: { resourceUri: string } }).ui.resourceUri
    expect(uri).toMatch(/^ui:\/\/weftcut\/side-preview-[0-9a-f]{12}\.html$/)
    const parentFolder = tmpDir('weftcut-companion-panel-project-')
    await call(client, 'create_project', { parent_folder: parentFolder, name: 'Panel', width: 640, height: 360, fps: { num: 30, den: 1 } })
    expect((await client.callTool({ name: ENTRY, arguments: {} })).isError).toBeFalsy()
    const read = await client.readResource({ uri })
    const html = (read.contents[0] as { text: string }).text.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`)

    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const hostUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const hostDir = tmpDir('weftcut-companion-panel-host-')
    fs.writeFileSync(path.join(hostDir, 'main.cjs'), HOST_MAIN)
    // Its own profile: parallel workers' hosts must not share Electron's default one.
    hostApp = await electron.launch({
      args: [`--user-data-dir=${path.join(hostDir, 'profile')}`, path.join(hostDir, 'main.cjs')],
      env: { ...process.env, WEFTCUT_E2E_HOST_URL: hostUrl } as Record<string, string>,
    })
    const host: Page = await hostApp.firstWindow({ timeout: 60_000 })
    await host.waitForLoadState('domcontentloaded')

    // The host's bridge: every tool call the view makes, answered by the stdio
    // session. A start of the app goes through this test's launcher, so the
    // app it starts is one the test can close; the call then reaches the
    // binary, which finds the app up.
    const viewCalls: string[] = []
    const answers: string[] = []
    let relaunch: (() => Promise<void>) | null = null
    await host.exposeFunction('hostCall', async (paramsJson: string) => {
      const params = JSON.parse(paramsJson) as { name: string; arguments?: Record<string, unknown> }
      viewCalls.push(params.name)
      if (params.name === 'launch_weftcut' && relaunch !== null) await relaunch()
      try {
        const result = await client!.request({ method: 'tools/call', params }, CallToolResultSchema)
        if (params.name === SYNC && params.arguments?.op === 'signal') {
          const answer = (result.structuredContent as { answer?: string } | undefined)?.answer
          if (answer) answers.push(answer)
        }
        return JSON.stringify({ result })
      } catch (e) {
        if (e instanceof McpError) return JSON.stringify({ error: { code: e.code, message: e.message } })
        throw e
      }
    })
    await host.evaluate((view) => { (window as unknown as { loadView(html: string): void }).loadView(view) }, html)
    const view = host.frameLocator('#view')
    const root = view.locator('#companion')
    await expect(root).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
    expect(viewCalls, 'the view reads through its own tool').toContain(SYNC)

    // An edit reaches the view's timeline.
    const track = await call<{ track_id: string }>(client, 'add_track', { label: 'Sequence' })
    const { layers } = await call<{ layers: Array<{ layer_id: string }> }>(client, 'add_layers', { layers: [
      { track_id: track.track_id, t_start_us: 0, t_end_us: 10_000_000, label: 'Panel clip', content: { kind: 'color', color: { r: 40, g: 160, b: 90, a: 255 } } },
    ] })
    await expect(view.locator(`.cw-clip[data-layer-id="${layers[0]!.layer_id}"]`)).toHaveText('Panel clip')

    // The view's controls drive the editor's player.
    const playhead = () => call<{ t_us: number; playing: boolean }>(client!, 'read_project', { view: 'playhead' })
    await view.locator('.cw-next').click()
    await expect.poll(async () => (await playhead()).t_us, { timeout: 30_000 }).toBeGreaterThan(0)
    await view.locator('.cw-play').click()
    await expect.poll(async () => (await playhead()).playing, { timeout: 30_000 }).toBe(true)

    // The picture: `live` is set by the view's decoder drawing a frame that
    // came over the data channel. The answer it was given names no address
    // of this machine's networks.
    await view.locator('.cw-show-picture').click()
    const stage = view.locator('.cw-stage')
    await expect(stage).toHaveAttribute('data-picture', 'live', { timeout: 60_000 })
    expect(answers.length).toBeGreaterThan(0)
    for (const answer of answers) expect(new Set(addresses(answer))).toEqual(new Set(['127.0.0.1']))

    // The app quits: the view says so and offers to start it.
    await app.close()
    app = null
    await expect(root).toHaveAttribute('data-state', 'offline', { timeout: 60_000 })
    const start = view.locator('.cw-empty-start')
    await expect(start).toBeVisible()

    relaunch = async () => {
      relaunch = null
      app = (await launchApp({ userDataDir })).app
    }
    await start.click()
    // A fresh start may stop on the start screen; the view then offers the
    // project the app lists first among its recent ones.
    await expect(root).toHaveAttribute('data-state', /^(ready|no_project)$/, { timeout: 90_000 })
    expect(viewCalls).toContain('launch_weftcut')
    if ((await root.getAttribute('data-state')) === 'no_project') {
      const recent = view.locator('.cw-empty-recent')
      await expect(recent).toHaveText('Open Panel', { timeout: 30_000 })
      await recent.click()
    }
    await expect(root).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
    await expect(view.locator(`.cw-clip[data-layer-id="${layers[0]!.layer_id}"]`)).toHaveText('Panel clip')
  } finally {
    await client?.close().catch(() => {})
    await hostApp?.close().catch(() => {})
    await new Promise((resolve) => { server.close(resolve) })
    await app?.close()
  }
})
