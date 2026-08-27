import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { ActorHandle } from './actor'
import type { Composition, Layer, Project } from './model'
import { eachLayer, rootComposition } from './model'
import { serializeProject } from './serialize'

const APP_JSON = 'application/json'
const PREFIX_LAYERS = 'project://layers/'
const PREFIX_MEDIA = 'media://'

/** Build a Rust-faithful text ResourceResult: one application/json content block
 *  whose `text` is the pretty-printed body (matches resources.rs `text_resource`). */
function textResource(uri: string, body: unknown): ServerResult {
  return { contents: [{ uri, mimeType: APP_JSON, text: JSON.stringify(body, null, 2) }] } as unknown as ServerResult
}

/** `project://composition` keeps its documented meaning — canvas size, fps,
 *  sample rate, colour space, background (docs/mcp.md) — by projecting the root's
 *  SETTINGS. Emitting the whole root would ship every track on a resource an
 *  agent reads for the frame size. */
export function compositionSettings(c: Composition): Record<string, unknown> {
  return { id: c.id, label: c.label, width: c.width, height: c.height, fps: c.fps, duration_us: c.duration_us,
    duration_pinned: c.duration_pinned, sample_rate: c.sample_rate, channels: c.channels,
    color_space: c.color_space, background: c.background }
}

/** Throw the SDK-shaped not-found error (code -32601), mirroring Rust's
 *  `McpToolError::resource_not_found`. */
function resourceNotFound(message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = -32601
  throw e
}

/** `project://compositions` rows: every composition with how many
 *  `CompositionRef` layers point at it — 0 for the root (never referenced) and
 *  for an orphan, which is legal state (ADR 0052 §3). */
export function compositionListing(p: Project): Array<{ id: string; label: string | null; duration_us: number; ref_count: number }> {
  const refs = new Map<string, number>()
  for (const { layer } of eachLayer(p))
    if (layer.params.kind === 'CompositionRef') refs.set(layer.params.composition, (refs.get(layer.params.composition) ?? 0) + 1)
  return Object.values(p.compositions).map((c) => ({ id: c.id, label: c.label, duration_us: c.duration_us, ref_count: refs.get(c.id) ?? 0 }))
}

/** The composition a `?composition=<id>` query selects, the root when absent.
 *  Not-found for an unknown id, so an agent that guessed wrong learns it from
 *  the read rather than from an empty track list. */
function scopedComposition(p: Project, query: string | null): Composition {
  if (query === null) return rootComposition(p)
  const c = p.compositions[query]
  if (!c) return resourceNotFound(`composition ${query} not found`)
  return c
}

/** Serve a `project://*` state-view resource directly from the actor (the sole
 *  state owner): returns the wire ResourceResult, or `null` when the URI
 *  is a Rust-compute resource (`project://compiled`, `media://*`,
 *  `composition://meter`) the host forwards to the backend with an injected slice.
 *  Throws not-found for a bad `project://layers/{id}` URI or an unknown
 *  `?composition=` id. */
export function serveProjectResource(
  uri: string,
  actor: Pick<ActorHandle, 'snapshot' | 'historyView'>,
): ServerResult | null {
  if (uri.startsWith(PREFIX_LAYERS)) {
    const tail = uri.slice(PREFIX_LAYERS.length)
    const slash = tail.indexOf('/')
    if (slash !== -1) resourceNotFound(`unsupported layer sub-resource '${tail.slice(slash + 1)}'`)
    let layer: Layer | undefined
    for (const e of eachLayer(actor.snapshot())) if (e.layer.id === tail) { layer = e.layer; break }
    if (!layer) resourceNotFound(`layer ${tail} not found`)
    return textResource(uri, layer)
  }
  // `project://tracks` and `project://markers` are per composition:
  // `?composition=<id>` selects one, absent means the root.
  const q = uri.indexOf('?')
  const base = q === -1 ? uri : uri.slice(0, q)
  const composition = q === -1 ? null : new URLSearchParams(uri.slice(q + 1)).get('composition')
  switch (base) {
    case 'project://current': return textResource(uri, serializeProject(actor.snapshot()))
    case 'project://composition': return textResource(uri, compositionSettings(rootComposition(actor.snapshot())))
    case 'project://compositions': return textResource(uri, compositionListing(actor.snapshot()))
    case 'project://media': return textResource(uri, actor.snapshot().media_pool)
    case 'project://tracks': return textResource(uri, scopedComposition(actor.snapshot(), composition).tracks)
    case 'project://markers': return textResource(uri, scopedComposition(actor.snapshot(), composition).markers)
    case 'project://history': return textResource(uri, actor.historyView(100))
    default: return null
  }
}

/** Build the injected-state JSON the backend's `mcpReadResource` needs for the
 *  resources that stay Rust compute: `project://compiled` gets the full
 *  project (audio mix plan); `media://*` gets the MediaItem resolved by id;
 *  `composition://meter` gets nothing. */
export function buildResourceInjection(
  uri: string,
  snapshot: Project,
  vlmConfig: Record<string, unknown> = {},
): string {
  if (uri === 'project://compiled') return JSON.stringify({ project: serializeProject(snapshot) })
  if (uri.startsWith(PREFIX_MEDIA)) {
    const id = uri.slice(PREFIX_MEDIA.length).split('/')[0] ?? ''
    const media = snapshot.media_pool[id] ?? null
    // media://{id}/description additionally needs the merged VLM backend config
    // (stateless, ADR 0024) so the cached-view reader can resolve the default
    // backend + compute the cache key. The always-computable media reads
    // (/thumbnail, /frame, /waveform, and the shot-layer /analysis view) are
    // self-contained — they need only the resolved MediaItem, no injected config.
    if (uri.endsWith('/description')) return JSON.stringify({ media, vlm_config: vlmConfig })
    return JSON.stringify({ media })
  }
  return '{}'
}
