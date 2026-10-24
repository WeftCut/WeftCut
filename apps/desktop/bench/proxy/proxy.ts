// apps/desktop/bench/proxy/proxy.ts
//
// The MCP proxy between the agent and a REMOTE app host (README "Remote app
// host"). The agent runs here and writes its Motif working folders in a local
// directory; the app runs on another machine and can only open files on its
// own disk. Facing the agent: an MCP SDK server over streamable HTTP. Facing
// the app: an MCP SDK client over streamable HTTP. In between, two things and
// nothing else:
//
//   1. Before forwarding any tools/call, the local workdir is mirrored to the
//      run's remote directory (mirror.mjs), synchronously, so the app sees
//      what the agent last wrote.
//   2. tools/call arguments that are paths inside the workdir become the
//      mirror's Windows paths; mirror paths in tools/call and resources/read
//      results go back to local paths (pathmap.mjs). Each rewrite is logged.
//
// Every other request and notification, in both directions, is forwarded as
// is through the SDK's fallback handlers: no per-method schema re-validates or
// reshapes the app's answers. Progress is relayed under the agent's own token.
// Each agent session gets its own upstream session, opened with the agent's
// clientInfo and capabilities, so the app attributes the work to the agent's
// client exactly as it would without the proxy.

import { randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { McpError, ResultSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createPathMap } from './pathmap.mjs'

export interface ProxyOptions {
  upstream: { url: string; bearer_token: string; fetch?: typeof fetch }
  /** The agent's working directory (POSIX) and its mirror on the app host. */
  localRoot: string
  remoteRoot: string
  /** Mirror the workdir; resolves once the remote side matches. */
  sync: () => Promise<{ mkdirs: string[]; puts: string[]; rmFiles: string[]; rmDirs: string[] }>
  /** One JSON-able record per event (sync, rewrite, outside, gated, error). */
  log: (entry: Record<string, unknown>) => void
  /** Asked before each tools/call is forwarded, with whether the app's tool
   *  list marks the tool read-only. A string refuses the call: the agent gets
   *  it as the tool's error, and the app never sees the call. */
  gate?: (tool: string, readOnly: boolean) => string | null
}

export interface ProxyStats { tool_calls: number; syncs_pushed: number; to_remote: number; to_local: number; outside: number; gated: number }

export interface McpProxy {
  endpoint: { url: string; bearer_token: string }
  stats: ProxyStats
  close(): Promise<void>
}

interface Session { transport: StreamableHTTPServerTransport; server: Server; client: Client }

type Forwardable = { method: string; params?: Record<string, unknown> }
type Extra = { signal: AbortSignal; sendNotification: (n: { method: string; params?: Record<string, unknown> }) => Promise<void> }

/** An McpError from the app, re-thrown with its own code, message and data:
 *  the SDK would otherwise send the agent "MCP error -32602: MCP error -32602: …". */
function passthroughError(e: unknown): unknown {
  if (!(e instanceof McpError)) return e
  const err = new Error(e.message.replace(/^MCP error -?\d+: /, '')) as Error & { code: number; data?: unknown }
  err.code = e.code
  if (e.data !== undefined) err.data = e.data
  return err
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => { s += c })
    req.on('end', () => resolve(s))
    req.on('error', reject)
  })
}

export async function startMcpProxy(opts: ProxyOptions): Promise<McpProxy> {
  const token = randomBytes(32).toString('hex')
  const map = createPathMap({ localRoot: opts.localRoot, remoteRoot: opts.remoteRoot })
  const sessions = new Map<string, Session>()
  const stats: ProxyStats = { tool_calls: 0, syncs_pushed: 0, to_remote: 0, to_local: 0, outside: 0, gated: 0 }
  // Read-only tools, as the app's tool list last said.
  const readOnly = new Set<string>()
  const log = (kind: string, fields: Record<string, unknown>) => opts.log({ t: new Date().toISOString(), kind, ...fields })

  async function openSession(init: { clientInfo: { name: string; version: string }; capabilities?: Record<string, unknown> }): Promise<Session> {
    let server: Server | undefined
    const client = new Client(init.clientInfo, { capabilities: init.capabilities ?? {} })
    // App → agent: requests (roots/list, sampling, elicitation) and notifications.
    client.fallbackRequestHandler = async (request, extra) =>
      server!.request({ method: request.method, params: request.params }, ResultSchema, { signal: extra.signal })
    client.fallbackNotificationHandler = async (n) => {
      await server?.notification(n as never).catch((e: Error) => log('error', { where: 'notify-agent', method: n.method, error: e.message }))
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(opts.upstream.url), {
      requestInit: { headers: { Authorization: `Bearer ${opts.upstream.bearer_token}` } },
      ...(opts.upstream.fetch ? { fetch: opts.upstream.fetch } : {}),
    }))
    const instructions = client.getInstructions()
    server = new Server(client.getServerVersion() ?? { name: 'weftcut', version: '0' }, {
      capabilities: client.getServerCapabilities() ?? {},
      ...(instructions ? { instructions } : {}),
    })

    const forward = async (request: Forwardable, extra: Extra): Promise<Record<string, unknown>> => {
      const progressToken = (request.params?._meta as { progressToken?: string | number } | undefined)?.progressToken
      try {
        return await client.request({ method: request.method, params: request.params } as never, ResultSchema, {
          signal: extra.signal,
          // The agent's own client bounds the call; transcription and frame
          // description can run for many minutes between results.
          timeout: 6 * 60 * 60_000,
          resetTimeoutOnProgress: true,
          ...(progressToken !== undefined
            ? { onprogress: (p) => { void extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken } }) } }
            : {}),
        })
      } catch (e) {
        throw passthroughError(e)
      }
    }

    // Agent → app: everything, through one handler, so nothing is reshaped.
    server.fallbackRequestHandler = async (request, extra) => {
      const req = { method: request.method, params: request.params as Record<string, unknown> | undefined }
      if (req.method === 'tools/call') {
        stats.tool_calls++
        const tool = String(req.params?.name ?? '')
        const refusal = opts.gate?.(tool, readOnly.has(tool)) ?? null
        if (refusal !== null) {
          stats.gated++
          log('gated', { tool })
          return { isError: true, content: [{ type: 'text', text: refusal }] }
        }
        const started = Date.now()
        const plan = await opts.sync()
        const pushed = plan.mkdirs.length + plan.puts.length + plan.rmFiles.length + plan.rmDirs.length
        if (pushed) {
          stats.syncs_pushed++
          log('sync', { tool, ms: Date.now() - started, ...plan })
        }
        const mapped = map.toRemote(req.params?.arguments ?? {})
        for (const r of mapped.rewrites) { stats.to_remote++; log('rewrite', { tool, ...r }) }
        for (const o of mapped.outside) { stats.outside++; log('outside', { tool, value: o.value }) }
        const result = await forward({ method: req.method, params: { ...req.params, arguments: mapped.value } }, extra as Extra)
        const back = map.toLocal(result)
        for (const r of back.rewrites) { stats.to_local++; log('rewrite', { tool, ...r }) }
        return back.value as Record<string, unknown>
      }
      if (req.method === 'resources/read') {
        const back = map.toLocal(await forward(req, extra as Extra))
        for (const r of back.rewrites) { stats.to_local++; log('rewrite', { resource: req.params?.uri, ...r }) }
        return back.value as Record<string, unknown>
      }
      if (req.method === 'tools/list') {
        const listed = await forward(req, extra as Extra)
        for (const t of (listed.tools ?? []) as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>) {
          if (t.annotations?.readOnlyHint) readOnly.add(t.name)
          else readOnly.delete(t.name)
        }
        return listed
      }
      return forward(req, extra as Extra)
    }
    server.fallbackNotificationHandler = async (n) => {
      await client.notification(n as never).catch((e: Error) => log('error', { where: 'notify-app', method: n.method, error: e.message }))
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, session) },
    })
    const session: Session = { transport, server, client }
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
      void client.close().catch(() => {})
    }
    await server.connect(transport)
    log('session', { client: init.clientInfo })
    return session
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
        if (new URL(req.url ?? '/', 'http://proxy').pathname !== '/mcp') { res.writeHead(404).end(); return }
        const body: unknown = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined
        const sid = req.headers['mcp-session-id']
        let session = typeof sid === 'string' ? sessions.get(sid) : undefined
        if (!session) {
          if (typeof sid === 'string' || req.method !== 'POST' || !isInitializeRequest(body)) {
            res.writeHead(typeof sid === 'string' ? 404 : 400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: typeof sid === 'string' ? 'Session not found' : 'Bad Request: no session' }, id: null }))
            return
          }
          session = await openSession(body.params as never)
        }
        await session.transport.handleRequest(req, res, body)
      } catch (e) {
        log('error', { where: 'http', error: e instanceof Error ? e.message : String(e) })
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`proxy: ${String(e)}`)
        else res.end()
      }
    })()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = (httpServer.address() as AddressInfo).port
  log('listening', { port, local_root: map.local, remote_root: map.remote })

  return {
    endpoint: { url: `http://127.0.0.1:${port}/mcp`, bearer_token: token },
    stats,
    async close() {
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => {})
        await s.client.close().catch(() => {})
      }
      sessions.clear()
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
