import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type ProgressToken,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Bridge, BridgeDownError, BridgeTimeoutError, type ForwardOptions } from './bridge.js'
import {
  bridgeTimeouts,
  endpointUrl,
  launchTarget,
  readAuth,
  TOOL_MAX_TOTAL_ENV,
  TOOL_TIMEOUT_ENV,
  type McpAuth,
  type ShimEnv,
} from './paths.js'

/// The stdio face of the shim: a real MCP server, not a byte pipe. Its
/// catalog is `synthetic ∪ (app reachable ? real catalog : ∅)` — the two
/// synthetic tools are ALWAYS present, so an agent can discover WeftCut and
/// bring it up even when nothing is listening yet, and `tools/list_changed`
/// fires on every bridge transition so the same session upgrades (and
/// downgrades) in place.

const SYNTHETIC_TOOLS: Tool[] = [
  {
    name: 'weftcut_status',
    description:
      'Report whether the WeftCut desktop app is currently running and reachable, and which ' +
      'project it has open. Returns the endpoint state and what to do next when it is not running. ' +
      'Costs nothing; call this first when WeftCut tools appear to be missing or failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'launch_weftcut',
    description:
      'Launch the WeftCut desktop app (opens its GUI window on the user’s machine) and ' +
      'wait until its MCP endpoint is reachable. On success the full WeftCut tool catalog ' +
      'becomes available in this session automatically (tools/list_changed). Safe to call ' +
      'when already running — reports that instead of launching twice. Use after ' +
      'weftcut_status says the app is not running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/// What a forwarding handler hands the bridge from its upstream request: the
/// cancellation signal, and — when the stdio client asked for progress — a
/// relay that re-addresses the app's progress to the client's OWN token (the
/// app hop runs under a token the SDK picked).
function upstream(
  req: { params?: { _meta?: { progressToken?: ProgressToken } } },
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  closed: () => boolean,
): ForwardOptions {
  const signal = explicitCancel(extra.signal, closed)
  const token = req.params?._meta?.progressToken
  if (token === undefined) return { signal }
  return {
    signal,
    onprogress: (p) => {
      extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: token } }).catch(() => {})
    },
  }
}

/// Only the stdio client's `notifications/cancelled` may cancel the app's job.
/// The SDK aborts every handler signal when the stdio transport closes, too,
/// and a client going away leaves its job running so a retry can join it —
/// so an abort is forwarded only if the transport is still open once the
/// close (which clears it right after aborting) has had its turn.
function explicitCancel(signal: AbortSignal, closed: () => boolean): AbortSignal {
  const forwarded = new AbortController()
  signal.addEventListener('abort', () => {
    queueMicrotask(() => { if (!closed()) forwarded.abort(signal.reason) })
  }, { once: true })
  return forwarded.signal
}

/// 300000 → "5 min", 45000 → "45 s".
function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`
  return `${ms} ms`
}

function text(s: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return isError ? { content: [{ type: 'text', text: s }], isError: true } : { content: [{ type: 'text', text: s }] }
}

export interface ShimOptions {
  se: ShimEnv
  userDataDir: string
  /** What `initialize` reports as the shim's own version — distinct from the
   *  app's, which rides the bridge and is reported by `weftcut_status`.
   *  `main.ts` passes the build stamp; absent reports `0.0.0-dev`. */
  version?: string
  /// Test seams. Defaults: read mcp_auth.json / streamable HTTP / detached spawn.
  readAuth?: () => McpAuth | null
  makeTransport?: (auth: McpAuth) => Transport
  spawnApp?: (targetPath: string) => void
  launchTimeoutMs?: number
  launchPollMs?: number
  probeTimeoutMs?: number
}

export interface Shim {
  server: Server
  bridge: Bridge
  /// Background reconnect/liveness loop. Returns the stop function.
  startPolling(intervalMs?: number): () => void
}

/// Detached GUI spawn: the child must outlive the shim, and must NOT inherit
/// ELECTRON_RUN_AS_NODE or the "app" would come up as a node interpreter
/// running no script.
function defaultSpawnApp(targetPath: string): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(targetPath, [], { detached: true, stdio: 'ignore', env })
  child.unref()
}

export function createShim(opts: ShimOptions): Shim {
  const { se, userDataDir } = opts
  const readAuthFn = opts.readAuth ?? (() => readAuth(userDataDir))
  const spawnApp = opts.spawnApp ?? defaultSpawnApp
  const launchTimeoutMs = opts.launchTimeoutMs ?? 45_000
  const launchPollMs = opts.launchPollMs ?? 1_000

  const server = new Server(
    { name: 'weftcut-mcp', version: opts.version ?? '0.0.0-dev' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    },
  )
  const closed = (): boolean => server.transport === undefined

  // Before the stdio transport connects (or after it closes) notification
  // sends throw — transitions at those moments have nothing to tell anyway.
  const broadcastCatalogChanged = (): void => {
    server.sendToolListChanged().catch(() => {})
    server.sendResourceListChanged().catch(() => {})
    server.sendPromptListChanged().catch(() => {})
  }

  const bridge = new Bridge({
    readAuth: readAuthFn,
    ...(opts.makeTransport ? { makeTransport: opts.makeTransport } : {}),
    timeouts: bridgeTimeouts(se),
    ...(opts.probeTimeoutMs !== undefined ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
    onUp: broadcastCatalogChanged,
    onDown: broadcastCatalogChanged,
    clientName: () => server.getClientVersion()?.name,
    onNotification: (n) => {
      // The app's change feed (notifications/weftcut/change), forwarded so a
      // shim-connected agent sees edits exactly like an HTTP-direct one.
      server.notification(n as { method: string; params?: Record<string, unknown> }).catch(() => {})
    },
  })

  // The app names an agent by the session it opened; open it as the client
  // that is actually driving, not as the shim.
  server.oninitialized = () => { void bridge.reidentify() }

  /// Everything actionable rides the MESSAGE: several MCP clients (Claude
  /// Code among them) surface only `code: message` to the model and drop
  /// structured error data.
  const downError = (): McpError => {
    const auth = readAuthFn()
    if (!auth) {
      return new McpError(
        ErrorCode.InternalError,
        `WeftCut has never been launched on this machine (no mcp_auth.json under ${userDataDir}). ` +
          'Ask the user to open WeftCut once so it creates its MCP endpoint, then call weftcut_status.',
      )
    }
    return new McpError(
      ErrorCode.InternalError,
      `WeftCut is not running (nothing answering at ${endpointUrl(auth)}). ` +
        'Call the launch_weftcut tool to start it, or ask the user to open WeftCut; ' +
        'the full tool catalog appears in this session automatically once the app is up.',
    )
  }

  /// The app is alive but the call outlived the bridge's wait. Same rule as
  /// `downError`: the message is all most clients show, so it carries what
  /// the agent should do. A tool call was left running in the app (the bridge
  /// does not cancel on timeout); other requests were cancelled by the SDK.
  const timeoutMessage = (e: BridgeTimeoutError, tool?: string): string => {
    if (e.method !== 'tools/call') {
      return (
        `WeftCut is running, but did not answer ${e.method} within ${duration(e.timeoutMs)}. ` +
        'Retry the request; call weftcut_status if it keeps happening.'
      )
    }
    const waited = e.total
      ? `within the ${duration(e.timeoutMs)} total limit set by ${TOOL_MAX_TOTAL_ENV}`
      : `within ${duration(e.timeoutMs)} of no progress from the app`
    return (
      `WeftCut is running, and ${tool ?? 'the tool'} is still working inside the app: it did not finish ${waited}. ` +
      'The call was not cancelled. Call the same tool again with the same arguments to keep waiting — ' +
      'an identical retry joins the in-flight job instead of starting a new one. ' +
      `To wait longer per call, raise ${TOOL_TIMEOUT_ENV} (milliseconds) in this MCP server's env config.`
    )
  }

  /// Every forwarding handler's error mapping except the down-state fallbacks
  /// the list handlers keep for themselves.
  const mapError = (e: unknown): unknown => {
    if (e instanceof BridgeDownError) return downError()
    if (e instanceof BridgeTimeoutError) return new McpError(ErrorCode.RequestTimeout, timeoutMessage(e))
    return e
  }

  /// The status line for the open project, from the app's session view. Left
  /// out (empty) when the read fails: the status call itself must still answer.
  async function projectLine(): Promise<string> {
    try {
      const r = await bridge.forward('tools/call', { name: 'read_project', arguments: { view: 'session' } }, CallToolResultSchema)
      const view = (r.structuredContent ?? JSON.parse((r.content[0] as { text?: string } | undefined)?.text ?? '{}')) as { project?: { name: string; dir: string } | null }
      if (view.project === undefined) return ''
      return view.project === null
        ? 'Project: none open. Open or create the one the user asked for (open_project / create_project), or ask them which.'
        : `Project: ${view.project.name} (${view.project.dir})`
    } catch {
      return ''
    }
  }

  async function statusResult(): Promise<ReturnType<typeof text>> {
    await bridge.ensureUp()
    if (bridge.isUp()) {
      const v = bridge.serverVersion()
      const auth = readAuthFn()
      return text(
        [
          `WeftCut is running${v ? ` (${v.name} ${v.version})` : ''}.`,
          auth ? `Endpoint: ${endpointUrl(auth)}` : '',
          await projectLine(),
          'The full tool catalog is available in this session.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    const auth = readAuthFn()
    if (!auth) {
      return text(
        [
          'WeftCut is not running, and has never been launched on this machine ' +
            `(no mcp_auth.json under ${userDataDir}).`,
          'Ask the user to open WeftCut once so it creates its MCP endpoint, then call weftcut_status again.',
        ].join('\n'),
      )
    }
    return text(
      [
        `WeftCut is not running (nothing answering at ${endpointUrl(auth)}).`,
        'Call launch_weftcut to start it, or ask the user to open WeftCut. ' +
          'The full tool catalog appears automatically once the app is up.',
      ].join('\n'),
    )
  }

  async function launchResult(): Promise<ReturnType<typeof text>> {
    if ((await bridge.ensureUp()) === 'up') {
      return text('WeftCut is already running — the full tool catalog is available.')
    }
    const target = launchTarget(se)
    if (!target.launchable) {
      return text(
        'This shim is running under a plain Node interpreter (dev), so it does not know the ' +
          'WeftCut app binary to launch. Start the app manually (npm run dev), or set the ' +
          'WEFTCUT_APP environment variable to a launchable WeftCut executable.',
        true,
      )
    }
    try {
      spawnApp(target.path)
    } catch (e) {
      return text(`Failed to launch WeftCut (${target.path}): ${e instanceof Error ? e.message : String(e)}`, true)
    }
    const deadline = Date.now() + launchTimeoutMs
    while (Date.now() < deadline) {
      await sleep(launchPollMs)
      if ((await bridge.ensureUp()) === 'up') {
        return text(
          'WeftCut launched and its MCP endpoint is up. The full tool catalog is now available ' +
            'in this session (tools/list_changed was sent).',
        )
      }
    }
    return text(
      `WeftCut was launched (${target.path}) but its MCP endpoint did not come up within ` +
        `${Math.round(launchTimeoutMs / 1000)}s. The app may still be starting — call weftcut_status to re-check.`,
      true,
    )
  }

  server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    // Opportunistic reconnect: a list request is exactly when a just-started
    // app should become visible without waiting on the poll tick.
    await bridge.ensureUp()
    // Synthetic tools ride the FIRST page only — a cursor means the client is
    // continuing a real-catalog listing.
    const synthetic = req.params?.cursor ? [] : SYNTHETIC_TOOLS
    if (!bridge.isUp()) return { tools: synthetic }
    try {
      const real = await bridge.forward('tools/list', req.params, ListToolsResultSchema, upstream(req, extra, closed))
      const taken = new Set(synthetic.map((t) => t.name))
      return { ...real, tools: [...synthetic, ...real.tools.filter((t) => !taken.has(t.name))] }
    } catch (e) {
      if (e instanceof BridgeDownError) return { tools: synthetic }
      throw mapError(e)
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name
    if (name === 'weftcut_status') return statusResult()
    if (name === 'launch_weftcut') return launchResult()
    await bridge.ensureUp()
    try {
      return await bridge.forward('tools/call', req.params, CallToolResultSchema, upstream(req, extra, closed))
    } catch (e) {
      // A tool result, not a protocol error: the call is fine, only this
      // wait is over.
      if (e instanceof BridgeTimeoutError) return text(timeoutMessage(e, name), true)
      throw mapError(e)
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => {
    await bridge.ensureUp()
    if (!bridge.isUp()) return { resources: [] }
    try {
      return await bridge.forward('resources/list', req.params, ListResourcesResultSchema, upstream(req, extra, closed))
    } catch (e) {
      if (e instanceof BridgeDownError) return { resources: [] }
      throw mapError(e)
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    await bridge.ensureUp()
    try {
      return await bridge.forward('resources/read', req.params, ReadResourceResultSchema, upstream(req, extra, closed))
    } catch (e) {
      throw mapError(e)
    }
  })

  server.setRequestHandler(ListPromptsRequestSchema, async (req, extra) => {
    await bridge.ensureUp()
    if (!bridge.isUp()) return { prompts: [] }
    try {
      return await bridge.forward('prompts/list', req.params, ListPromptsResultSchema, upstream(req, extra, closed))
    } catch (e) {
      if (e instanceof BridgeDownError) return { prompts: [] }
      throw mapError(e)
    }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
    await bridge.ensureUp()
    try {
      return await bridge.forward('prompts/get', req.params, GetPromptResultSchema, upstream(req, extra, closed))
    } catch (e) {
      throw mapError(e)
    }
  })

  const startPolling = (intervalMs = 10_000): (() => void) => {
    const timer = setInterval(() => {
      if (bridge.isUp()) void bridge.pingOrMarkDown()
      else void bridge.ensureUp()
    }, intervalMs)
    // unref: the poll must never keep the process alive once stdio closes.
    timer.unref()
    return () => clearInterval(timer)
  }

  return { server, bridge, startPolling }
}
