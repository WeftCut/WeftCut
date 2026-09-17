import express from 'express'
import { app } from 'electron'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { buildMcpServer, type McpServerOptions } from './server.js'
import { loadOrInitAuth, saveAuth, rotateToken, type McpAuth } from './auth.js'
import { listenLoopback } from './bind.js'
import { NO_MCP_LOG, type McpLogEntryInput } from './withLog.js'
import type { AgentConnection, AgentConnectionSnapshot } from '../../shared/agent-activity.js'

type Backend = import('@weftcut/core').Backend

export interface McpInfoView {
  bind: string
  url: string
  bearer_token: string
}

export interface McpHost {
  getInfo(): McpInfoView
  connectionSnapshot(): AgentConnectionSnapshot
  resetToken(): string
  notifyChange(summary: unknown): void
  close(): Promise<void>
}

/** When a session counts as ABANDONED and is closed by the host, which is what
 *  releases its work session and history lock (`transport.onclose`).
 *
 *  Streamable HTTP has no liveness of its own: the SDK ends a session only on a
 *  client `DELETE`, which a client that exits, crashes or calls plain `close()`
 *  never sends — the audit's blocker. The signal used instead is the client's
 *  standalone SSE stream (the GET every SDK client opens right after
 *  `initialize`): while it is open the client is alive, however long it thinks;
 *  once it has been CLOSED for `graceMs` the client is gone (a reconnecting
 *  client re-opens it within seconds). A client that never opened one is judged
 *  by requests alone and closed after `idleMs` without any. Both are long enough
 *  that a live client is never cut mid-thought, and the SDK client does not
 *  recover a closed session by itself. */
export interface SessionReaperOptions {
  /** How long a session's SSE stream may stay closed before the session is. */
  graceMs?: number
  /** How long a session with NO stream may go without a request. */
  idleMs?: number
  /** How often to look. */
  sweepMs?: number
}
const REAPER_DEFAULTS: Required<SessionReaperOptions> = { graceMs: 90_000, idleMs: 30 * 60_000, sweepMs: 15_000 }

/** Host-level seams, forwarded verbatim to every per-session `buildMcpServer`. */
export type McpHostOptions = McpServerOptions & { sessionReaper?: SessionReaperOptions }

export async function startMcpHost(backend: Backend, opts: McpHostOptions = {}): Promise<McpHost> {
  let auth: McpAuth = loadOrInitAuth()
  // package.json's version, which is what every session reports in `initialize`.
  const version = opts.version ?? app.getVersion()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const servers = new Set<Server>()
  const connections = new Map<string, AgentConnection>()
  /** Per session: whether its standalone SSE stream is open, when that last
   *  changed, and when the last request arrived — the liveness the reaper below
   *  reads. `never` = the client has not opened a stream (yet). Kept here rather
   *  than on the connection record, which exists only once the client has sent
   *  `notifications/initialized`: a client that never completes the handshake
   *  still holds a session and must still be judged. */
  const streams = new Map<string, { state: 'never' | 'open' | 'closed'; changedAt: number; lastRequestAt: number }>()
  const reaper = { ...REAPER_DEFAULTS, ...(opts.sessionReaper ?? {}) }
  let available = true
  const log = opts.log ?? NO_MCP_LOG

  /** One transport-lifecycle row. Every row this producer writes is `Mcp`, so
   *  the category is fixed here and callers name only what varies. Swallows:
   *  these fire from inside SDK transport callbacks, where a throw would skip
   *  the session cleanup that follows it. */
  const emitLifecycle = (
    level: McpLogEntryInput['level'],
    source: McpLogEntryInput['source'],
    message: string,
    details?: Record<string, unknown>,
  ): void => {
    try {
      log.emit({ level, category: { kind: 'Mcp' }, source, message, ...(details ? { details } : {}) })
    } catch (err) {
      console.error('[mcp] lifecycle log emit failed', err)
    }
  }

  const appExpress = express()
  appExpress.use(express.json({ limit: '50mb' }))

  // Constant-time compare: a plain `!==` leaks timing. Not a real attack surface
  // for a 256-bit localhost token, but timingSafeEqual is the correct form.
  const bearerOk = (header: string | undefined): boolean => {
    if (typeof header !== 'string') return false
    const got = Buffer.from(header)
    const want = Buffer.from(`Bearer ${auth.token}`)
    return got.length === want.length && timingSafeEqual(got, want)
  }
  appExpress.use('/mcp', (req, res, next) => {
    if (!bearerOk(req.headers.authorization)) {
      // The highest-value row this producer writes: a loopback port probed by
      // another local process, or by a page the user visited, is otherwise
      // completely invisible. `user_agent` is what tells those two apart. The
      // Authorization header is never recorded — not here, not in `details`.
      emitLifecycle('warn', { kind: 'System' }, 'MCP request rejected: unauthorized', {
        method: req.method,
        user_agent: req.headers['user-agent'] ?? null,
      })
      res
        .status(401)
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
      return
    }
    next()
  })

  appExpress.all('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? transports.get(sid) : undefined
    if (transport) {
      const client = connections.get(sid!)
      if (client) client.last_activity_at = new Date().toISOString()
      const live = streams.get(sid!)
      if (live) live.lastRequestAt = Date.now()
      // The standalone SSE stream is the session's liveness: note it opening,
      // and note the socket closing under it — that, not a DELETE, is how a
      // client that simply went away is seen (see `SessionReaperOptions`).
      if (req.method === 'GET' && live) {
        live.state = 'open'; live.changedAt = Date.now()
        res.on('close', () => {
          const cur = streams.get(sid!)
          if (cur?.state === 'open') { cur.state = 'closed'; cur.changedAt = Date.now() }
        })
      }
      // Existing session — route straight through.
      await transport.handleRequest(req, res, req.body)
      return
    }
    // No usable existing transport: only allow a fresh initialize request.
    if (!sid && isInitializeRequest(req.body)) {
      const connectionId = randomUUID()
      let newServer: Server | undefined
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => connectionId,
        onsessioninitialized: (id) => {
          transports.set(id, transport!)
          streams.set(id, { state: 'never', changedAt: Date.now(), lastRequestAt: Date.now() })
        },
        // DNS-rebinding defense-in-depth: a malicious web page the user visits
        // can POST to our loopback port, so reject requests whose Host header
        // isn't our bind. The 256-bit bearer is still the primary gate; Origin
        // is left unrestricted so non-browser MCP clients (no/odd Origin) work.
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      })
      transport.onclose = () => {
        const sessionId = transport!.sessionId
        if (sessionId) { transports.delete(sessionId); streams.delete(sessionId) }
        if (newServer) servers.delete(newServer)
        connections.delete(connectionId)
        opts.getTsHost?.()?.agent?.end('disconnected', connectionId)
        // `Debug`, not `Info`: a client reconnecting is routine, and at `Info` it
        // would flood the console's default filter.
        emitLifecycle('debug', { kind: 'System' }, 'MCP client disconnected',
          sessionId ? { session_id: sessionId } : undefined)
      }
      // Set BEFORE connect, for two reasons. `Protocol.connect` CHAINS an
      // existing onerror/onclose rather than replacing it, so ours has to be
      // in place first; and this is the only seam the DNS-rebinding rejection
      // has — the SDK writes its own 403 from inside `handleRequest`, so the
      // express handler above never sees one.
      transport.onerror = (err: Error) => {
        const detail = typeof err?.message === 'string' ? err.message : String(err)
        // LANDMINE: the discriminator is the SDK's own wording
        // (`server/webStandardStreamableHttp.js` → `Invalid Host header: <value>`).
        // Matching a message beats copying `allowedHosts` into our middleware,
        // where the copy would drift from the transport that actually enforces
        // it — the cost is that an SDK rewording demotes the rejection into the
        // generic row below rather than losing it. The sibling
        // `Invalid Origin header:` path is unreachable: `allowedOrigins` is
        // deliberately left unset (see the transport options above).
        if (detail.startsWith('Invalid Host header:')) {
          emitLifecycle('warn', { kind: 'System' }, 'MCP request rejected: host not allowed', { error: detail })
          return
        }
        // `onerror` is a superset hook — the transport reports every protocol
        // fault through it (unacceptable Accept, unparseable JSON, unknown
        // session). Its own row, so a rejected Host is never inferred from one
        // of those. `Warn`, not `Error`: the request failed, the app did not.
        emitLifecycle('warn', { kind: 'System' }, 'MCP transport error', { error: detail })
      }
      newServer = buildMcpServer(backend, { ...opts, connectionId, version })
      servers.add(newServer)
      // `getClientVersion()` is populated while the `initialize` REQUEST is
      // handled, which precedes the `notifications/initialized` that fires this
      // — so the row carries the real agent name, not `undefined`.
      newServer.oninitialized = () => {
        const client = newServer!.getClientVersion()
        const now = new Date().toISOString()
        connections.set(connectionId, { id: connectionId, client: client?.name ?? 'MCP', version: client?.version ?? '', connected_at: now, last_activity_at: now })
        const who = client ? `${client.name}/${client.version ?? '?'}` : 'unknown'
        emitLifecycle('info', { kind: 'System' }, `MCP client connected: ${who}`, {
          ...(client ? { client_info: client } : {}),
          ...(transport!.sessionId ? { session_id: transport!.sessionId } : {}),
        })
      }
      // Cast: the SDK declares Transport.onclose as a getter typed
      // `(() => void) | undefined`, which TS won't accept against the optional
      // `onclose?: () => void` of the `Transport` interface under
      // `exactOptionalPropertyTypes`. Runtime-compatible; narrow to Transport.
      await newServer.connect(transport as Transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    // Non-init request with no/stale session — reject without allocating.
    res
      .status(400)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: null })
  })

  // The reaper: close every session whose client is judged gone, which fires
  // its `onclose` and with it the work-session and lock release. `unref` so a
  // host with no clients never keeps the process alive on its own.
  const sweep = (): void => {
    const now = Date.now()
    for (const [sid, transport] of transports) {
      const stream = streams.get(sid)
      if (!stream) continue
      const idleMs = now - stream.lastRequestAt
      const gone = stream.state === 'closed'
        ? now - stream.changedAt > reaper.graceMs
        : stream.state === 'never' && idleMs > reaper.idleMs
      if (!gone) continue
      emitLifecycle('info', { kind: 'System' }, 'MCP client gone: session closed', {
        session_id: sid, client: connections.get(sid)?.client ?? null, reason: stream.state === 'closed' ? 'stream_closed' : 'idle', idle_ms: idleMs,
      })
      // Best-effort: a transport already half-closed must not stop the sweep.
      transport.close().catch(() => {})
    }
  }
  const sweeper = setInterval(sweep, reaper.sweepMs)
  sweeper.unref()

  // The stored port is only a hint; listenLoopback explains why it goes
  // stale and why re-picking is safe for connected clients.
  const { server: http, port } = await listenLoopback(appExpress, auth.port)
  auth = { ...auth, port }
  saveAuth(auth)

  const url = `http://127.0.0.1:${port}/mcp`
  console.log(`[mcp] listening ${url}`)
  // Pre-workspace by construction — the host binds at `app.whenReady()` — so
  // this row exists only because the producer-side deferred queue holds it until
  // a workspace opens (`src/main/deferredLog.ts`).
  emitLifecycle('info', { kind: 'System' }, `MCP host listening on 127.0.0.1:${port}`, { port })
  // The connect snippet embeds the bearer token. Print it ONLY in unpackaged
  // (dev / e2e) runs — never in a packaged build, where stdout/log capture on a
  // shared machine could leak the token. The token is always available to the
  // UI via the get_mcp_info IPC.
  if (!app.isPackaged) {
    console.log(
      `[mcp] connect: ${JSON.stringify({
        mcpServers: { weftcut: { url, headers: { Authorization: `Bearer ${auth.token}` } } },
      })}`,
    )
  }

  return {
    connectionSnapshot(): AgentConnectionSnapshot {
      return { available, url, connections: [...connections.values()] }
    },
    getInfo(): McpInfoView {
      return { bind: `127.0.0.1:${port}`, url, bearer_token: auth.token }
    },
    resetToken(): string {
      auth = rotateToken(auth)
      // `source = User`: the one lifecycle row a person causes rather than a
      // client. Neither the retired nor the new token appears in it.
      emitLifecycle('info', { kind: 'User' }, 'MCP bearer token rotated')
      return auth.token
    },
    notifyChange(summary): void {
      for (const server of servers) {
        server
          .notification({
            method: 'notifications/weftcut/change',
            params: summary as Record<string, unknown>,
          })
          .catch(() => {
            /* session may have closed */
          })
      }
    },
    async close(): Promise<void> {
      available = false
      clearInterval(sweeper)
      for (const t of transports.values()) await t.close().catch(() => {})
      http.close()
    },
  }
}
