// apps/desktop/bench/proxy/proxy.test.mjs — `node --test bench/proxy/proxy.test.mjs`
//
// The proxy against a stand-in app: an MCP server over streamable HTTP that
// echoes what it was sent and answers with paths on "its" disk.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, ReadResourceRequestSchema, isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { startMcpProxy } from './proxy.ts'

const LOCAL = '/tmp/bench-proxy-test/work'
const REMOTE = 'C:\\Users\\iClass\\weftcut-bench\\runs\\r1\\work'
const APP_TOKEN = 'app-token'

/** A stand-in app. `events` records what it saw, in order. */
async function fakeApp(events) {
  const transports = new Map()
  const httpServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${APP_TOKEN}`) { res.writeHead(401).end(); return }
    let body
    if (req.method === 'POST') {
      let s = ''
      for await (const c of req) s += c
      body = JSON.parse(s)
    }
    const sid = req.headers['mcp-session-id']
    let t = sid ? transports.get(sid) : undefined
    if (!t && isInitializeRequest(body)) {
      const server = new Server({ name: 'fake-weftcut', version: '9.9' }, { capabilities: { tools: {}, resources: {} }, instructions: 'be nice' })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'open_motif_draft', inputSchema: { type: 'object' } }] }))
      server.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
        events.push({ at: 'app', tool: r.params.name, args: r.params.arguments, client: server.getClientVersion() })
        if (r.params.name === 'refuse') throw new McpError(ErrorCode.InvalidParams, 'no such draft', { field: 'id' })
        if (r.params.name === 'slow') {
          const token = r.params._meta?.progressToken
          for (let i = 1; i <= 2; i++) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 2 } })
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ dir: `${REMOTE}\\callout`, note: `opened ${REMOTE}\\callout` }) }],
          structuredContent: { draft_id: 'd1', path: `${REMOTE}\\callout`, project: 'C:\\elsewhere\\p' },
        }
      })
      server.setRequestHandler(ReadResourceRequestSchema, async (r) => ({
        contents: [{ uri: r.params.uri, mimeType: 'application/json', text: JSON.stringify({ linked_dir: `${REMOTE}\\callout` }) }],
      }))
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => transports.set(id, t) })
      await server.connect(t)
    }
    if (!t) { res.writeHead(400).end(); return }
    await t.handleRequest(req, res, body)
  })
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${httpServer.address().port}/mcp`,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => {})
      httpServer.closeAllConnections()
      await new Promise((r) => httpServer.close(r))
    },
  }
}

test('proxy: sync before call, rewrites both ways, passthrough of the rest', async () => {
  const events = []
  const app = await fakeApp(events)
  const logs = []
  let syncs = 0
  const proxy = await startMcpProxy({
    upstream: { url: app.url, bearer_token: APP_TOKEN },
    localRoot: LOCAL, remoteRoot: REMOTE,
    sync: async () => {
      syncs++
      events.push({ at: 'sync' })
      return syncs === 1 ? { mkdirs: ['callout'], puts: ['callout/motif.json'], rmFiles: [], rmDirs: [] } : { mkdirs: [], puts: [], rmFiles: [], rmDirs: [] }
    },
    log: (e) => logs.push(e),
  })
  const agent = new Client({ name: 'claude-code', version: '2.0.0' }, { capabilities: {} })
  try {
    // The proxy's own bearer, not the app's.
    const anon = await fetch(proxy.endpoint.url, { method: 'POST', body: '{}' })
    assert.equal(anon.status, 401)

    await agent.connect(new StreamableHTTPClientTransport(new URL(proxy.endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${proxy.endpoint.bearer_token}` } },
    }))
    assert.equal(agent.getServerVersion()?.name, 'fake-weftcut', 'server identity mirrored')
    assert.equal(agent.getInstructions(), 'be nice', 'instructions mirrored')
    assert.deepEqual((await agent.listTools()).tools.map((t) => t.name), ['open_motif_draft'])

    const r = await agent.callTool({ name: 'open_motif_draft', arguments: { source: { kind: 'directory', path: `${LOCAL}/callout` }, other: '/home/x/y.png' } })
    const seen = events.filter((e) => e.at === 'app')[0]
    assert.deepEqual(seen.args, { source: { kind: 'directory', path: `${REMOTE}\\callout` }, other: '/home/x/y.png' })
    assert.deepEqual(seen.client, { name: 'claude-code', version: '2.0.0' }, 'the app sees the agent client, not the proxy')
    assert.deepEqual(events.slice(0, 2).map((e) => e.at), ['sync', 'app'], 'mirror runs before the call is forwarded')
    assert.deepEqual(r.structuredContent, { draft_id: 'd1', path: `${LOCAL}/callout`, project: 'C:\\elsewhere\\p' })
    assert.deepEqual(JSON.parse(r.content[0].text), { dir: `${LOCAL}/callout`, note: `opened ${LOCAL}/callout` })

    const res = await agent.readResource({ uri: 'motifs://current' })
    assert.deepEqual(JSON.parse(res.contents[0].text), { linked_dir: `${LOCAL}/callout` })

    const progress = []
    await agent.callTool({ name: 'slow', arguments: {} }, undefined, { onprogress: (p) => progress.push(p.progress) })
    assert.deepEqual(progress, [1, 2], 'progress relayed under the agent token')

    // A JSON-RPC error reaches the agent exactly as it would directly.
    const direct = new Client({ name: 'direct', version: '1' }, { capabilities: {} })
    await direct.connect(new StreamableHTTPClientTransport(new URL(app.url), { requestInit: { headers: { Authorization: `Bearer ${APP_TOKEN}` } } }))
    const directErr = await direct.callTool({ name: 'refuse', arguments: {} }).catch((e) => e)
    await direct.close()
    const proxiedErr = await agent.callTool({ name: 'refuse', arguments: {} }).catch((e) => e)
    assert.equal(proxiedErr.code, ErrorCode.InvalidParams)
    assert.equal(proxiedErr.message, directErr.message)
    assert.deepEqual(proxiedErr.data, { field: 'id' })

    assert.equal(proxy.stats.tool_calls, 3)
    assert.equal(proxy.stats.syncs_pushed, 1)
    const kinds = logs.map((l) => l.kind)
    assert.ok(kinds.includes('sync') && kinds.includes('rewrite') && kinds.includes('outside'))
    assert.ok(logs.some((l) => l.kind === 'rewrite' && l.dir === 'to-remote' && l.to === `${REMOTE}\\callout`))
    assert.ok(logs.some((l) => l.kind === 'outside' && l.value === '/home/x/y.png'))
  } finally {
    await agent.close().catch(() => {})
    await proxy.close()
    await app.close()
  }
})
