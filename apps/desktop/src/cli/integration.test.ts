// End-to-end over real transports: esbuild-bundle the shim (the same build
// scripts/build-cli.mjs ships), spawn it as a child process on stdio, and
// bridge it to a real express + StreamableHTTPServerTransport fake app — the
// same server shape the Electron main process hosts. Proves the packaged
// artefact works: stdio framing, WEFTCUT_USERDATA discovery, bearer auth,
// catalog union, and the down-state degradation. A second app, the real
// `buildMcpServer`, is the other side of the parity gate: every request a
// client can send answers the same through the shim as HTTP-direct.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ClientRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ResultSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { mcpInstructions } from '../main/mcp/instructions.js'
import { buildMcpServer } from '../main/mcp/server.js'
import { createActor } from '../main/state/actor.js'
import { uuidV7Gen } from '../main/state/ids.js'
import { blankProject } from '../main/state/model.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'itest-token'
/// The version stamp scripts/build-cli.mjs defines from package.json.
const STAMP = '9.8.7'

let tmp: string
let bundle: string
let http: HttpServer | null = null

/// The fake app's whole surface: one tool.
function fakeAppServer(): Server {
  const server = new Server({ name: 'weftcut', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'add_marker', description: 'Add a marker.', inputSchema: { type: 'object' as const } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (r) => ({
    content: [{ type: 'text' as const, text: `called:${r.params.name}` }],
  }))
  return server
}

/// Minimal replica of src/main/mcp/index.ts hosting: bearer-gated /mcp with
/// one streamable-HTTP session, and one `makeServer()`, per initialize.
async function hostApp(makeServer: () => Server): Promise<HttpServer> {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/mcp', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
      return
    }
    next()
  })
  const transports = new Map<string, StreamableHTTPServerTransport>()
  app.all('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? transports.get(sid) : undefined
    if (transport) {
      await transport.handleRequest(req, res, req.body)
      return
    }
    if (!sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!)
        },
      })
      await makeServer().connect(transport as Transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'no session' }, id: null })
  })
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
}

const portOf = (s: HttpServer): number => (s.address() as { port: number }).port

/// Spawn the built bundle on stdio, run `use`, tear the child down.
async function withShimClient<T>(use: (client: Client) => Promise<T>, userData = tmp): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { ...process.env, WEFTCUT_USERDATA: userData } as Record<string, string>,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'itest', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  try {
    return await use(client)
  } finally {
    await client.close().catch(() => {})
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-shim-itest-'))
  bundle = path.join(tmp, 'weftcut-mcp.cjs')
  await build({
    entryPoints: [path.join(HERE, 'main.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    define: { __WEFTCUT_VERSION__: JSON.stringify(STAMP) },
    logLevel: 'silent',
  })
  http = await hostApp(fakeAppServer)
  const port = portOf(http)
  fs.writeFileSync(path.join(tmp, 'mcp_auth.json'), JSON.stringify({ token: TOKEN, port }))
}, 30_000)

afterAll(() => {
  http?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('bundled shim over real stdio + HTTP', () => {
  it('serves synthetic ∪ real and passes calls through (bearer included)', async () => {
    await withShimClient(async (client) => {
      // The etiquette rides the bundle, at the stamped version.
      expect(client.getInstructions()).toBe(mcpInstructions(STAMP))
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut', 'add_marker'])
      const result = await client.callTool({ name: 'add_marker', arguments: {} })
      expect(JSON.stringify(result.content)).toContain('called:add_marker')
    })
  }, 20_000)

  it('degrades to the synthetic surface when the app goes away', async () => {
    const port = portOf(http!)
    http!.close()
    http = null
    // Auth file still names the (now-dead) port — the down-with-auth shape.
    fs.writeFileSync(path.join(tmp, 'mcp_auth.json'), JSON.stringify({ token: TOKEN, port }))
    await withShimClient(async (client) => {
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut'])
      // The listings answer empty rather than fail: nothing to list until the app is up.
      expect((await client.listResources()).resources).toEqual([])
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
      const status = await client.callTool({ name: 'weftcut_status', arguments: {} })
      expect(JSON.stringify(status.content)).toContain('not running')
    })
  }, 20_000)

  it('print-config emits the machine-specific stdio fragment', () => {
    const out = spawnSync(process.execPath, [bundle, 'print-config'], {
      encoding: 'utf8',
      env: { ...process.env, WEFTCUT_USERDATA: tmp },
    })
    const parsed = JSON.parse(out.stdout) as {
      mcpServers: { weftcut: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(parsed.mcpServers.weftcut.args).toEqual([bundle])
    expect(parsed.mcpServers.weftcut.env.WEFTCUT_USERDATA).toBe(tmp)
    expect(JSON.stringify(parsed)).not.toContain(TOKEN)
  }, 20_000)
})

// The drift gate: the shim is a hand-written forwarder, so a request method the
// app learns to answer stays MethodNotFound through the shim until someone adds
// the twin handler. Every request the SDK lets a client send goes to the real
// app session both ways and must come back the same.
describe('the shim answers every client request as the app does', () => {
  const RUST_CATALOG = fs.readFileSync(path.join(HERE, '../../fixtures/mcp/rust-catalog-snapshot.json'), 'utf8')
  /// The shim's own tools, left out when its tools/list is compared.
  const SYNTHETIC = new Set(['weftcut_status', 'launch_weftcut'])

  /// Every member of the SDK's ClientRequestSchema, classified. `compare`
  /// carries the params it is sent with; a method the SDK adds fails the gate
  /// until it is classified here.
  const CLIENT_REQUESTS: Record<string, { compare: Record<string, unknown> | undefined } | { skip: string }> = {
    // Each hop answers its own handshake: the shim's capabilities and
    // instructions are its own, and its instructions are checked above.
    initialize: { skip: 'answered by each hop itself' },
    ping: { compare: undefined },
    'completion/complete': { compare: { ref: { type: 'ref/prompt', name: 'cut-pauses' }, argument: { name: 'clip', value: '' } } },
    'logging/setLevel': { compare: { level: 'info' } },
    'prompts/get': { compare: { name: 'cut-pauses', arguments: { clip: 'Interview A' } } },
    'prompts/list': { compare: {} },
    'resources/list': { compare: {} },
    'resources/templates/list': { compare: {} },
    'resources/read': { compare: { uri: 'project://settings' } },
    'resources/subscribe': { compare: { uri: 'project://settings' } },
    'resources/unsubscribe': { compare: { uri: 'project://settings' } },
    'tools/call': { compare: { name: 'read_project', arguments: { view: 'tracks' } } },
    'tools/list': { compare: {} },
    'tasks/get': { compare: { taskId: 'task-1' } },
    'tasks/result': { compare: { taskId: 'task-1' } },
    'tasks/list': { compare: {} },
    'tasks/cancel': { compare: { taskId: 'task-1' } },
  }

  let appHttp: HttpServer
  let appData: string

  /// The app session `main/mcp/index.ts` builds, over one project actor shared
  /// by every session as in the app, and a backend that answers from the
  /// committed Rust catalog in place of the native addon. Prompt and resource
  /// reads echo what they were asked, so equal results also mean equal params
  /// reached the app.
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'parity'), idGen, clock: () => '<TS>' })
  const host = { actor, mcpCall: (n: string, a: string) => actor.mcpCall(n, a), motifTool: () => [] }
  function realAppServer(): Server {
    const backend = {
      mcpCatalog: async () => RUST_CATALOG,
      mcpListPrompts: async () => JSON.stringify(JSON.parse(RUST_CATALOG).prompts),
      mcpGetPrompt: async (name: string, args: string) =>
        JSON.stringify({ ok: true, result: { messages: [{ role: 'user', content: { type: 'text', text: `${name} ${args}` } }] } }),
      mcpReadResource: async (uri: string) =>
        JSON.stringify({ ok: true, result: { contents: [{ uri, mimeType: 'text/plain', text: uri }] } }),
      mcpCallTool: async () => { throw new Error('no native tool is called by this gate') },
    }
    return buildMcpServer(backend as never, { getTsHost: () => host as never })
  }

  async function withDirectClient<T>(use: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${portOf(appHttp)}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    const client = new Client({ name: 'itest', version: '0' }, { capabilities: {} })
    await client.connect(transport)
    try {
      return await use(client)
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close().catch(() => {})
    }
  }

  /// A result, or the JSON-RPC error code: the message is each hop's own
  /// wording, the code is what a client branches on.
  async function outcome(client: Client, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    try {
      const result = await client.request({ method, ...(params ? { params } : {}) } as never, ResultSchema)
      if (method !== 'tools/list') return { result }
      const { tools, ...rest } = result as { tools: { name: string }[] }
      return { result: { ...rest, tools: tools.filter((t) => !SYNTHETIC.has(t.name)) } }
    } catch (e) {
      if (e instanceof McpError) return { error: e.code }
      throw e
    }
  }

  async function outcomes(client: Client): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>()
    for (const [method, entry] of Object.entries(CLIENT_REQUESTS)) {
      if ('compare' in entry) out.set(method, await outcome(client, method, entry.compare))
    }
    return out
  }

  beforeAll(async () => {
    appHttp = await hostApp(realAppServer)
    appData = path.join(tmp, 'real-app')
    fs.mkdirSync(appData)
    fs.writeFileSync(path.join(appData, 'mcp_auth.json'), JSON.stringify({ token: TOKEN, port: portOf(appHttp) }))
  })

  afterAll(() => {
    appHttp.close()
  })

  it('every client request the SDK defines is classified', () => {
    const sdk = ClientRequestSchema.options.map((s) => s.shape.method.value as string).sort()
    const classified = Object.keys(CLIENT_REQUESTS).sort()
    expect(
      sdk.filter((m) => !classified.includes(m)),
      'the SDK defines client requests this gate does not know: add each to CLIENT_REQUESTS (and a shim handler if the app answers it)',
    ).toEqual([])
    expect(classified.filter((m) => !sdk.includes(m)), 'CLIENT_REQUESTS names methods the SDK no longer defines').toEqual([])
  })

  it('through the shim, each request answers what HTTP-direct answers', async () => {
    const direct = await withDirectClient(outcomes)
    const shimmed = await withShimClient(outcomes, appData)
    // The gate compares something only if the app really answers: a real
    // catalog, not two empty sides.
    expect(direct.get('tools/list')).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'read_project' })]) } })
    for (const method of direct.keys()) expect.soft(shimmed.get(method), method).toEqual(direct.get(method))
  }, 30_000)
})
