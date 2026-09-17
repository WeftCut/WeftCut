import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { ActorHandle } from './actor'
import type { Animated, Composition, Layer, Project } from './model'
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

/** The animatable params of a layer whose track is Keyframed, by the
 *  `param_key` the keyframe tools take — so an envelope says what moves without
 *  shipping the keys. The walk mirrors `mutations/animated.ts` but keeps the
 *  NAMES, which that walk (built for rebasing times) has no use for. */
export function keyframedParams(layer: Layer): string[] {
  const out: string[] = []
  const note = (key: string, track: Animated<unknown> | undefined): void => { if (track?.mode === 'Keyframed') out.push(key) }
  const p = layer.params as unknown as {
    transform?: { position: { mode: 'XY'; x: Animated<number>; y: Animated<number> } | { mode: 'Path'; progress: Animated<number> }
      scale_x: Animated<number>; scale_y: Animated<number>; rotation_deg: Animated<number>; anchor_x: Animated<number>; anchor_y: Animated<number> }
    opacity?: Animated<number>; color?: Animated<unknown>; gain_db?: Animated<number>; pan?: Animated<number>
  }
  if (p.transform) {
    const t = p.transform
    if (t.position.mode === 'Path') note('path_progress', t.position.progress)
    else { note('x', t.position.x); note('y', t.position.y) }
    note('scale_x', t.scale_x); note('scale_y', t.scale_y); note('rotation_deg', t.rotation_deg); note('anchor_x', t.anchor_x); note('anchor_y', t.anchor_y)
  }
  note('opacity', p.opacity); note('color', p.color); note('gain_db', p.gain_db); note('pan', p.pan)
  for (const e of layer.effects) for (const [k, track] of Object.entries(e.params)) note(`effects[${e.id}].params[${k}]`, track)
  return out
}

/** A layer as `project://tracks` lists it: the envelope an agent plans against
 *  — where it sits, what it is, what it plays, what is on it — without the
 *  params, keyframes and effect values `project://layers/{id}` carries. The
 *  audit found the "envelopes" the docs promised were whole layers (D19), so a
 *  timeline read cost as much as the project. */
export function layerEnvelope(layer: Layer, c: Composition): Record<string, unknown> {
  const p = layer.params as unknown as { kind: string; src_in_us?: number; src_out_us?: number }
  return {
    id: layer.id, label: layer.label, kind: p.kind,
    t_start_us: layer.t_start_us, t_end_us: layer.t_end_us,
    ...(typeof p.src_in_us === 'number' ? { src_in_us: p.src_in_us } : {}),
    ...(typeof p.src_out_us === 'number' ? { src_out_us: p.src_out_us } : {}),
    enabled: layer.enabled, locked: layer.locked,
    link_id: c.links.find((g) => g.members.includes(layer.id))?.id ?? null,
    effects: layer.effects.map((e) => ({ id: e.id, kind: e.kind })),
    keyframed: keyframedParams(layer),
  }
}

/** `project://tracks`: every track with its flags and its layers as envelopes.
 *
 *  `muted` / `solo` are stored on a track but nothing mixes by them — the mix
 *  gates by ROLE (`set_role_flags`; `audio/mix.rs` and the renderer's
 *  `roleGate.ts` read roles only). A read that advertised them would advertise
 *  a control with no writer and no effect (audit §3), so they stay off the wire
 *  until the mix reads them. */
export function trackEnvelopes(c: Composition): Array<Record<string, unknown>> {
  return c.tracks.map(({ layers, muted: _muted, solo: _solo, ...track }) => ({ ...track, layers: layers.map((l) => layerEnvelope(l, c)) }))
}

/** `project://settings`: the editing preferences plus the project metadata —
 *  six booleans and a dirty signal that used to cost the whole
 *  `project://current` (audit S14). `modified_at` moves on every recorded commit. */
export function settingsView(p: Project): Record<string, unknown> {
  return { ...p.settings, metadata: p.metadata }
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
  // The per-composition views take `?composition=<id>`; absent means the root.
  // `project://composition` too: a Group's envelope used to be write-only, the
  // scoped read answering with the ROOT under the requested URI (audit S14).
  const q = uri.indexOf('?')
  const base = q === -1 ? uri : uri.slice(0, q)
  const composition = q === -1 ? null : new URLSearchParams(uri.slice(q + 1)).get('composition')
  const snap = actor.snapshot()
  switch (base) {
    case 'project://current': return textResource(uri, serializeProject(snap))
    case 'project://composition': return textResource(uri, compositionSettings(scopedComposition(snap, composition)))
    case 'project://compositions': return textResource(uri, compositionListing(snap))
    case 'project://media': return textResource(uri, snap.media_pool)
    case 'project://tracks': return textResource(uri, trackEnvelopes(scopedComposition(snap, composition)))
    case 'project://markers': return textResource(uri, scopedComposition(snap, composition).markers)
    case 'project://links': return textResource(uri, scopedComposition(snap, composition).links)
    case 'project://transitions': return textResource(uri, scopedComposition(snap, composition).transitions)
    case 'project://settings': return textResource(uri, settingsView(snap))
    case 'project://history': return textResource(uri, actor.historyView(100))
    default: return null
  }
}

/** The description cache-key inputs the app's UI owns, as one value.
 *
 *  Grouped because they are one thing — the VIEW a read resolves — and because
 *  `media://{id}/description` is addressed by URI and has no argument to carry
 *  them. Every field optional: a caller with no UI to speak for injects nothing
 *  and Rust's own defaults decide. */
export interface DescribeView {
  language?: string | null
  fps?: number | null
  focus?: string | null
  /** The SOFT preferred engine, `'auto'` or null for none. A cache-key axis like
   *  the other three — the resolved backend and its model label are both hashed
   *  into the key — so a read that omitted it would answer out of whatever the
   *  plain availability order picks while `describe_clip` writes under the
   *  preferred engine, and the rows would report every source as undescribed. */
  preferred?: string | null
}

/** Build the injected-state JSON the backend's `mcpReadResource` needs for the
 *  resources that stay Rust compute: `project://compiled` gets the full
 *  project (audio mix plan); `media://*` gets the MediaItem resolved by id;
 *  `composition://meter` gets nothing. */
export function buildResourceInjection(
  uri: string,
  snapshot: Project,
  vlmConfig: Record<string, unknown> = {},
  view: DescribeView = {},
): string {
  if (uri === 'project://compiled') return JSON.stringify({ project: serializeProject(snapshot) })
  if (uri.startsWith(PREFIX_MEDIA)) {
    const id = uri.slice(PREFIX_MEDIA.length).split('/')[0] ?? ''
    const media = snapshot.media_pool[id] ?? null
    // media://{id}/description additionally needs the merged VLM backend config
    // (stateless, ADR 0024) so the cached-view reader can resolve the backend +
    // compute the cache key — and the four view axes that are part of that same
    // key, from the one provider `describe_clip`'s injection also reads. The
    // always-computable media reads (/thumbnail, /frame, /waveform, and the
    // shot-layer /analysis view) are self-contained — they need only the
    // resolved MediaItem, no injected config.
    if (uri.endsWith('/description')) {
      // Each axis omitted when there is no UI to speak for, so Rust's own
      // default decides — the `detectPauses` rule, stated once here rather
      // than once per axis. `'auto'` is such an absence: it is the setting's way
      // of saying "no preference", and the same value the tool path declines to
      // send as `preferred_backend` (`mcp/server.ts`).
      return JSON.stringify({
        media,
        vlm_config: vlmConfig,
        ...(view.language ? { language: view.language } : {}),
        ...(view.fps == null ? {} : { describe_fps: view.fps }),
        ...(view.focus ? { describe_focus: view.focus } : {}),
        ...(view.preferred && view.preferred !== 'auto'
          ? { describe_preferred: view.preferred }
          : {}),
      })
    }
    return JSON.stringify({ media })
  }
  return '{}'
}
