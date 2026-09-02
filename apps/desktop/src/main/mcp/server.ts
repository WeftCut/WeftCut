import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolRequest,
  type ReadResourceRequest,
  type GetPromptRequest,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js'
import { captureMotifFrameB64 } from '../motif/capture.js'
import { routeMcpTool } from './mutationTools.js'
import { shapeMotifMcpResult } from './motifResult.js'
import { runHybrid } from '../state/hybrids.js'
import { CLIP_SLICE_TOOLS, resolveClipSliceArgs, TWO_SLICE_TOOLS, resolveTwoSliceArgs } from '../state/clip-slice-forward.js'
import { serveProjectResource, buildResourceInjection } from '../state/resource-views.js'
import type { TsActorHost } from '../state/ts-actor-host.js'
import type { ActorHandle, ChangeEvent } from '../state/actor.js'
import { mergeMcpCatalog, mergeMcpResources } from './mcpCatalog.js'
import { MCP_TOOL_DEFS } from '../state/mcp-commands.js'
import { MOTIF_TOOL_DEFS, MOTIF_RESOURCE_DEFS } from './motifToolDefs.js'
import { withLog, NO_MCP_LOG, type McpCommitWindow, type McpLogDeps, type McpRowSummary } from './withLog.js'

type Backend = import('@weftcut/core').Backend

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
}
const CODE_MAP: Record<string, number> = {
  invalid_params: -32602, invalid_request: -32600, not_found: -32601, internal: -32603,
}

/** Map a parsed {ok,result|error} envelope to the SDK result (or throw the
 *  SDK-shaped error). The TS actor.mcpCall returns this same shape as Rust's reply(). */
function unwrapEnvelope(env: Envelope): unknown {
  if (env.ok) return env.result
  const err = env.error!
  const e = new Error(err.message) as Error & { code?: number; data?: unknown }
  e.code = CODE_MAP[err.code] ?? -32603
  e.data = err.data
  throw e
}
function unwrap(json: string): unknown { return unwrapEnvelope(JSON.parse(json) as Envelope) }

/** Per-call VLM config provider (describe_clip + media://{id}/description): the
 *  merged backend-config snapshot the stateless resolver reads (ADR 0024) keyed
 *  by backend tag, plus the user's SOFT preferred engine. VLM config is not held
 *  on the napi `Backend` like speech — it rides in with each call. */
export type VlmProvider = () => { config: Record<string, unknown>; preferred: string | null }
const NO_VLM: VlmProvider = () => ({ config: {}, preferred: null })

/** One clip-compute tool call: resolve the `{ layer, media }` slice from the
 *  actor (the sole state owner), inject the engine-selection hints the stateless
 *  Rust resolvers read, dispatch, and unwrap the envelope.
 *
 *  Exported because the renderer reaches the same tools through
 *  `backend:invoke`'s `clipCompute` route (`state/router.ts`), and both surfaces
 *  must be ONE code path: a human and an agent asking the same clip the same
 *  question have to get the same engine and the same slice, and two copies of
 *  this injection would be exactly how that stops being true.
 *
 *  Read/compute only — no arm here writes. The write half of a recipe (the SRT
 *  a transcript becomes, the layer a synthesis lands as) is a hybrid channel. */
export async function callClipComputeTool(
  backend: Backend,
  tsHost: TsActorHost,
  name: string,
  args: Record<string, unknown>,
  getPreferredEngine: () => string | null = () => null,
  getVlm: VlmProvider = NO_VLM,
): Promise<ServerResult> {
  const merged = resolveClipSliceArgs(args, tsHost.actor.snapshot())
  // Inject the user's preferred engine as the SOFT `preferred_backend`
  // hint (ADR 0036: select by user preference THEN availability). The
  // agent-visible `backend` arg is deliberately NOT touched — it is a
  // STRICT override in Rust (that engine or an error, never a substitute),
  // so conflating the two would turn a mere preference into a hard
  // requirement (or worse, a hard requirement into a silent fallback).
  // "auto"/unset injects nothing; the Rust resolver's DEFAULT_ORDER decides.
  if (name === 'transcribe_clip' && merged.backend == null) {
    const pref = getPreferredEngine()
    if (pref && pref !== 'auto') merged.preferred_backend = pref
  }
  // describe_clip: inject the stateless VLM backend-config snapshot (ADR
  // 0024) it resolves against, plus the SOFT preferred-engine hint — same
  // soft/strict split as transcribe_clip (the agent-visible `backend` stays
  // a STRICT override, so only fill preferred_backend when it is unset).
  if (name === 'describe_clip') {
    const vlm = getVlm()
    merged.vlm_config = vlm.config
    if (merged.backend == null && vlm.preferred && vlm.preferred !== 'auto') {
      merged.preferred_backend = vlm.preferred
    }
  }
  return unwrap(await backend.mcpCallTool(name, JSON.stringify(merged))) as ServerResult
}

/** CallTool routing (tsHost present): mutations → TS actor.mcpCall, hybrid →
 *  runHybrid, rust → backend (native reads/compute that take an injected state slice). */
export async function handleCallTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  name: string,
  args: Record<string, unknown>,
  getPreferredEngine: () => string | null = () => null,
  getVlm: VlmProvider = NO_VLM,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    const route = routeMcpTool(name)
    if (route === 'ts') {
      const out = unwrapEnvelope(tsHost.mcpCall(name, JSON.stringify(args)))
      if (name === 'begin_agent_session') tsHost.beginAgentSessionSlot(((args.reason as string | undefined) ?? '').trim(), 'mcp')
      return out as ServerResult
    }
    if (route === 'hybrid') {
      // Native-compute → TS-write. import_media returns the new media
      // id; shape it as the Rust tool does (ToolResult::text(id) → text content).
      const result = await runHybrid(name, args, tsHost.hybridDeps)
      return { content: [{ type: 'text', text: String(result) }] } as unknown as ServerResult
    }
    if (route === 'motif') {
      // Catalog-read + authoring + install, served in TS. The raw value
      // is shaped to the Rust-faithful ToolResult (list_motifs strips html, etc.).
      const raw = tsHost.motifTool(name, args)
      return shapeMotifMcpResult(name, raw) as unknown as ServerResult
    }
    // Clip compute routes to 'rust', but the Rust core holds no state — the
    // slice is resolved here from the actor and forwarded.
    //
    // Two-slice compute (compare_frames) resolves BOTH nested { a, b } clip
    // slices. Kept separate from the single-slice call below, which reads a
    // top-level `layer_id`.
    if (TWO_SLICE_TOOLS.has(name)) {
      const merged = resolveTwoSliceArgs(args, tsHost.actor.snapshot())
      return unwrap(await backend.mcpCallTool(name, JSON.stringify(merged))) as ServerResult
    }
    if (CLIP_SLICE_TOOLS.has(name)) {
      return callClipComputeTool(backend, tsHost, name, args, getPreferredEngine, getVlm)
    }
    // route === 'rust' → fall through (other reads are served by the backend).
  }
  if (name === 'preview_motif_draft') {
    const a = args as { id?: string; motif_id?: string; t_sec?: number; props?: unknown; width?: number; height?: number }
    const motifId = a.id ?? a.motif_id ?? ''
    const b64 = await captureMotifFrameB64({
      motifId, tSec: a.t_sec ?? 0, propsJson: JSON.stringify(a.props ?? {}),
      width: a.width ?? 480, height: a.height ?? 480, settleRafs: null, contentHash: '',
    })
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] } as unknown as ServerResult
  }
  return unwrap(await backend.mcpCallTool(name, JSON.stringify(args))) as ServerResult
}

/** ReadResource routing (tsHost present): project:// state views served in TS from
 *  the actor (sole state owner); the Rust-compute resources (project://compiled,
 *  media://*, composition://meter) forwarded to the backend with an injected
 *  slice. */
export async function handleReadResource(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  uri: string,
  getVlm: VlmProvider = NO_VLM,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    if (uri === 'motifs://current') {
      const raw = tsHost.motifTool('list_motifs', {}) as Array<Record<string, unknown>>
      const list = raw.map((e) => { const { html: _html, ...rest } = e; return rest })
      return { contents: [{ uri: 'motifs://current', mimeType: 'application/json', text: JSON.stringify(list) }] } as unknown as ServerResult
    }
    const served = serveProjectResource(uri, tsHost.actor)
    if (served) return served
    // project://compiled / media://* / composition://meter stay Rust compute —
    // inject the project / MediaItem / nothing the stateless reader now needs.
    const injection = buildResourceInjection(uri, tsHost.actor.snapshot(), getVlm().config)
    return unwrap(await backend.mcpReadResource(uri, injection)) as ServerResult
  }
  return unwrap(await backend.mcpReadResource(uri)) as ServerResult
}

/** Collect the `ChangeEvent`s one MCP call commits, so its log row can carry the
 *  change summary the history panel renders instead of the mechanical tool name.
 *  The window is opened and closed by `withLog`, which owns the timing that makes
 *  it exclusive.
 *
 *  `close()` unsubscribes FIRST, so a throw while folding the row still ends the
 *  collection. Several commits fold to the LAST summary plus a count: the row is
 *  one line, and the last change is the one the call ended on.
 *
 *  The label key is read back out of history rather than widened onto
 *  `ChangeEvent`, which would ripple through `mapChangeEvent` into the renderer
 *  bridge for no gain. Matched by `op_id`, never by position: a commit that never
 *  reaches history — `undo`, `restore_checkpoint` and the rest of
 *  `broadcastUnrecorded` — must not borrow the key of whatever sits on top of the
 *  stack. Those legitimately have no key and carry their summary text alone. */
function openCommitWindow(actor: ActorHandle): McpCommitWindow {
  const collected: ChangeEvent[] = []
  const stopCollecting = actor.subscribe((e) => { collected.push(e) })
  return {
    close: () => {
      stopCollecting()
      const last = collected[collected.length - 1]
      if (last === undefined) return null
      const recorded = actor.historyView(1).ops.find((o) => o.op_id === last.op_id)
      const row: McpRowSummary = { message: last.summary, commits: collected.length }
      if (recorded?.label_key !== undefined) row.i18n_key = recorded.label_key
      if (recorded?.label_args !== undefined) row.i18n_args = recorded.label_args
      return row
    },
  }
}

/** One media frame as a `data:` URL the renderer can put straight in an `img`
 *  src, read through the SAME `media://{id}/frame/{t_us}` resource an agent
 *  reads: Rust extracts the frame once and caches it per `(file_hash, t_us)`,
 *  so the shot-review surface's cover frames cost one extract each however
 *  often they are re-shown.
 *
 *  Exported for the renderer's frame channel (`index.ts`), the way
 *  `callClipComputeTool` is — a second extraction call site would be a second
 *  cache key convention waiting to disagree with this one.
 *
 *  `t_us` is truncated because the resource path parses an integer; a
 *  fractional microsecond would be refused as a malformed URI rather than
 *  rounded. */
export async function readMediaFrameDataUrl(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  mediaId: string,
  tUs: number,
): Promise<string> {
  const uri = `media://${mediaId}/frame/${Math.trunc(tUs)}`
  const res = await handleReadResource(backend, getTsHost, uri)
  const content = (res as { contents?: Array<{ blob?: string; mimeType?: string }> }).contents?.[0]
  if (typeof content?.blob !== 'string') throw new Error(`${uri} returned no image`)
  return `data:${content.mimeType ?? 'image/jpeg'};base64,${content.blob}`
}

/** The two refusals `media://{id}/description` answers with when the DEFAULT
 *  view simply holds nothing: no description has been computed at that key yet,
 *  or no engine is configured to have computed one. Both mean "not described" to
 *  a reader, which is why `readMediaDescription` folds them into `null` instead
 *  of throwing — a Panel column has one empty state, and a backend that is not
 *  set up is the describe dialog's news to break, not a shot row's.
 *
 *  Matched on the leading phrase and unanchored: the media id and the backend
 *  tag are interpolated into both sentences, and the resource errors are prose
 *  with no structured code to key on. Every OTHER failure — an unknown media id,
 *  an unreadable cache file — still throws, because those are real. */
const NOT_DESCRIBED = /no description computed yet for media|no video-understanding backend/

/** The cached description for one source's DEFAULT view — the resolver's default
 *  backend at fps 1.0 and focus `general` — or `null` when nothing is cached
 *  there, read through the SAME `media://{id}/description` resource an agent
 *  reads.
 *
 *  Exported for the renderer's description channel (`index.ts`), the way
 *  `readMediaFrameDataUrl` is. The default view is the only view this resource
 *  serves and deliberately so: it is what a description made at the dialog's
 *  default sampling lands in, and therefore the only one a Panel reopened in a
 *  later session can still find.
 *
 *  `getVlm` is not optional here as it is on the frame read: the resource needs
 *  the merged backend config to resolve which backend's cache key to look
 *  under, and an empty config would report every source as undescribed. */
export async function readMediaDescription(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  mediaId: string,
  getVlm: VlmProvider,
): Promise<unknown | null> {
  const uri = `media://${mediaId}/description`
  let res: ServerResult
  try {
    res = await handleReadResource(backend, getTsHost, uri, getVlm)
  } catch (err) {
    if (NOT_DESCRIBED.test(String(err))) return null
    throw err
  }
  const content = (res as { contents?: Array<{ text?: string }> }).contents?.[0]
  if (typeof content?.text !== 'string') throw new Error(`${uri} returned no body`)
  return JSON.parse(content.text)
}

/** `withLog`'s `observe` seam for one session: which tools' commits may be
 *  attributed to their call, and the actor to watch for them.
 *
 *  Only the `'ts'` route qualifies, and by ROUTE rather than by tool name: it is
 *  the only route that commits inside `handleCallTool`'s synchronous prefix. The
 *  `async` hybrids are excluded because two overlapping ones would each see the
 *  other's commit, and a row attributed to the wrong tool is worse than a
 *  mechanical one. Exported for the gate, which drives the same predicate the
 *  session does rather than a copy of it. */
export function mcpCommitObserver(getTsHost: () => TsActorHost | null): (tool: string) => McpCommitWindow | null {
  return (tool: string) => {
    if (routeMcpTool(tool) !== 'ts') return null
    // No host and even a 'ts' tool is forwarded to the backend, where there is
    // no actor to watch.
    const tsHost = getTsHost()
    return tsHost ? openCommitWindow(tsHost.actor) : null
  }
}

/** The injectable seams of one MCP session. An options bag rather than trailing
 *  positionals: `log` is the fourth and every one of them is optional, and each
 *  omitted seam must keep the behaviour it had before it existed. */
export interface McpServerOptions {
  getTsHost?: () => TsActorHost | null
  getPreferredEngine?: () => string | null
  getVlm?: VlmProvider
  /** LogBus emit + workspace identity for the six request handlers. Omitted →
   *  no rows at all, which is what a `buildMcpServer` without a bus wants.
   *
   *  `observe` is not the caller's to set — the session builds it below from its
   *  own routing table and actor — so it is typed out rather than left as a knob
   *  that would be accepted and silently overwritten. */
  log?: Omit<McpLogDeps, 'observe'>
}

export function buildMcpServer(backend: Backend, opts: McpServerOptions = {}): Server {
  const getTsHost = opts.getTsHost ?? (() => null)
  const getPreferredEngine = opts.getPreferredEngine ?? (() => null)
  const getVlm = opts.getVlm ?? NO_VLM
  // `observe` is the session's to supply, not the caller's: it is the one log
  // seam that needs the routing table and the actor. An un-instrumented build
  // gets no window at all — nothing would read it, and the subscribe/unsubscribe
  // per call would be pure churn.
  const log: McpLogDeps = opts.log ? { ...opts.log, observe: mcpCommitObserver(getTsHost) } : NO_MCP_LOG
  const server = new Server(
    { name: 'weftcut', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  // One Server per session (`mcp/index.ts`), so this closure resolves to the
  // client that opened *this* session — `undefined` until it has initialized.
  const clientInfo = (): { name: string; version?: string } | undefined => server.getClientVersion()

  // Every handler goes through withLog: the funnel is what keeps a newly added
  // tool logged with nothing to remember. See `docs/status-log.md`.
  server.setRequestHandler(ListToolsRequestSchema, withLog('tools/list', async () => {
    const rust = (JSON.parse(await backend.mcpCatalog()) as { tools: Array<{ name: string }> }).tools
    return { tools: mergeMcpCatalog(rust, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]) } as unknown as ServerResult
  }, log, clientInfo))
  server.setRequestHandler(CallToolRequestSchema, withLog('tools/call', async (req: CallToolRequest) =>
    handleCallTool(backend, getTsHost, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, getPreferredEngine, getVlm),
  log, clientInfo))
  server.setRequestHandler(ListResourcesRequestSchema, withLog('resources/list', async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { resources: Array<{ uri: string }> }
    return { resources: mergeMcpResources(cat.resources, MOTIF_RESOURCE_DEFS) } as unknown as ServerResult
  }, log, clientInfo))
  server.setRequestHandler(ReadResourceRequestSchema, withLog('resources/read', async (req: ReadResourceRequest) =>
    handleReadResource(backend, getTsHost, req.params.uri, getVlm),
  log, clientInfo))
  server.setRequestHandler(ListPromptsRequestSchema, withLog('prompts/list', async () => {
    return { prompts: JSON.parse(await backend.mcpListPrompts()) } as unknown as ServerResult
  }, log, clientInfo))
  server.setRequestHandler(GetPromptRequestSchema, withLog('prompts/get', async (req: GetPromptRequest) => {
    return unwrap(
      await backend.mcpGetPrompt(req.params.name, JSON.stringify(req.params.arguments ?? {})),
    ) as ServerResult
  }, log, clientInfo))

  return server
}
