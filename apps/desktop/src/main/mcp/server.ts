import { beginModelUse } from "../model-usage";
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolRequest,
  type ReadResourceRequest,
  type GetPromptRequest,
  type ServerResult,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { captureMotifFrameB64 } from '../motif/capture.js'
import { APP_SCOPE_RESOURCES, HYBRID_TOOLS, routeMcpTool, servesWithoutProject } from './mutationTools.js'
import { canonicalizeProps, MotifPropError, type Manifest } from '../../shared/motifs/catalog.js'
import { shapeMotifMcpResult } from './motifResult.js'
import { runHybrid } from '../state/hybrids.js'
import { CLIP_SLICE_TOOLS, resolveClipSliceArgs, resolvePauseComputeArgs, TWO_SLICE_TOOLS, resolveTwoSliceArgs } from '../state/clip-slice-forward.js'
import { serveProjectResource, buildResourceInjection } from '../state/resource-views.js'
import type { TsActorHost } from '../state/ts-actor-host.js'
import type { ActorHandle, ChangeEvent } from '../state/actor.js'
import { mergeMcpCatalog, mergeMcpResources } from './mcpCatalog.js'
import { MCP_TOOL_DEFS, MCP_TOOLS, McpArgError, mcpDef, type McpErrorCode, type ToolAnnotations } from '../state/mcp-commands.js'
import { NO_PROJECT_OPEN_MESSAGE, noProjectOpenResult, toolErrorResult, thrownToToolError, UnknownToolError } from './toolResult.js'
import { toolRecord } from '../state/mcp-results.js'
import { mcpActor } from '../state/mcp-actor.js'
import { argProblemMessage } from './argCheck.js'
import { shapeHybridResult } from './hybridResult.js'
import { PROJECT_TOOLS, runProjectTool } from './projectTools.js'
import { MOTIF_TOOL_DEFS, MOTIF_RESOURCE_DEFS } from './motifToolDefs.js'
import { HOST_RESOURCE_DEFS, HOST_RESOURCE_TEMPLATES } from './hostResources.js'
import { MCP_INSTRUCTIONS } from './instructions.js'
import { effectsCatalogView } from '../../shared/effects/catalogView.js'
import { withLog, NO_MCP_LOG, type McpCommitWindow, type McpLogDeps, type McpRowSummary } from './withLog.js'
import { withCanonicalToolName } from './toolAliases.js'

type Backend = import('@weftcut/core').Backend

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: McpErrorCode; message: string; data?: unknown }
}
const CODE_MAP: Record<string, number> = {
  invalid_params: -32602, invalid_request: -32600, not_found: -32601, internal: -32603,
}

/** Map a parsed {ok,result|error} envelope to the SDK result, or THROW the
 *  SDK-shaped error. The throwing form is right for `resources/read` and
 *  `prompts/get`, whose results have no `isError` slot, and for the renderer's
 *  own clip-compute path (`callClipComputeTool`), where a throw is what the IPC
 *  bridge turns into a rejected promise. A TOOL call never surfaces one of these
 *  to an agent: `handleCallTool` catches it and answers with an `isError`
 *  result (`toolResult.ts`). The TS actor.mcpCall returns this same envelope
 *  shape as Rust's reply(). */
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
 *  on the napi `Backend` like speech — it rides in with each call.
 *
 *  `preferred`, `language`, `fps` and `focus` ride along because the description
 *  cache is keyed by all four — `preferred` through the backend it resolves and
 *  that backend's model label: the tool that WRITES a cache entry and the
 *  resource that READS one have to name the same view or every source reads as
 *  undescribed. One provider, so they cannot disagree — and it is the app's
 *  Video-understanding settings, not this layer's guess.
 *  `null` = the caller has no UI to speak for (a bare-core read), which Rust
 *  resolves to no preference / `Language::DEFAULT_TAG` / `DEFAULT_FPS` /
 *  `Focus::General`. */
export type VlmProvider = () => {
  config: Record<string, unknown>
  preferred: string | null
  language: string | null
  fps: number | null
  focus: string | null
}
const NO_VLM: VlmProvider = () => ({
  config: {},
  preferred: null,
  language: null,
  fps: null,
  focus: null,
})

/** The baked peaks file `detect_pauses` must read for one SUBJECT Audio layer,
 *  or `null` for "the media's own" (spec Decision 11). Supplied by the host,
 *  because the bake state lives in main's audio-fx baker and nowhere else — it
 *  is a derivation, never project state (ADR 0063).
 *
 *  A build with no baker (every test harness, a bare-core call) answers `null`
 *  and reads the raw peaks, which is the same fallback a not-yet-baked layer
 *  takes. */
export type PeaksPathProvider = (subjectLayerId: string) => string | null
const NO_PEAKS_PATH: PeaksPathProvider = () => null

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
  peaksPathFor: PeaksPathProvider = NO_PEAKS_PATH,
): Promise<ServerResult> {
  // `detect_pauses` takes its own resolver: the slice is the SUBJECT Audio
  // layer, not the layer the caller named, and the peaks file rides with it
  // (spec Decisions 1 and 11).
  const merged = name === 'detect_pauses'
    ? resolvePauseComputeArgs(args, tsHost.actor.snapshot(), peaksPathFor)
    : resolveClipSliceArgs(args, tsHost.actor.snapshot())
  // ADR 0064: inject the explicitly selected model backend. None stays unset;
  // native resolution does not choose another configured model implicitly.
  // An agent's explicit backend override remains authoritative.
  if (name === 'transcribe_clip' && merged.backend == null) {
    const pref = getPreferredEngine()
    if (pref && pref !== 'auto') merged.preferred_backend = pref
  }
  // Vision resolves against the selected profile's per-call configuration.
  if (name === 'describe_clip') {
    const vlm = getVlm()
    merged.vlm_config = vlm.config
    if (merged.backend == null && vlm.preferred && vlm.preferred !== 'auto') {
      merged.preferred_backend = vlm.preferred
    }
    // The UI language as the DEFAULT and not an override: `language` is an
    // advertised arg, so an agent asking for Japanese prose about a clip must
    // get it whatever the app's chrome is set to. Only an unset one is filled —
    // and filling it here rather than leaving it to Rust's own default is what
    // makes the renderer's runs land in the view the shot rows read back.
    if (merged.language == null && vlm.language) merged.language = vlm.language
    // The other two view axes take the same default-not-override rule, for the
    // same reason: an agent that asked for a specific sampling or focus keeps
    // it, and an omitted one is filled from the app's setting — which is what
    // makes a renderer run land in the view the shot rows read back.
    if (merged.fps == null && vlm.fps != null) merged.fps = vlm.fps
    if (merged.focus == null && vlm.focus) merged.focus = vlm.focus
  }
  const release = name === 'transcribe_clip' || name === 'describe_clip' ? beginModelUse() : () => {}
  try { return unwrap(await backend.mcpCallTool(name, JSON.stringify(merged))) as ServerResult }
  finally { release() }
}

/** The Rust catalog is static for the life of the process — `tool_table!` is a
 *  compile-time table — so it is parsed once per backend and shared by
 *  `tools/list`, `resources/list` and the argument gate below. Keyed weakly on
 *  the backend object so a test's fake backend is its own catalog. */
interface RustCatalog {
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; input_schema?: Record<string, unknown>; annotations?: ToolAnnotations }>
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
}
const rustCatalogs = new WeakMap<object, Promise<RustCatalog>>()
export function rustCatalog(backend: Backend): Promise<RustCatalog> {
  let p = rustCatalogs.get(backend)
  if (!p) {
    p = backend.mcpCatalog().then((json) => {
      const c = JSON.parse(json) as Partial<RustCatalog>
      return { tools: c.tools ?? [], resources: c.resources ?? [] }
    })
    // A failed read must not poison every later call with the same rejection.
    p.catch(() => { rustCatalogs.delete(backend) })
    rustCatalogs.set(backend, p)
  }
  return p
}

/** A tool's parsed envelope → the SDK result. A refusal becomes an `isError`
 *  result (`toolResult.ts`); only an unknown tool name still throws, because
 *  that is a malformed request and not a tool's answer. */
function unwrapToolEnvelope(json: string, name: string): ServerResult {
  const env = JSON.parse(json) as Envelope
  if (env.ok) return env.result as ServerResult
  const err = env.error!
  if (err.code === 'not_found') throw new UnknownToolError(name)
  return toolErrorResult(err)
}

/** The argument gate for the routes that have no TS parser of their own.
 *
 *  A TS-owned hybrid def (`auto_split_by_shot`, `remove_pauses`) carries a
 *  `parseDedicated`; running it here refuses a malformed id in the same words
 *  every table tool uses (the bijection gate runs it too, but on fixtures). A
 *  motif tool and a Rust-sourced tool are checked against their advertised
 *  schema (`argCheck.ts`), so a missing `draft_id` or a `mode` outside its enum
 *  is named here rather than surfacing as a store lookup for `undefined`, and
 *  a Rust tool missing two fields is refused once in its own vocabulary instead
 *  of serde's one-field-at-a-time text. Returns the refusal, or null when the
 *  args pass. */
async function refuseBadArgs(backend: Backend, name: string, args: Record<string, unknown>): Promise<ServerResult | null> {
  if (HYBRID_TOOLS.has(name) && MCP_TOOLS.has(name)) {
    try { mcpDef(name).parseDedicated?.(args) }
    catch (e) { if (e instanceof McpArgError) return toolErrorResult(e.toJson()); throw e }
    return null
  }
  const motif = MOTIF_TOOL_DEFS.find((d) => d.name === name)
  const tool = motif ? undefined : (await rustCatalog(backend)).tools.find((t) => t.name === name)
  const schema = motif?.inputSchema ?? tool?.inputSchema ?? tool?.input_schema
  const message = schema ? argProblemMessage(name, schema, args) : null
  return message === null ? null : toolErrorResult({ code: 'invalid_params', message })
}

/** The names whose advertised `annotations.readOnlyHint` is true, from the
 *  same merged catalog `tools/list` serves, once per backend. A Rust catalog
 *  that cannot be read leaves the TS-owned reads, so the split degrades to
 *  "Rust tools are operations" rather than to a throw on every call. */
const readOnlySets = new WeakMap<Backend, Promise<Set<string>>>()
function readOnlyTools(backend: Backend): Promise<Set<string>> {
  let p = readOnlySets.get(backend)
  if (!p) {
    const names = (rust: ReadonlyArray<{ name: string; annotations?: ToolAnnotations }>): Set<string> =>
      new Set(mergeMcpCatalog(rust, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]).filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name))
    // A backend that throws synchronously (no catalog method at all, as some
    // test doubles have) is the same case as one whose catalog rejects.
    const attempt = Promise.resolve().then(() => rustCatalog(backend)).then((c) => names(c.tools))
    // Only a catalog that was read is remembered: a failed read answers the
    // TS-owned reads for this call and is retried on the next.
    attempt.catch(() => { if (readOnlySets.get(backend) === p) readOnlySets.delete(backend) })
    p = attempt.catch(() => names([]))
    readOnlySets.set(backend, p)
  }
  return p
}

/** CallTool routing (tsHost present): mutations → TS actor.mcpCall, hybrid →
 *  runHybrid, rust → backend (native reads/compute that take an injected state slice).
 *
 *  Every failure inside a tool comes back as an `isError` RESULT, whatever route
 *  raised it and however it was raised — an envelope, a thrown `CommandError`
 *  JSON, serde text, an OS message. The one throw that escapes is an unknown
 *  tool name, which the SDK turns into the JSON-RPC error the spec reserves for
 *  it. `withLog` and the activity service both read `isError`, so a refusal is
 *  still logged as a failed call. */
export async function handleCallTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  name: string,
  args: Record<string, unknown>,
  getPreferredEngine: () => string | null = () => null,
  getVlm: VlmProvider = NO_VLM,
  peaksPathFor: PeaksPathProvider = NO_PEAKS_PATH,
  client?: string,
): Promise<ServerResult> {
  const route = routeMcpTool(name)
  // Nothing the user can see is open: every project tool refuses before it
  // reaches a project (the startup placeholder, or the one the user closed).
  // Synchronous, so the ts route's commit prefix below is untouched; only the
  // refusal path awaits, to keep an unknown name the JSON-RPC error it is.
  if (noProjectOpen(getTsHost()) && !servesWithoutProject(name, args)) {
    if (!(await isKnownTool(backend, name))) throw new UnknownToolError(name)
    return noProjectOpenResult()
  }
  try {
    // LANDMINE: no `await` may precede this call — the 'ts' route commits inside
    // `dispatchTool`'s synchronous prefix, and `withLog`'s commit window closes
    // at the first await (see its window-integrity cases).
    return await dispatchTool(backend, getTsHost, route, name, args, getPreferredEngine, getVlm, peaksPathFor, client)
  } catch (e) {
    if (e instanceof UnknownToolError) throw e
    // The motif store's failures are the caller's — an unknown draft, an id
    // already installed — so a plain message there is `invalid_params`. A
    // compute or hybrid failure is not, unless it reads like an argument fault,
    // which `thrownToToolError` tells apart.
    return toolErrorResult(thrownToToolError(e, route === 'motif' ? 'invalid_params' : 'internal', name))
  }
}

/** True when a host is attached and the user has no project open. A host
 *  without the record (a test stub) is not gated. */
function noProjectOpen(tsHost: TsActorHost | null): boolean {
  return typeof tsHost?.openedProject === 'function' && tsHost.openedProject() === null
}

async function isKnownTool(backend: Backend, name: string): Promise<boolean> {
  if (MCP_TOOLS.has(name) || HYBRID_TOOLS.has(name) || routeMcpTool(name) === 'motif') return true
  return (await rustCatalog(backend)).tools.some((t) => t.name === name)
}

async function dispatchTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  route: ReturnType<typeof routeMcpTool>,
  name: string,
  args: Record<string, unknown>,
  getPreferredEngine: () => string | null,
  getVlm: VlmProvider,
  peaksPathFor: PeaksPathProvider,
  client: string | undefined,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost?.agent && ['begin_agent_session', 'end_agent_session', 'set_history_lock'].includes(name)) {
    try {
      // Every arm reads its args through the tool's own parser, so a refusal
      // reads the same whichever path reaches the service, and answers with
      // the record it committed like every other mutator.
      let result: Record<string, unknown>
      if (name === 'begin_agent_session') {
        const p = mcpDef('begin_agent_session').parseDedicated!(args)
        result = tsHost.agent.begin(p.reason as string) as unknown as Record<string, unknown>
      } else if (name === 'end_agent_session') {
        // Answer with the session that ended (null when none was active), so a
        // takeover says whose work it closed.
        const p = mcpDef('end_agent_session').parseDedicated!(args)
        const active = tsHost.agent.snapshot().session
        tsHost.agent.end(p.force === true ? 'forced' : 'agent')
        result = { ended: active === null ? null : tsHost.agent.snapshot().sessions.find((x) => x.id === active.id) ?? active }
      } else {
        // The lock is taken here rather than through mcpCall because the OWNER
        // is the connection, which only this seam knows.
        const p = mcpDef('set_history_lock').parseDedicated!(args)
        if (p.locked as boolean) tsHost.agent.lock(p.reason as string)
        else tsHost.agent.unlock()
        result = { locked: p.locked as boolean, reason: (p.reason as string | undefined) ?? null }
      }
      return toolRecord(result) as ServerResult
    } catch (e) {
      return toolErrorResult({ code: 'invalid_params', message: e instanceof Error ? e.message : String(e) })
    }
  }
  if (tsHost) {
    // Opening swaps the actor's whole state and moves the editor with it, so
    // the host runs these, not the actor (`projectTools.ts`).
    if (PROJECT_TOOLS.has(name) && tsHost.projects) return runProjectTool(tsHost, name, args)
    // The session view lives in the host's activity service, not the actor, so
    // it is answered here — the same record `project://session` serves.
    if (name === 'read_project' && args.view === 'session' && tsHost.agent) {
      return toolRecord(sessionView(tsHost)) as unknown as ServerResult
    }
    // The effects vocabulary is a catalog, not project state, so it is answered
    // here — the same record `effects://catalog` serves.
    if (name === 'read_project' && args.view === 'effects') {
      return toolRecord(effectsCatalogView()) as unknown as ServerResult
    }
    // The two picture views for a client without resources: served by the same
    // Rust reader `media://{id}/thumbnail` and `media://{id}/frame/{t_us}` use,
    // and answered as an IMAGE content block, which is what a model can look at.
    // A derivative not yet generated refuses with the reader's own hint.
    if (name === 'read_project' && (args.view === 'media_thumbnail' || args.view === 'media_frame')) {
      const p = mcpDef('read_project').parseDedicated!(args)
      const uri = p.view === 'media_frame' ? `media://${p.id as string}/frame/${p.t_us as number}` : `media://${p.id as string}/thumbnail`
      // The resource reader answers a missing id with the resource vocabulary
      // (`not_found`, which over tools means "no such tool"); as a tool call it
      // is a bad argument, and the reader's own sentence says which.
      const res = await handleReadResource(backend, () => tsHost, uri, getVlm).catch((e: unknown) => {
        throw new McpArgError(e instanceof Error ? e.message : String(e), 'id')
      })
      const first = (res as { contents?: Array<{ blob?: string; text?: string; mimeType?: string }> }).contents?.[0]
      if (first?.blob) return { content: [{ type: 'image', data: first.blob, mimeType: first.mimeType ?? 'image/jpeg' }] } as unknown as ServerResult
      return { content: [{ type: 'text', text: first?.text ?? '' }] } as unknown as ServerResult
    }
    if (route === 'ts') {
      const r = tsHost.mcpCall(name, JSON.stringify(args), client)
      if (!r.ok) {
        if (r.error.code === 'not_found') throw new UnknownToolError(name)
        return toolErrorResult(r.error)
      }
      return r.result as unknown as ServerResult
    }
    if (route === 'hybrid') {
      const refused = await refuseBadArgs(backend, name, args)
      if (refused) return refused
      // Native-compute → TS-write. `runHybrid` answers a string (the renderer's
      // IPC contract); the agent gets the committed record read back from the
      // snapshots around the call (`hybridResult.ts`).
      // Every commit the hybrid makes records as this call's agent: `by` rides
      // each synchronous dispatch, so a second hybrid in flight cannot cross it.
      const by = mcpActor(client)
      const hybridActor = tsHost.hybridDeps.actor
      const deps = { ...tsHost.hybridDeps, actor: { ...hybridActor, dispatch: (c: string, a: Record<string, unknown>) => hybridActor.dispatch(c, a, by) } }
      const before = tsHost.actor.snapshot()
      const result = await runHybrid(name, args, deps)
      return shapeHybridResult(name, args, result, before, tsHost.actor.snapshot()) as unknown as ServerResult
    }
    if (route === 'motif') {
      // Catalog-read + authoring + install, served in TS. The raw value
      // is shaped to the Rust-faithful ToolResult (list_motifs strips html, etc.).
      const refused = await refuseBadArgs(backend, name, args)
      if (refused) return refused
      const raw = tsHost.motifTool(name, args)
      return shapeMotifMcpResult(name, raw, args) as unknown as ServerResult
    }
    // Clip compute routes to 'rust', but the Rust core holds no state — the
    // slice is resolved here from the actor and forwarded.
    //
    // Two-slice compute (compare_frames) resolves BOTH nested { a, b } clip
    // slices. Kept separate from the single-slice call below, which reads a
    // top-level `layer_id`.
    if (TWO_SLICE_TOOLS.has(name)) {
      const refused = await refuseBadArgs(backend, name, args)
      if (refused) return refused
      const merged = resolveTwoSliceArgs(args, tsHost.actor.snapshot())
      return unwrapToolEnvelope(await backend.mcpCallTool(name, JSON.stringify(merged)), name)
    }
    if (CLIP_SLICE_TOOLS.has(name)) {
      const refused = await refuseBadArgs(backend, name, args)
      if (refused) return refused
      // Throws the SDK-shaped envelope error for the renderer's sake; the outer
      // catch maps its code back onto an `isError` result for the agent.
      return callClipComputeTool(backend, tsHost, name, args, getPreferredEngine, getVlm, peaksPathFor)
    }
    // route === 'rust' → fall through (other reads are served by the backend).
  }
  if (name === 'preview_motif_draft') {
    const a = args as { id?: string; motif_id?: string; t_sec?: number; props?: unknown; width?: number | null; height?: number | null }
    const motifId = a.id ?? a.motif_id ?? ''
    // The catalog entry, as `list_motifs` reports it — it IS the manifest plus a
    // few catalog fields, so it serves both the advertised default size and the
    // props defaults below. A bare-core call (no host) has no catalog to ask:
    // 480 is its floor and the props go through as sent.
    const entry = tsHost
      ? (tsHost.motifTool('list_motifs', {}) as Array<Record<string, unknown> & { id: string; size?: [number, number] }>).find((m) => m.id === motifId)
      : undefined
    if (tsHost && !entry) return toolErrorResult({ code: 'invalid_params', message: `unknown Motif id '${motifId}' — list_motifs reports the built-in, installed and draft ids` })
    // Props canonicalised against the manifest exactly as `add_motif_layer` does:
    // missing keys take the schema defaults (a lower third previews WITH its
    // text), an unknown key is refused naming it.
    let props: Record<string, unknown> = (a.props ?? {}) as Record<string, unknown>
    if (entry) {
      try { props = canonicalizeProps(entry as unknown as Manifest, a.props ?? null) }
      catch (e) { if (e instanceof MotifPropError) return toolErrorResult({ code: 'invalid_params', message: `invalid props for '${motifId}': ${e.detail} — list_motifs reports its props_schema` }); throw e }
    }
    const b64 = await captureMotifFrameB64({
      motifId, tSec: a.t_sec ?? 0, propsJson: JSON.stringify(props),
      width: a.width ?? entry?.size?.[0] ?? 480, height: a.height ?? entry?.size?.[1] ?? 480, settleRafs: null, contentHash: '',
    })
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] } as unknown as ServerResult
  }
  // Decided HERE, from the catalog this process advertises, rather than left to
  // the backend's `not_found` envelope: the name is known or it is not, and a
  // malformed request should not cost a native round trip to say so. A TS tool
  // is known even with no host (the bare-core forward the tests exercise).
  if (!MCP_TOOLS.has(name) && !(await rustCatalog(backend)).tools.some((t) => t.name === name)) throw new UnknownToolError(name)
  const refused = await refuseBadArgs(backend, name, args)
  if (refused) return refused
  return unwrapToolEnvelope(await backend.mcpCallTool(name, JSON.stringify(args)), name)
}

/** `project://session` / `read_project { view: "session" }`: who holds the work
 *  session, so an agent refused with `AgentSessionBusy` can see the holder, its
 *  reason and its age before deciding to wait or to take over. `sessions` is the
 *  recent history the panel keeps; `lock_reason` is the history lock. `project`
 *  is the project the user has open (null on the start screen), with the Recents
 *  list and default parent folder `open_project` / `create_project` draw on.
 *  The resource defs themselves live in `hostResources.ts`. */
export function sessionView(host: Pick<TsActorHost, 'agent'> & Partial<Pick<TsActorHost, 'projectStatus'>>): Record<string, unknown> {
  const snap = host.agent.snapshot()
  return {
    active: snap.session, sessions: snap.sessions.slice(-10), lock_reason: snap.lock_reason,
    ...(host.projectStatus ? host.projectStatus() : {}),
  }
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
    if (uri === 'project://session' && tsHost.agent) {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(sessionView(tsHost), null, 2) }] } as unknown as ServerResult
    }
    if (uri === 'effects://catalog') {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(effectsCatalogView(), null, 2) }] } as unknown as ServerResult
    }
    if (uri === 'motifs://current') {
      const raw = tsHost.motifTool('list_motifs', {}) as Array<Record<string, unknown>>
      const list = raw.map((e) => { const { html: _html, ...rest } = e; return rest })
      return { contents: [{ uri: 'motifs://current', mimeType: 'application/json', text: JSON.stringify(list) }] } as unknown as ServerResult
    }
    // A resource read has no isError slot, so the start-screen refusal is the
    // protocol error, with the same text the tools answer.
    if (noProjectOpen(tsHost) && !APP_SCOPE_RESOURCES.has(uri)) throw new McpError(ErrorCode.InvalidRequest, NO_PROJECT_OPEN_MESSAGE)
    const served = serveProjectResource(uri, tsHost.actor)
    if (served) return served
    // project://compiled / media://* / composition://meter stay Rust compute —
    // inject the project / MediaItem / nothing the stateless reader now needs.
    const vlm = getVlm()
    const injection = buildResourceInjection(uri, tsHost.actor.snapshot(), vlm.config, {
      language: vlm.language,
      fps: vlm.fps,
      focus: vlm.focus,
      // The preference too, and for the same reason the other three ride along:
      // the backend it resolves and that backend's model label are hashed into
      // the description cache key, so a read that walked the plain availability
      // order would answer out of a view no gesture ever writes.
      preferred: vlm.preferred,
    })
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

/** The cached description for one source under the view the app's settings name
 *  — the resolver's backend at the configured sampling, focus and UI language —
 *  or `null` when nothing is cached there, read through the SAME
 *  `media://{id}/description` resource an agent reads.
 *
 *  Exported for the renderer's description channel (`index.ts`), the way
 *  `readMediaFrameDataUrl` is. This resource serves ONE view, and the injection
 *  is what makes it the right one: the same provider fills the tool's omitted
 *  view arguments, so what a gesture writes is what a Panel reopened in a later
 *  session finds.
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
  connectionId?: string
  /** What `initialize` reports as the server version. `startMcpHost` injects
   *  `app.getVersion()`, which is package.json's — this file stays
   *  Electron-free so Vitest can load it, so the real value can only arrive as
   *  a seam. Absent (tests, a direct `buildMcpServer`) reports `0.0.0-dev`. */
  version?: string
  getTsHost?: () => TsActorHost | null
  getPreferredEngine?: () => string | null
  getVlm?: VlmProvider
  /** Resolves a subject Audio layer to the baked peaks file `detect_pauses`
   *  must read. Omitted → the raw media peaks, the pre-bake behaviour. */
  peaksPathFor?: PeaksPathProvider
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
  const peaksPathFor = opts.peaksPathFor ?? NO_PEAKS_PATH
  // `observe` is the session's to supply, not the caller's: it is the one log
  // seam that needs the routing table and the actor. An un-instrumented build
  // gets no window at all — nothing would read it, and the subscribe/unsubscribe
  // per call would be pure churn.
  const log: McpLogDeps = opts.log ? { ...opts.log, observe: mcpCommitObserver(getTsHost) } : NO_MCP_LOG
  // `instructions` rides on `initialize`: the ten-line etiquette every client
  // reads before its first call (`instructions.ts`). `version` is the app's
  // (`app.getVersion()` in `mcp/index.ts`); a bare `electron.exe out/main`
  // dev launch reports Electron's, since there is no package.json in that path.
  const server = new Server(
    { name: 'weftcut', version: opts.version ?? '0.0.0-dev' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: MCP_INSTRUCTIONS },
  )
  // One Server per session (`mcp/index.ts`), so this closure resolves to the
  // client that opened *this* session — `undefined` until it has initialized.
  const clientInfo = (): { name: string; version?: string } | undefined => server.getClientVersion()

  const connectionId = opts.connectionId ?? randomUUID()
  // Read or write is the catalog's own `readOnlyHint` — the one statement of
  // the split, so the agent panel's read rows and the annotations a
  // client sees cannot disagree. A non-tool method (a list, a resource read)
  // is a read by nature; a tool name the catalog does not know is logged as an
  // operation and refused as unknown by the dispatcher. Resolved on the first
  // tracked call, not at build: a host without an agent service never asks.
  const track: typeof withLog = (method, handler, deps, client) => withLog(method, async (req, extra) => {
    const service = getTsHost()?.agent
    if (!service) return handler(req, extra)
    const params = (req.params ?? {}) as Record<string, unknown>
    const tool = method === 'tools/call' ? String(params.name ?? '') : method
    const read = method !== 'tools/call' || (await readOnlyTools(backend)).has(tool)
    return service.run(connectionId, clientInfo()?.name ?? 'MCP', tool,
      method === 'tools/call' ? params.arguments ?? {} : params, read, () => handler(req, extra))
  }, deps, client)

  // Every handler goes through withLog: the funnel is what keeps a newly added
  // tool logged with nothing to remember. See `docs/status-log.md`.
  server.setRequestHandler(ListToolsRequestSchema, track('tools/list', async () => {
    const rust = (await rustCatalog(backend)).tools
    return { tools: mergeMcpCatalog(rust, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]) } as unknown as ServerResult
  }, log, clientInfo))
  // A retired tool name is rewritten to the advertised one BEFORE `track`, so
  // the log row, the activity service's read/write split and the dispatcher all
  // read the same single name (`toolAliases.ts`).
  const callTool = track('tools/call', async (req: CallToolRequest) =>
    handleCallTool(backend, getTsHost, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, getPreferredEngine, getVlm, peaksPathFor, clientInfo()?.name),
  log, clientInfo)
  server.setRequestHandler(CallToolRequestSchema, (req: CallToolRequest, extra: unknown) =>
    callTool(withCanonicalToolName(req), extra))
  server.setRequestHandler(ListResourcesRequestSchema, track('resources/list', async () => {
    const cat = await rustCatalog(backend)
    return { resources: mergeMcpResources(cat.resources, [...MOTIF_RESOURCE_DEFS, ...HOST_RESOURCE_DEFS]) } as unknown as ServerResult
  }, log, clientInfo))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, track('resources/templates/list', async () => {
    return { resourceTemplates: HOST_RESOURCE_TEMPLATES } as unknown as ServerResult
  }, log, clientInfo))
  server.setRequestHandler(ReadResourceRequestSchema, track('resources/read', async (req: ReadResourceRequest) =>
    handleReadResource(backend, getTsHost, req.params.uri, getVlm),
  log, clientInfo))
  server.setRequestHandler(ListPromptsRequestSchema, track('prompts/list', async () => {
    return { prompts: JSON.parse(await backend.mcpListPrompts()) } as unknown as ServerResult
  }, log, clientInfo))
  server.setRequestHandler(GetPromptRequestSchema, track('prompts/get', async (req: GetPromptRequest) => {
    return unwrap(
      await backend.mcpGetPrompt(req.params.name, JSON.stringify(req.params.arguments ?? {})),
    ) as ServerResult
  }, log, clientInfo))

  return server
}
