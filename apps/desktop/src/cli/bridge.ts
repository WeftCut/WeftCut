import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError, type Progress } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_BRIDGE_TIMEOUTS, endpointUrl, type BridgeTimeouts, type McpAuth } from './paths.js'

/// Structural stand-in for a zod schema — zod is the SDK's dependency, not
/// ours, so naming its types directly would lean on npm hoisting.
interface ParseSchema<T> {
  parse(value: unknown): T
}

/// The shim's connection to the running app: an MCP *client* over streamable
/// HTTP. Exactly one of two states — `up` (a connected Client) or `down`
/// (null). Every transition fires the injected callbacks so the stdio side
/// can broadcast `tools/list_changed` in both directions.

export type EnsureResult = 'up' | 'down' | 'no-auth'

export interface BridgeDeps {
  readAuth: () => McpAuth | null
  /// Seam for tests (InMemoryTransport). Production: streamable HTTP + bearer.
  makeTransport?: (auth: McpAuth) => Transport
  onUp: () => void
  onDown: () => void
  /// Server-initiated notifications from the app (the weftcut/change feed),
  /// forwarded verbatim to the stdio client.
  onNotification: (n: { method: string; params?: unknown }) => void
  /// The downstream client's name (what the agent's client declared to the
  /// shim), once it has initialized. The app attributes every edit to the name
  /// its session was opened under, so the shim opens it under this one rather
  /// than its own. Absent → the shim's own name.
  clientName?: () => string | undefined
  /// Defaults: `DEFAULT_BRIDGE_TIMEOUTS` (the stdio shim passes the env's).
  timeouts?: BridgeTimeouts
  /// How long the liveness ping may take. Test seam; default 3 s.
  probeTimeoutMs?: number
}

/// What one forwarded request carries from the upstream (stdio) request.
export interface ForwardOptions {
  /// The upstream handler's `extra.signal`. Aborting it sends the app a
  /// `notifications/cancelled` for the bridged request.
  signal?: AbortSignal
  /// Receives the app's progress for this request, to relay upstream.
  onprogress?: (progress: Progress) => void
}

/// What the shim calls itself upstream until the downstream client has named
/// itself.
const SHIM_CLIENT_NAME = 'weftcut-mcp'

/// Close a client AND its app-side session (the DELETE), best-effort.
async function endSession(c: Client): Promise<void> {
  const t = c.transport as (Transport & { terminateSession?: () => Promise<void> }) | undefined
  if (t?.terminateSession) await t.terminateSession().catch(() => {})
  await c.close().catch(() => {})
}

function httpTransport(auth: McpAuth): Transport {
  return new StreamableHTTPClientTransport(new URL(endpointUrl(auth)), {
    requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
  })
}

/// A JSON-RPC error is proof the server ANSWERED — the bridge is healthy and
/// the error belongs to the caller. Everything else (fetch refused, socket
/// reset, SDK connection-closed/timeout codes) means the app went away.
function serverAnswered(e: unknown): boolean {
  return (
    e instanceof McpError &&
    e.code !== ErrorCode.ConnectionClosed &&
    e.code !== ErrorCode.RequestTimeout
  )
}

function timedOut(e: unknown): e is McpError {
  return e instanceof McpError && e.code === ErrorCode.RequestTimeout
}

/// The SDK's own timer for a tool call, kept out of the way: when it fires the
/// SDK sends the app `notifications/cancelled`, which would abort the very job
/// the timeout result tells the agent is still running. The bridge's idle
/// timer (`boundedToolCall`) is the one that answers.
const SDK_TIMER_CEILING_MS = 2_147_483_647

/// The upstream request's `_meta.progressToken` names the STDIO client's
/// request; on the app hop the SDK attaches its own (it owns `onprogress`
/// routing), so the upstream one is dropped rather than leaked.
function withoutProgressToken(params: unknown): unknown {
  const p = params as { _meta?: Record<string, unknown> } | undefined
  if (!p?._meta || !('progressToken' in p._meta)) return params
  const { progressToken: _, ...meta } = p._meta
  return { ...p, _meta: meta }
}

export class Bridge {
  private client: Client | null = null
  private connecting: Promise<EnsureResult> | null = null
  /// The name the live app session was opened under.
  private openedAs: string | null = null

  private readonly timeouts: BridgeTimeouts
  private readonly probeTimeoutMs: number

  constructor(private readonly deps: BridgeDeps) {
    this.timeouts = deps.timeouts ?? DEFAULT_BRIDGE_TIMEOUTS
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 3000
  }

  isUp(): boolean {
    return this.client !== null
  }

  /// App identity while bridged (name/version from the initialize handshake).
  serverVersion(): { name: string; version: string } | null {
    return (this.client?.getServerVersion() as { name: string; version: string } | undefined) ?? null
  }

  /// Connect if down. Re-reads mcp_auth.json every attempt (rotation/port
  /// re-pick self-heal). Concurrent callers (poll loop vs a tool call) share
  /// one in-flight attempt.
  ensureUp(): Promise<EnsureResult> {
    if (this.client) return Promise.resolve('up')
    if (this.connecting) return this.connecting
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectOnce(): Promise<EnsureResult> {
    const auth = this.deps.readAuth()
    if (!auth) return 'no-auth'
    const name = this.deps.clientName?.() ?? SHIM_CLIENT_NAME
    const client = new Client({ name, version: '1.0' }, { capabilities: {} })
    client.fallbackNotificationHandler = async (n) => {
      this.deps.onNotification(n as { method: string; params?: unknown })
    }
    try {
      const make = this.deps.makeTransport ?? httpTransport
      // Bounded initialize: on a dead port fetch rejects instantly, but a
      // half-up app must not wedge the poll loop behind the 60s SDK default.
      await client.connect(make(auth), { timeout: 3000 })
    } catch {
      await client.close().catch(() => {})
      return 'down'
    }
    // The client named itself while this connect was in flight: reopen under
    // that name before anyone is handed this session. Done inside the connect,
    // so every caller awaiting `connecting` gets the final session.
    const now = this.deps.clientName?.()
    if (now !== undefined && now !== name) {
      await endSession(client)
      return this.connectOnce()
    }
    client.onclose = () => this.markDown()
    this.client = client
    this.openedAs = name
    this.deps.onUp()
    return 'up'
  }

  /// Idempotent: onclose fires again when we close the client here.
  ///
  /// Terminates the app-side SESSION too, not just the connection — the DELETE
  /// that releases the work session and the history lock at once, instead of
  /// leaving them to the app's reaper (`main/mcp/index.ts`). Best-effort: the
  /// app may already be down, which is one of the reasons this is called.
  markDown(): void {
    const c = this.client
    if (!c) return
    this.client = null
    void endSession(c)
    this.deps.onDown()
  }

  /// Reopen the app session under the downstream client's name when it was
  /// opened before that name was known (the poll loop connects at start-up,
  /// ahead of the client's initialize). Called once the client initializes,
  /// before it can have taken a work session or a lock the reopen would drop.
  ///
  /// The swap is synchronous up to the new connect, so a request arriving after
  /// this call finds `connecting` set and waits for the renamed session. A
  /// connect already in flight renames itself (`connectOnce`).
  reidentify(): Promise<void> {
    if (this.connecting) return this.connecting.then(() => {})
    const want = this.deps.clientName?.()
    if (!this.client || !want || want === this.openedAs) return Promise.resolve()
    this.markDown()
    return this.ensureUp().then(() => {})
  }

  /// Cheap liveness check for the poll loop while up.
  async pingOrMarkDown(): Promise<void> {
    const c = this.client
    if (!c) return
    if (!(await this.answers(c))) this.markDown()
  }

  private async answers(c: Client): Promise<boolean> {
    try {
      await c.ping({ timeout: this.probeTimeoutMs })
      return true
    } catch {
      return false
    }
  }

  /// Forward one request verbatim. Throws `BridgeDownError` when the app is
  /// (or just went) unreachable, `BridgeTimeoutError` when it is alive but did
  /// not answer in time; rethrows the app's own JSON-RPC errors, and whatever
  /// an upstream cancel produced.
  async forward<T>(
    method: string,
    params: unknown,
    resultSchema: ParseSchema<T>,
    opts: ForwardOptions = {},
  ): Promise<T> {
    const c = this.client
    if (!c) throw new BridgeDownError()
    const request = { method, params: withoutProgressToken(params) }
    try {
      if (method === 'tools/call') return await this.boundedToolCall(c, request, resultSchema, opts)
      // Always an `onprogress`, so the SDK puts its own token on the app hop.
      return await c.request(request as never, resultSchema as never, {
        timeout: this.timeouts.requestMs,
        onprogress: (p: Progress) => opts.onprogress?.(p),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (e) {
      // The caller cancelled: the SDK already told the app, and the app is
      // as up as it was. (The SDK reports the abort as a RequestTimeout.)
      if (opts.signal?.aborted) throw e
      if (serverAnswered(e)) throw e
      // A timeout alone does not say the app went away — a long tool call
      // looks exactly like it. Only a failed ping does.
      if (timedOut(e) && (await this.answers(c))) {
        const data = e.data as { timeout?: number; maxTotalTimeout?: number } | undefined
        throw new BridgeTimeoutError(method, data?.maxTotalTimeout ?? data?.timeout ?? 0, data?.maxTotalTimeout !== undefined)
      }
      // A failure on a session that has since been replaced is not news
      // about the current one.
      if (this.client === c) this.markDown()
      throw new BridgeDownError()
    }
  }

  /// A tool call under the idle window: every progress notification from the
  /// app re-arms it, and the optional total cap bounds it regardless. On
  /// expiry the bridged request is left pending rather than cancelled, so the
  /// job keeps running in the app and an identical retry can join it; its
  /// late result (or the session's close) lands on a settled promise.
  private boundedToolCall<T>(
    c: Client,
    request: { method: string; params: unknown },
    resultSchema: ParseSchema<T>,
    opts: ForwardOptions,
  ): Promise<T> {
    const { toolIdleMs, toolMaxTotalMs } = this.timeouts
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let idle: ReturnType<typeof setTimeout> | undefined
      let total: ReturnType<typeof setTimeout> | undefined
      const settle = (done: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(idle)
        clearTimeout(total)
        done()
      }
      const expire = (data: { timeout: number } | { maxTotalTimeout: number }) => () =>
        settle(() => reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out', data)))
      const arm = (): void => {
        clearTimeout(idle)
        idle = setTimeout(expire({ timeout: toolIdleMs }), toolIdleMs)
      }
      arm()
      if (toolMaxTotalMs !== undefined) total = setTimeout(expire({ maxTotalTimeout: toolMaxTotalMs }), toolMaxTotalMs)
      c.request(request as never, resultSchema as never, {
        timeout: SDK_TIMER_CEILING_MS,
        // Present even with no upstream token: app heartbeats must re-arm the
        // idle window whether or not anyone upstream is listening.
        onprogress: (p: Progress) => {
          if (settled) return // the upstream request is already answered
          arm()
          opts.onprogress?.(p)
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
      }).then(
        (r) => settle(() => resolve(r as T)),
        (e: unknown) => settle(() => reject(e)),
      )
    })
  }
}

export class BridgeDownError extends Error {
  constructor() {
    super('WeftCut is not reachable')
  }
}

/// The app answered a liveness ping but not the request in time. `total` says
/// the tool-call total cap elapsed rather than the idle window.
export class BridgeTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    readonly total: boolean,
  ) {
    super(`WeftCut did not answer ${method} within ${timeoutMs} ms`)
  }
}
