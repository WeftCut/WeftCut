// The side-panel view's tools and HTML over the wire: listed only to a client
// that shows MCP Apps views, answered with no project open, and the view's
// own calls never recorded as the agent's.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from './server'
import { AgentActivityService } from '../agent/activity'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { PANEL_ENTRY_TOOL, PANEL_SYNC_TOOL, PANEL_URI } from '../companion/panelEntry'
import { PanelSyncArgError } from '../companion/panelSync'
import { AGENT_ACTIVITY_EVENT } from '../../shared/agent-activity'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const PANEL_HTML = readFileSync('cli/companion/panel/panel.html', 'utf8')
const UI = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }

const backend = {
  mcpCatalog: async () => RUST_CATALOG,
  mcpCallTool: async () => { throw new Error('rust must not be called') },
  mcpReadResource: async (uri: string) => JSON.stringify({ ok: true, result: { contents: [{ uri, text: uri }] } }),
  mcpListPrompts: async () => '[]',
} as never

/** A host on its start screen, with the agent activity service recording. */
function host() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'panel'), idGen, clock: () => '<TS>' })
  const send = vi.fn()
  const agent = new AgentActivityService(actor, send)
  agent.start()
  const ts = { actor, agent, openedProject: () => null, mcpCall: (n: string, a: string) => actor.mcpCall(n, a) } as never
  const published = () => send.mock.calls.filter(([event]) => event === AGENT_ACTIVITY_EVENT).length
  return { ts, agent, published }
}

async function connect(capabilities: Record<string, unknown>, opts: { panelSync?: (args: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const h = host()
  const panelSync = opts.panelSync ?? (async (args) => ({ echoed: args }))
  const emit = vi.fn()
  const server = buildMcpServer(backend, { getTsHost: () => h.ts, panelSync, log: { emit, currentWorkspace: () => null } })
  /** The tools the request log has a row of. */
  const logged = () => emit.mock.calls.map(([entry]) => (entry as { details?: { tool?: string } }).details?.tool)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'panel-test', version: '0' }, { capabilities })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return { client, logged, ...h }
}

const VIEW_TOOLS = [PANEL_ENTRY_TOOL.name, PANEL_SYNC_TOOL.name]

describe('the side-panel view over MCP', () => {
  it('is listed only to a client that declares MCP Apps views, ahead of every other tool and resource', async () => {
    const plain = await connect({})
    const plainTools = (await plain.client.listTools()).tools.map((t) => t.name)
    expect(plainTools.filter((n) => VIEW_TOOLS.includes(n))).toEqual([])
    expect((await plain.client.listResources()).resources.map((r) => r.uri)).not.toContain(PANEL_URI)

    const viewing = await connect(UI)
    expect((await viewing.client.listTools()).tools.map((t) => t.name).slice(0, 2)).toEqual(VIEW_TOOLS)
    expect((await viewing.client.listResources()).resources[0]).toMatchObject({ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app' })
  })

  it("hides both tools from the model, and the entry names the view's address", async () => {
    const { client } = await connect(UI)
    const tools = (await client.listTools()).tools
    for (const name of VIEW_TOOLS) expect(tools.find((t) => t.name === name)?._meta).toMatchObject({ ui: { visibility: ['app'] } })
    expect(tools[0]!._meta).toMatchObject({ ui: { resourceUri: PANEL_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } })
  })

  it('serves the view by an address derived from its HTML, with no project open', async () => {
    const { client } = await connect(UI)
    const hash = createHash('sha256').update(PANEL_HTML, 'utf8').digest('hex').slice(0, 12)
    expect(PANEL_URI).toBe(`ui://weftcut/side-preview-${hash}.html`)
    const read = await client.readResource({ uri: PANEL_URI })
    expect(read.contents).toEqual([{ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: PANEL_HTML }])
    const entry = await client.callTool({ name: PANEL_ENTRY_TOOL.name, arguments: {} })
    expect(entry.isError).toBeFalsy()
  })

  it("records no agent activity and no request-log row for the view's own calls, as it does for a call the model can make", async () => {
    const { client, agent, published, logged } = await connect(UI)
    const before = { rows: agent.snapshot().activities.length, published: published() }
    const synced = await client.callTool({ name: PANEL_SYNC_TOOL.name, arguments: { op: 'state' } })
    expect(synced.structuredContent).toEqual({ echoed: { op: 'state' } })
    await client.callTool({ name: PANEL_ENTRY_TOOL.name, arguments: {} })
    expect(agent.snapshot().activities).toHaveLength(before.rows)
    expect(published()).toBe(before.published)
    expect(logged()).not.toContain(PANEL_SYNC_TOOL.name)
    expect(logged()).not.toContain(PANEL_ENTRY_TOOL.name)
    // The contrast: a tool the model sees is the agent's, and is recorded.
    await client.callTool({ name: 'open_side_preview', arguments: {} })
    expect(agent.snapshot().activities.map((a) => a.tool)).toContain('open_side_preview')
    expect(logged()).toContain('open_side_preview')
  })

  it('answers an op the view never sends as invalid params', async () => {
    const { client } = await connect(UI, { panelSync: async () => { throw new PanelSyncArgError('op must be one of …') } })
    const out = await client.callTool({ name: PANEL_SYNC_TOOL.name, arguments: { op: 'nope' } })
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params' })
  })
})
