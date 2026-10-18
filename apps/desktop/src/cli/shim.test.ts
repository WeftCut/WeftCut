// The shim's catalog state machine, exercised entirely in memory: a test
// Client drives the shim's stdio face over one InMemoryTransport pair, and
// the bridge connects to a fake "app" MCP server over another. Covers the
// spec's core claims — catalog = synthetic ∪ (app alive ? real : ∅),
// list_changed on BOTH transitions, actionable down-state errors, and the
// launch_weftcut close-the-loop flow.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ProgressNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createShim, type Shim } from './shim.js'
import type { McpAuth, ShimEnv } from './paths.js'

const SE: ShimEnv = {
  platform: 'win32',
  env: {},
  execPath: 'C:\\Program Files\\WeftCut\\WeftCut.exe',
  scriptPath: 'C:\\ud\\cli\\weftcut-mcp.cjs',
  homedir: 'C:\\Users\\u',
}
const AUTH: McpAuth = { token: 'tok', port: 4711 }

/// What the fake app's `read_project { view: "session" }` answers; undefined
/// leaves read_project a plain pass-through like every other tool.
let appSession: Record<string, unknown> | undefined

/// What the fake app saw of its `slow` / `heartbeat` calls: each call's
/// cancellation signal and the progress token it was addressed with, plus the
/// release for every `slow` call still hanging.
let appCalls: { signal: AbortSignal; progressToken: unknown }[] = []
let hanging: (() => void)[] = []

function fakeAppServer(): Server {
  const s = new Server(
    { name: 'weftcut', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'add_marker', description: 'Add a marker.', inputSchema: { type: 'object' as const } }],
  }))
  s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    // The session view, when a test has set what the app has open.
    if (req.params.name === 'read_project' && appSession !== undefined) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(appSession) }], structuredContent: appSession }
    }
    if (req.params.name === 'slow' || req.params.name === 'heartbeat') {
      const progressToken = req.params._meta?.progressToken
      appCalls.push({ signal: extra.signal, progressToken })
      if (req.params.name === 'slow') {
        // A job that outlives any test timeout: settles only on release or cancel.
        await new Promise<void>((r) => {
          hanging.push(r)
          extra.signal.addEventListener('abort', () => r())
        })
      } else {
        // Five beats 30 ms apart: 150 ms of work, never 80 ms of silence.
        for (let i = 1; i <= 5; i++) {
          await new Promise((r) => setTimeout(r, 30))
          if (progressToken !== undefined) {
            await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: i, total: 5 } })
          }
        }
      }
      return { content: [{ type: 'text' as const, text: `done:${req.params.name}` }] }
    }
    return { content: [{ type: 'text' as const, text: `called:${req.params.name}` }] }
  })
  s.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'project://current', name: 'project' }],
  }))
  s.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'auto-caption' }],
  }))
  return s
}

interface Harness {
  client: Client
  shim: Shim
  /// Notification methods the stdio-side client received, in order.
  notified: string[]
  /// Flip to false to make the next bridge connect fail (app "not running").
  setAppUp(up: boolean): void
  /// The app stops answering anything (requests and pings) without closing.
  freeze(): void
  appServer(): Server | null
  close(): Promise<void>
}

async function harness(opts: {
  appUp: boolean
  auth?: McpAuth | null
  spawnApp?: (p: string) => void
  launchTimeoutMs?: number
  env?: Record<string, string>
}): Promise<Harness> {
  let up = opts.appUp
  let frozen = false
  let app: Server | null = null
  const makeTransport = (_auth: McpAuth): Transport => {
    if (!up) throw new Error('ECONNREFUSED')
    app = fakeAppServer()
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    void app.connect(serverT)
    const send = clientT.send.bind(clientT)
    clientT.send = (m, o) => (frozen ? Promise.resolve() : send(m, o))
    return clientT
  }
  const shim = createShim({
    se: { ...SE, env: opts.env ?? {} },
    userDataDir: 'C:\\ud',
    readAuth: () => (opts.auth === undefined ? AUTH : opts.auth),
    makeTransport,
    ...(opts.spawnApp ? { spawnApp: opts.spawnApp } : {}),
    launchTimeoutMs: opts.launchTimeoutMs ?? 300,
    launchPollMs: 20,
    probeTimeoutMs: 100,
  })
  const notified: string[] = []
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async (n) => {
    notified.push(n.method)
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await shim.server.connect(serverT)
  await client.connect(clientT)
  return {
    client,
    shim,
    notified,
    setAppUp: (v) => {
      up = v
    },
    freeze: () => {
      frozen = true
    },
    appServer: () => app,
    close: async () => {
      await client.close().catch(() => {})
      await shim.server.close().catch(() => {})
      shim.bridge.markDown()
    },
  }
}

let open: Harness | null = null
afterEach(async () => {
  await open?.close()
  open = null
  appSession = undefined
  for (const r of hanging.splice(0)) r()
  appCalls = []
})

const settle = () => new Promise((r) => setTimeout(r, 25))

describe('down state', () => {
  it('lists exactly the synthetic tools, and empty resources/prompts', async () => {
    open = await harness({ appUp: false })
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut'])
    expect((await open.client.listResources()).resources).toEqual([])
    expect((await open.client.listPrompts()).prompts).toEqual([])
  })

  it('a real tool call fails with an actionable message naming the endpoint and launch_weftcut', async () => {
    open = await harness({ appUp: false })
    const err = await open.client
      .callTool({ name: 'add_marker', arguments: {} })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpError)
    const msg = (err as McpError).message
    expect(msg).toContain('http://127.0.0.1:4711/mcp')
    expect(msg).toContain('launch_weftcut')
  })

  it('with no auth file the error says the app has never been launched', async () => {
    open = await harness({ appUp: false, auth: null })
    const err = await open.client
      .callTool({ name: 'add_marker', arguments: {} })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((err as McpError).message).toContain('never been launched')
    const status = await open.client.callTool({ name: 'weftcut_status', arguments: {} })
    expect(JSON.stringify(status.content)).toContain('never been launched')
  })

  it('weftcut_status reports not-running with next steps', async () => {
    open = await harness({ appUp: false })
    const status = await open.client.callTool({ name: 'weftcut_status', arguments: {} })
    const text = JSON.stringify(status.content)
    expect(text).toContain('not running')
    expect(text).toContain('launch_weftcut')
  })
})

describe('up state', () => {
  it('lists synthetic ∪ real and passes tool calls through', async () => {
    open = await harness({ appUp: true })
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut', 'add_marker'])
    const result = await open.client.callTool({ name: 'add_marker', arguments: { t_us: 1 } })
    expect(JSON.stringify(result.content)).toContain('called:add_marker')
    expect((await open.client.listResources()).resources).toHaveLength(1)
    expect((await open.client.listPrompts()).prompts).toHaveLength(1)
  })

  it('forwards the app change feed to the stdio client', async () => {
    open = await harness({ appUp: true })
    await open.client.listTools() // establishes the bridge
    await open.appServer()!.notification({
      method: 'notifications/weftcut/change',
      params: { summary: 'moved a clip' },
    })
    await settle()
    expect(open.notified).toContain('notifications/weftcut/change')
  })

  it('weftcut_status reports running', async () => {
    open = await harness({ appUp: true })
    const status = await open.client.callTool({ name: 'weftcut_status', arguments: {} })
    expect(JSON.stringify(status.content)).toContain('WeftCut is running')
  })

  it('weftcut_status names the open project, or says none is open', async () => {
    appSession = { project: { name: 'Demo', dir: '/p/Demo' } }
    open = await harness({ appUp: true })
    const named = await open.client.callTool({ name: 'weftcut_status', arguments: {} }) as { content: Array<{ text: string }> }
    expect(named.content[0].text).toContain('Project: Demo (/p/Demo)')
    appSession = { project: null }
    const none = await open.client.callTool({ name: 'weftcut_status', arguments: {} }) as { content: Array<{ text: string }> }
    expect(none.content[0].text).toContain('Project: none open')
    expect(none.content[0].text).toContain('open_project')
  })
})

describe('transitions', () => {
  it('app dies mid-session → list_changed fires and the catalog degrades to synthetic-only', async () => {
    open = await harness({ appUp: true })
    await open.client.listTools()
    open.setAppUp(false)
    await open.appServer()!.close() // bridge onclose → markDown → broadcast
    await settle()
    expect(open.notified).toContain('notifications/tools/list_changed')
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut'])
  })

  it('app comes up mid-session → next list upgrades and list_changed fires', async () => {
    open = await harness({ appUp: false })
    expect((await open.client.listTools()).tools).toHaveLength(2)
    open.setAppUp(true)
    // The list handler's opportunistic ensureUp performs the upgrade itself.
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('add_marker')
    await settle()
    expect(open.notified).toContain('notifications/tools/list_changed')
  })

  it('launch_weftcut spawns the app, waits for the endpoint, and closes the loop', async () => {
    let spawned: string | null = null
    open = await harness({
      appUp: false,
      spawnApp: (p) => {
        spawned = p
        open!.setAppUp(true) // "the app came up"
      },
    })
    const result = await open.client.callTool({ name: 'launch_weftcut', arguments: {} })
    expect(spawned).toBe(SE.execPath)
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('now available')
    expect((await open.client.listTools()).tools.map((t) => t.name)).toContain('add_marker')
  })

  it('launch_weftcut reports a bounded timeout when the endpoint never appears', async () => {
    let spawned = false
    open = await harness({ appUp: false, spawnApp: () => (spawned = true), launchTimeoutMs: 80 })
    const result = await open.client.callTool({ name: 'launch_weftcut', arguments: {} })
    expect(spawned).toBe(true)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('did not come up')
  })

  it('launch_weftcut on an already-running app is a no-op report', async () => {
    let spawned = false
    open = await harness({ appUp: true, spawnApp: () => (spawned = true) })
    const result = await open.client.callTool({ name: 'launch_weftcut', arguments: {} })
    expect(spawned).toBe(false)
    expect(JSON.stringify(result.content)).toContain('already running')
  })
})

describe('ending the stdio side ends the app-side SESSION, not just the connection', () => {
  // Streamable HTTP releases a session only on the client's DELETE
  // (`terminateSession`); a plain `close()` leaves the app holding the agent's
  // work session and history lock. The bridge sends the DELETE whenever it
  // marks the app down — stdin closed, a signal, or the app itself going away.
  it('markDown calls terminateSession on the transport when it has one', async () => {
    const terminateSession = vi.fn(async () => {})
    let app: Server | null = null
    const shim = createShim({
      se: SE, userDataDir: 'C:/ud', readAuth: () => AUTH,
      makeTransport: () => {
        app = fakeAppServer()
        const [clientT, serverT] = InMemoryTransport.createLinkedPair()
        void app.connect(serverT)
        return Object.assign(clientT, { terminateSession })
      },
    })
    expect(await shim.bridge.ensureUp()).toBe('up')
    shim.bridge.markDown()
    await settle()
    expect(terminateSession).toHaveBeenCalledTimes(1)
    expect(shim.bridge.isUp()).toBe(false)
    await shim.server.close().catch(() => {})
  })
})

describe('the app session carries the driving client name, not the shim', () => {
  it('a bridge opened after the client initialized is opened under its name', async () => {
    open = await harness({ appUp: true })
    await open.client.listTools()
    expect(open.appServer()?.getClientVersion()?.name).toBe('test')
  })

  it('a bridge opened before the client initialized reopens under its name', async () => {
    const apps: Server[] = []
    const shim = createShim({
      se: SE,
      userDataDir: 'C:\\ud',
      readAuth: () => AUTH,
      makeTransport: () => {
        const app = fakeAppServer()
        apps.push(app)
        const [clientT, serverT] = InMemoryTransport.createLinkedPair()
        void app.connect(serverT)
        return clientT
      },
    })
    // The poll loop's start-up connect: nobody has named themselves yet.
    expect(await shim.bridge.ensureUp()).toBe('up')
    expect(apps[0].getClientVersion()?.name).toBe('weftcut-mcp')
    const client = new Client({ name: 'claude-code', version: '1' }, { capabilities: {} })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await shim.server.connect(serverT)
    await client.connect(clientT)
    await settle()
    expect(apps).toHaveLength(2)
    expect(apps[1].getClientVersion()?.name).toBe('claude-code')
    expect(shim.bridge.isUp()).toBe(true)
    await client.close().catch(() => {})
    await shim.server.close().catch(() => {})
    shim.bridge.markDown()
  })

  it('a connect still in flight when the client initializes is reopened once it lands', async () => {
    const apps: Server[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const shim = createShim({
      se: SE,
      userDataDir: 'C:\\ud',
      readAuth: () => AUTH,
      makeTransport: () => {
        const app = fakeAppServer()
        apps.push(app)
        const [clientT, serverT] = InMemoryTransport.createLinkedPair()
        // The first connect's server answers only after the client has
        // initialized — the start-up poll racing the handshake.
        if (apps.length === 1) void gate.then(() => app.connect(serverT))
        else void app.connect(serverT)
        return clientT
      },
    })
    const polling = shim.bridge.ensureUp()
    const client = new Client({ name: 'claude-code', version: '1' }, { capabilities: {} })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await shim.server.connect(serverT)
    await client.connect(clientT)
    release()
    await polling
    await settle()
    expect(apps[0].getClientVersion()?.name).toBe('weftcut-mcp')
    expect(apps.at(-1)!.getClientVersion()?.name).toBe('claude-code')
    expect(shim.bridge.isUp()).toBe(true)
    await client.close().catch(() => {})
    await shim.server.close().catch(() => {})
    shim.bridge.markDown()
  })
})

describe('long tool calls: idle timeout, progress, cancel', () => {
  // The bug (#67): the app hop ran under the SDK's flat 60 s default, and its
  // RequestTimeout was read as "the app went away" — the bridge tore the
  // session down and the agent was told WeftCut was not running while the
  // app was still working on the call.
  const FAST = { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '80' }
  const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text

  it('timeout with a live app: a still-running tool error, the bridge stays up, the job is not cancelled', async () => {
    open = await harness({ appUp: true, env: FAST })
    await open.client.listTools()
    await settle()
    const seen = open.notified.length // the connect's own list_changed
    const result = await open.client.callTool({ name: 'slow', arguments: {} })
    expect(result.isError).toBe(true)
    const msg = textOf(result)
    expect(msg).toContain('WeftCut is running')
    expect(msg).toContain('still working inside the app')
    expect(msg).toContain('80 ms')
    expect(msg).toContain('joins the in-flight job')
    expect(msg).toContain('WEFTCUT_MCP_TOOL_TIMEOUT_MS')
    expect(msg).not.toContain('not running')
    expect(open.shim.bridge.isUp()).toBe(true)
    await settle()
    expect(appCalls).toHaveLength(1)
    expect(appCalls[0]!.signal.aborted).toBe(false)
    expect(open.notified.slice(seen)).not.toContain('notifications/tools/list_changed')
  })

  it('timeout with a dead app: not-running, and the bridge goes down', async () => {
    open = await harness({ appUp: true, env: FAST })
    await open.client.listTools()
    const pending = open.client
      .callTool({ name: 'slow', arguments: {} })
      .then(() => null)
      .catch((e: unknown) => e)
    await settle()
    open.freeze() // the app stops answering — the liveness ping included
    const err = await pending
    expect(err).toBeInstanceOf(McpError)
    expect((err as McpError).message).toContain('WeftCut is not running')
    expect(open.shim.bridge.isUp()).toBe(false)
  })

  it('the tool-call timeout comes from WEFTCUT_MCP_TOOL_TIMEOUT_MS, defaulting to 5 min', async () => {
    open = await harness({ appUp: true, env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '150' } })
    const started = Date.now()
    const result = await open.client.callTool({ name: 'slow', arguments: {} })
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(textOf(result)).toContain('150 ms')
    await open.close()
    // The 5 min default itself is pinned in paths.test.ts; here, only that an
    // unset env does not end the call early.
    open = await harness({ appUp: true })
    let done = false
    void open.client.callTool({ name: 'slow', arguments: {} }).then(
      () => (done = true),
      () => (done = true),
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(done).toBe(false)
  })

  it('a total cap applies only when WEFTCUT_MCP_TOOL_MAX_TOTAL_MS asks for one', async () => {
    open = await harness({ appUp: true, env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '80', WEFTCUT_MCP_TOOL_MAX_TOTAL_MS: '100' } })
    const result = await open.client.callTool({ name: 'heartbeat', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('WEFTCUT_MCP_TOOL_MAX_TOTAL_MS')
  })

  it('app progress re-arms the idle window and is relayed under the UPSTREAM token', async () => {
    open = await harness({ appUp: true, env: FAST })
    const relayed: unknown[] = []
    // Replace the client's own progress routing to see the raw notifications.
    open.client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
      relayed.push(n.params)
    })
    const result = await open.client.request(
      { method: 'tools/call', params: { name: 'heartbeat', arguments: {}, _meta: { progressToken: 'upstream-tok' } } },
      CallToolResultSchema,
    )
    // 150 ms of work under an 80 ms idle window: only the beats kept it alive.
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toBe('done:heartbeat')
    expect(relayed).toHaveLength(5)
    expect(relayed[4]).toEqual({ progressToken: 'upstream-tok', progress: 5, total: 5 })
    // The app hop runs under the SDK's own token, not the stdio client's.
    expect(appCalls[0]!.progressToken).toBeDefined()
    expect(appCalls[0]!.progressToken).not.toBe('upstream-tok')
  })

  it('app progress re-arms the idle window even when the client asked for none', async () => {
    open = await harness({ appUp: true, env: FAST })
    const result = await open.client.callTool({ name: 'heartbeat', arguments: {} })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toBe('done:heartbeat')
  })

  it('an upstream cancel cancels the app-side call and leaves the bridge up', async () => {
    open = await harness({ appUp: true, env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '5000' } })
    await open.client.listTools()
    await settle()
    const seen = open.notified.length
    const ac = new AbortController()
    const pending = open.client
      .callTool({ name: 'slow', arguments: {} }, CallToolResultSchema, { signal: ac.signal })
      .catch(() => 'cancelled')
    await settle()
    expect(appCalls).toHaveLength(1)
    ac.abort('user pressed stop')
    expect(await pending).toBe('cancelled')
    await settle()
    expect(appCalls[0]!.signal.aborted).toBe(true)
    expect(open.shim.bridge.isUp()).toBe(true)
    expect(open.notified.slice(seen)).not.toContain('notifications/tools/list_changed')
    // And the session is still good for the next call.
    const next = await open.client.callTool({ name: 'add_marker', arguments: {} })
    expect(textOf(next)).toBe('called:add_marker')
  })

  it('the stdio client going away does not cancel the app-side call', async () => {
    // The SDK aborts every handler signal on transport close as well; only an
    // explicit notifications/cancelled may reach the app as a cancel.
    open = await harness({ appUp: true, env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '5000' } })
    void open.client.callTool({ name: 'slow', arguments: {} }).catch(() => {})
    await settle()
    expect(appCalls).toHaveLength(1)
    await open.client.close()
    await settle()
    expect(appCalls[0]!.signal.aborted).toBe(false)
  })
})
