// apps/desktop/src/main/state/mcp-results.ts
//
// What a mutator ANSWERS with: the committed record(s), read back from the
// snapshot the commit produced, so the caller learns where its edit landed
// without a second round trip. Before this every write returned `content: []`
// or a bare id, and an agent that had just placed a clip re-read
// `project://tracks` (48–123 KB) to find out that the start snapped, that a
// paired audio layer landed too, or which link it joined — the audit's
// testers spent most of their calls on exactly that.
//
// The readers are PURE over two snapshots and the wire args: nothing here
// touches the actor, and every reader can be driven from a unit test with two
// hand-built projects. The same object goes out twice — as `structuredContent`
// for clients that forward it, and serialized (sorted keys, compact) as the
// text block, which is the part every client shows the model.
//
// `adjusted[]` names each numeric field whose applied value differs from the
// requested one (today: the frame/sample-grid snap). The policy for what may be
// adjusted silently and what must refuse lives with the mutations; this file
// only reports the difference.
import type { Composition, Layer, Project, Uuid } from './model'
import { eachLayer } from './model'
import type { HistoryStatus } from './history'
import { sortKeys } from './canonical'
import { compositionSettings } from './resource-views'
import type { ToolResultJson } from './mcp-commands'

// ── Records ──────────────────────────────────────────────────────────────────

/** A layer's ENVELOPE: where it sits and what it is, never its params — those
 *  are `project://layers/{id}`'s, and a keyframed track can be kilobytes. */
export interface LayerRecord {
  layer_id: Uuid
  track_id: Uuid
  composition_id: Uuid
  kind: string
  label: string | null
  t_start_us: number
  t_end_us: number
  src_in_us?: number
  src_out_us?: number
  enabled: boolean
  locked: boolean
  /** The link this layer is a member of, or null. What `move_layer` and
   *  `trim_layer` fan out along, and what a transition refuses across. */
  link_id: Uuid | null
}

function located(p: Project, id: Uuid): { comp: Composition; trackId: Uuid; layer: Layer } | null {
  for (const { composition, track, layer } of eachLayer(p)) if (layer.id === id) return { comp: composition, trackId: track.id, layer }
  return null
}

export function layerRecord(p: Project, id: Uuid): LayerRecord | null {
  const hit = located(p, id)
  if (!hit) return null
  const { comp, trackId, layer } = hit
  const params = layer.params as { kind: string; src_in_us?: number; src_out_us?: number }
  return {
    layer_id: layer.id, track_id: trackId, composition_id: comp.id, kind: params.kind, label: layer.label,
    t_start_us: layer.t_start_us, t_end_us: layer.t_end_us,
    ...(typeof params.src_in_us === 'number' ? { src_in_us: params.src_in_us } : {}),
    ...(typeof params.src_out_us === 'number' ? { src_out_us: params.src_out_us } : {}),
    enabled: layer.enabled, locked: layer.locked,
    link_id: comp.links.find((l) => l.members.includes(layer.id))?.id ?? null,
  }
}

/** Records for the ids that still exist, in input order; a missing id is
 *  skipped rather than reported — a reader never refuses. */
export function layerRecords(p: Project, ids: readonly Uuid[]): LayerRecord[] {
  const out: LayerRecord[] = []
  for (const id of ids) { const r = layerRecord(p, id); if (r) out.push(r) }
  return out
}

export interface TrackRecord {
  track_id: Uuid; composition_id: Uuid; label: string | null; role: string | null
  /** Position in the composition's stack; 0 is the bottom. */
  index: number
  enabled: boolean; locked: boolean
  /** How many layers it holds — 0 is the one a later delete prunes. */
  layers: number
}
export function trackRecord(p: Project, id: Uuid): TrackRecord | null {
  for (const c of Object.values(p.compositions)) {
    const index = c.tracks.findIndex((t) => t.id === id)
    if (index < 0) continue
    const t = c.tracks[index]
    return { track_id: t.id, composition_id: c.id, label: t.label, role: t.role, index, enabled: t.enabled, locked: t.locked, layers: t.layers.length }
  }
  return null
}

export interface MarkerRecord {
  marker_id: Uuid; composition_id: Uuid; t_us: number; end_t_us: number | null
  label: string; note: string; color: { r: number; g: number; b: number; a: number }
  anchor: { layer: Uuid; src_us: number } | null
}
export function markerRecord(p: Project, id: Uuid): MarkerRecord | null {
  for (const c of Object.values(p.compositions)) {
    const m = c.markers.find((x) => x.id === id)
    if (m) return { marker_id: m.id, composition_id: c.id, t_us: m.t_us, end_t_us: m.end_t_us, label: m.label, note: m.note, color: m.color, anchor: m.anchor }
  }
  return null
}

export interface TransitionRecord {
  transition_id: Uuid; composition_id: Uuid; from_layer_id: Uuid; to_layer_id: Uuid
  duration_us: number; extended_us: number; kind: string; direction?: string
}
export function transitionRecord(p: Project, id: Uuid): TransitionRecord | null {
  for (const c of Object.values(p.compositions)) {
    const t = c.transitions.find((x) => x.id === id)
    if (!t) continue
    return {
      transition_id: t.id, composition_id: c.id, from_layer_id: t.from_layer, to_layer_id: t.to_layer,
      duration_us: t.duration_us, extended_us: t.extended_us, kind: t.kind.kind,
      ...('direction' in t.kind ? { direction: t.kind.direction } : {}),
    }
  }
  return null
}

export interface LinkRecord { link_id: Uuid; composition_id: Uuid; members: Uuid[]; label: string | null }
export function linkRecord(p: Project, id: Uuid): LinkRecord | null {
  for (const c of Object.values(p.compositions)) {
    const l = c.links.find((x) => x.id === id)
    if (l) return { link_id: l.id, composition_id: c.id, members: [...l.members], label: l.label ?? null }
  }
  return null
}

export interface EffectRecord { effect_id: Uuid; layer_id: Uuid; kind: string; enabled: boolean; index: number; params: Record<string, unknown> }
export function effectRecord(p: Project, layerId: Uuid, effectId: Uuid): EffectRecord | null {
  const hit = located(p, layerId)
  if (!hit) return null
  const index = hit.layer.effects.findIndex((e) => e.id === effectId)
  if (index < 0) return null
  const e = hit.layer.effects[index]
  return { effect_id: e.id, layer_id: layerId, kind: e.kind, enabled: e.enabled, index, params: e.params }
}

export interface MediaRecord {
  media_id: Uuid; kind: string; label: string | null; path: string
  duration_us: number | null; width: number | null; height: number | null; has_audio: boolean
}
export function mediaRecord(p: Project, id: Uuid): MediaRecord | null {
  const m = p.media_pool[id]
  if (!m) return null
  return {
    media_id: m.id, kind: m.kind, label: m.label, path: m.path_abs,
    duration_us: m.metadata.duration_us ?? null,
    width: m.metadata.video?.width ?? null, height: m.metadata.video?.height ?? null,
    has_audio: m.kind === 'Audio' || m.metadata.audio != null,
  }
}

// ── Diffs between the two snapshots ─────────────────────────────────────────

function layerIds(p: Project): Set<Uuid> {
  const out = new Set<Uuid>()
  for (const { layer } of eachLayer(p)) out.add(layer.id)
  return out
}
export function newLayerIds(before: Project, after: Project): Uuid[] {
  const was = layerIds(before)
  return [...layerIds(after)].filter((id) => !was.has(id))
}
export function removedLayerIds(before: Project, after: Project): Uuid[] {
  const is = layerIds(after)
  return [...layerIds(before)].filter((id) => !is.has(id))
}
function trackIds(p: Project): Set<Uuid> {
  return new Set(Object.values(p.compositions).flatMap((c) => c.tracks.map((t) => t.id)))
}
export function prunedTrackIds(before: Project, after: Project): Uuid[] {
  const is = trackIds(after)
  return [...trackIds(before)].filter((id) => !is.has(id))
}
/** Layers present in BOTH snapshots whose span or track changed, minus
 *  `exclude` — the link siblings a move dragged along, everything a ripple
 *  shifted, the incoming layer a transition placed. */
export function movedLayers(before: Project, after: Project, exclude: ReadonlySet<Uuid> = new Set()): LayerRecord[] {
  const out: LayerRecord[] = []
  for (const { track, layer } of eachLayer(after)) {
    if (exclude.has(layer.id)) continue
    const prev = located(before, layer.id)
    if (!prev) continue
    if (prev.layer.t_start_us !== layer.t_start_us || prev.layer.t_end_us !== layer.t_end_us || prev.trackId !== track.id) {
      const r = layerRecord(after, layer.id)
      if (r) out.push(r)
    }
  }
  return out
}

/** Text layers on Caption-role tracks, project-wide — what `restyle_captions`
 *  touches and what a caption import adds to. */
export function captionCueCount(p: Project): number {
  let n = 0
  for (const { track, layer } of eachLayer(p)) if (track.role === 'Caption' && layer.params.kind === 'Text') n++
  return n
}

// ── The adjusted[] slot ─────────────────────────────────────────────────────

/** `reason` is `'grid'` and only `'grid'`: since the strict placing rule, the
 *  one thing a tool may change about a time it was sent is to land it on the
 *  layer's lattice (at most half a quantum). Anything else — a start before 0,
 *  a trim past the other edge — is refused before the write, so it never
 *  appears here. */
export interface Adjustment { field: string; requested: number; applied: number; reason: 'grid' }
/** Every (field, requested, applied) whose two numbers differ. A requested
 *  value that is not a finite number was not a request for that field. */
export function adjusted(pairs: ReadonlyArray<readonly [string, unknown, number | null | undefined]>): Adjustment[] {
  const out: Adjustment[] = []
  for (const [field, requested, applied] of pairs) {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) continue
    if (typeof applied !== 'number') continue
    if (requested !== applied) out.push({ field, requested, applied, reason: 'grid' })
  }
  return out
}

/** The one result shape a mutator returns: the record as `structuredContent`
 *  and, for the clients that show only text, the same record serialized with
 *  sorted keys — `toolJson`'s serialization, so the two never differ. */
export function toolRecord(v: object): ToolResultJson {
  return { content: [{ type: 'text', text: JSON.stringify(sortKeys(v)) }], structuredContent: v as Record<string, unknown> }
}

// ── Per-tool readers for the table-exec tools ───────────────────────────────

export interface ResultCtx {
  /** The wire args, as the agent sent them (snake_case MCP names). */
  args: Record<string, unknown>
  /** What the dispatch arm returned (an id, `{left,right}`, null …). */
  value: unknown
  before: Project
  after: Project
  history: HistoryStatus
}
export type ResultReader = (ctx: ResultCtx) => Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

const layerOf = ({ args, after }: ResultCtx, key = 'layer_id'): Record<string, unknown> => ({ ...(layerRecord(after, str(args[key])) ?? { layer_id: str(args[key]) }) })
const trackOf = ({ after }: ResultCtx, id: string): Record<string, unknown> => ({ ...(trackRecord(after, id) ?? { track_id: id }) })
const historyOf = ({ history }: ResultCtx): Record<string, unknown> => ({ cursor: history.cursor, len: history.len, can_undo: history.can_undo, can_redo: history.can_redo })

/** Every table-exec mutator, keyed by MCP tool name. A tool absent here answers
 *  `content: []`, which the tool-table gate refuses for a mutator — a new tool
 *  cannot land without saying what it committed. */
export const MCP_RESULT_READERS: Record<string, ResultReader> = {
  // ── layers ──
  set_position: (c) => layerOf(c),
  translate_path: (c) => layerOf(c),
  update_layer_params: (c) => layerOf(c),
  restack_layer: (c) => layerOf(c),
  set_scale_linked: (c) => {
    const hit = located(c.after, str(c.args.layer_id))
    const params = hit?.layer.params as { transform?: { scale_linked: boolean } } | undefined
    return { ...layerOf(c), scale_linked: params?.transform?.scale_linked ?? null }
  },
  update_layer: (c) => {
    const rec = layerOf(c)
    const patch = obj(c.args.patch)
    return { ...rec, adjusted: adjusted([['t_start_us', patch.t_start_us, rec.t_start_us as number], ['t_end_us', patch.t_end_us, rec.t_end_us as number]]) }
  },
  move_layer: (c) => {
    const rec = layerOf(c)
    return {
      ...rec,
      siblings: movedLayers(c.before, c.after, new Set([str(c.args.layer_id)])),
      adjusted: adjusted([['t_start_us', c.args.new_t_start_us, rec.t_start_us as number]]),
    }
  },
  trim_layer: (c) => {
    const rec = layerOf(c)
    const field = c.args.edge === 'out' ? 't_end_us' : 't_start_us'
    return {
      ...rec,
      siblings: movedLayers(c.before, c.after, new Set([str(c.args.layer_id)])),
      adjusted: adjusted([[field, c.args.new_t_us, rec[field] as number]]),
    }
  },
  set_layers_enabled: (c) => ({ layers: layerRecords(c.after, strs(c.args.layer_ids)) }),
  paste_layers: (c) => {
    const clones = (obj(c.value).clones ?? []) as Array<{ source: string; clone: string }>
    const records = layerRecords(c.after, clones.map((x) => x.clone))
    return { clones, layers: records, adjusted: adjusted([['t_start_us', c.args.t_start_us, records[0]?.t_start_us]]) }
  },
  delete_layers: (c) => {
    const ids = strs(c.args.layer_ids)
    const ripple = c.args.ripple === true
    return {
      deleted: ids, ripple,
      pruned_tracks: prunedTrackIds(c.before, c.after),
      moved: ripple ? movedLayers(c.before, c.after, new Set(ids)) : [],
    }
  },
  ripple_delete_gap: (c) => ({
    track_id: str(c.args.track_id), start_us: c.args.start_us, end_us: c.args.end_us,
    moved: movedLayers(c.before, c.after),
  }),
  // ── tracks ──
  add_track: (c) => trackOf(c, str(c.value)),
  delete_track: (c) => {
    const id = str(c.args.track_id)
    const was = Object.values(c.before.compositions).flatMap((comp) => comp.tracks).find((t) => t.id === id)
    return { track_id: id, deleted_layers: was ? was.layers.map((l) => l.id) : [] }
  },
  rename_track: (c) => trackOf(c, str(c.args.track_id)),
  move_track: (c) => trackOf(c, str(c.args.track_id)),
  set_track_flags: (c) => trackOf(c, str(c.args.track_id)),
  // ── links ──
  create_link: (c) => ({ ...(linkRecord(c.after, str(c.value)) ?? { link_id: str(c.value) }) }),
  delete_link: (c) => {
    const id = str(c.args.link_id)
    return { link_id: id, members_released: linkRecord(c.before, id)?.members ?? [] }
  },
  // ── groups ──
  create_group: (c) => {
    const v = obj(c.value)
    return { ...v, layer: layerRecord(c.after, str(v.layer_id)) }
  },
  add_group_members: (c) => ({
    group_layer_id: str(c.args.group_layer_id),
    layers: layerRecords(c.after, strs(c.args.layer_ids)),
    pruned_tracks: prunedTrackIds(c.before, c.after),
  }),
  move_layers_to_composition: (c) => {
    const records = layerRecords(c.after, strs(c.args.layer_ids))
    const anchor = records.find((r) => r.layer_id === str(c.args.anchor_layer_id))
    return {
      to_composition_id: str(c.args.to_composition_id), layers: records,
      pruned_tracks: prunedTrackIds(c.before, c.after),
      adjusted: adjusted([['anchor_t_start_us', c.args.anchor_t_start_us, anchor?.t_start_us]]),
    }
  },
  add_group_layer: (c) => {
    const rec = layerRecord(c.after, str(c.value)) ?? { layer_id: str(c.value) }
    return { ...rec, adjusted: adjusted([['t_start_us', c.args.t_start_us, (rec as LayerRecord).t_start_us]]) }
  },
  ungroup_layer: (c) => ({
    layer_id: str(c.args.layer_id),
    layers: layerRecords(c.after, newLayerIds(c.before, c.after)),
    composition_removed: Object.keys(c.before.compositions).filter((id) => !(id in c.after.compositions)),
  }),
  rename_composition: (c) => ({ composition_id: str(c.args.composition_id), label: c.after.compositions[str(c.args.composition_id)]?.label ?? null }),
  delete_composition: (c) => ({ composition_id: str(c.args.composition_id) }),
  // ── effects ──
  add_effect: (c) => ({ ...(effectRecord(c.after, str(c.args.layer_id), str(c.value)) ?? { effect_id: str(c.value), layer_id: str(c.args.layer_id) }) }),
  update_effect: (c) => ({ ...(effectRecord(c.after, str(c.args.layer_id), str(c.args.effect_id)) ?? { effect_id: str(c.args.effect_id), layer_id: str(c.args.layer_id) }) }),
  move_effect: (c) => ({ ...(effectRecord(c.after, str(c.args.layer_id), str(c.args.effect_id)) ?? { effect_id: str(c.args.effect_id), layer_id: str(c.args.layer_id) }) }),
  delete_effect: (c) => ({
    effect_id: str(c.args.effect_id), layer_id: str(c.args.layer_id),
    effects: located(c.after, str(c.args.layer_id))?.layer.effects.length ?? 0,
  }),
  // ── transitions ──
  add_transition: (c) => {
    const rec = transitionRecord(c.after, str(c.value)) ?? { transition_id: str(c.value) }
    return { ...rec, moved: movedLayers(c.before, c.after), adjusted: adjusted([['duration_us', c.args.duration_us, (rec as TransitionRecord).duration_us]]) }
  },
  update_transition: (c) => ({
    ...(transitionRecord(c.after, str(c.args.transition_id)) ?? { transition_id: str(c.args.transition_id) }),
    moved: movedLayers(c.before, c.after),
  }),
  delete_transition: (c) => {
    const was = transitionRecord(c.before, str(c.args.transition_id))
    return {
      transition_id: str(c.args.transition_id),
      ...(was ? { from_layer_id: was.from_layer_id, to_layer_id: was.to_layer_id } : {}),
      moved: movedLayers(c.before, c.after),
    }
  },
  // ── composition / settings ──
  separate_audio_to_new_track: (c) => ({ ...trackOf(c, str(c.value)), layer: layerRecord(c.after, str(c.args.layer_id)) }),
  update_composition: (c) => {
    const id = str(c.args.composition_id) || c.after.root_id
    const comp = c.after.compositions[id]
    return comp ? compositionSettings(comp) : { composition_id: id }
  },
  set_project_settings: (c) => ({ settings: c.after.settings as unknown as Record<string, unknown> }),
  // ── markers ──
  update_marker: (c) => {
    const rec = markerRecord(c.after, str(c.args.marker_id)) ?? { marker_id: str(c.args.marker_id) }
    const patch = obj(c.args.patch)
    return { ...rec, adjusted: adjusted([['t_us', patch.t_us, (rec as MarkerRecord).t_us], ['end_t_us', patch.end_t_us, (rec as MarkerRecord).end_t_us]]) }
  },
  delete_marker: (c) => ({ marker_id: str(c.args.marker_id) }),
  set_marker_anchor: (c) => ({ ...(markerRecord(c.after, str(c.args.marker_id)) ?? { marker_id: str(c.args.marker_id) }) }),
  // ── media ──
  delete_media: (c) => ({ media_id: str(c.args.media_id), deleted_layers: removedLayerIds(c.before, c.after), pruned_tracks: prunedTrackIds(c.before, c.after) }),
  // ── history ──
  undo: (c) => historyOf(c),
  redo: (c) => historyOf(c),
  jump_to: (c) => ({ index: c.args.index, ...historyOf(c) }),
  delete_checkpoint: (c) => ({ checkpoint_id: str(c.args.checkpoint_id) }),
  // ── captions / roles ──
  restyle_captions: (c) => ({ captions: captionCueCount(c.after) }),
  set_role_gain: (c) => ({ role: str(c.args.role), ...(c.after.audio_roles[str(c.args.role)] ?? {}) }),
  set_role_flags: (c) => ({ role: str(c.args.role), ...(c.after.audio_roles[str(c.args.role)] ?? {}) }),
}

// ── Helpers for the dedicated arms in actor.mcpCall ─────────────────────────

/** `split_layer`'s answer: the two halves the caller named, PLUS every link
 *  sibling the split fanned out to — a sibling's left half keeps its id and its
 *  right half is a new layer starting where the left one now ends. The audit's
 *  rough-cut tester re-linked by hand because only the target's halves were
 *  named. */
export function splitResult(before: Project, after: Project, halves: { left: Uuid; right: Uuid }, atTUs: unknown): Record<string, unknown> {
  const right = layerRecord(after, halves.right)
  const siblings = newLayerIds(before, after).filter((id) => id !== halves.right).map((rid) => {
    const r = layerRecord(after, rid)
    let left: Uuid | null = null
    if (r) for (const { track, layer } of eachLayer(after)) {
      if (track.id === r.track_id && layer.id !== rid && layer.t_end_us === r.t_start_us) { left = layer.id; break }
    }
    return { source: left, left, right: rid }
  })
  return {
    left: halves.left, right: halves.right,
    layers: layerRecords(after, [halves.left, halves.right]),
    siblings,
    adjusted: adjusted([['at_t_us', atTUs, right?.t_start_us]]),
  }
}

interface AnimatedLike { mode: string; value: unknown; extrapolate?: unknown }
interface KeyLike { id: string; t_us: number; value: unknown }
const keysOf = (t: AnimatedLike): KeyLike[] => (t.mode === 'Keyframed' && Array.isArray(t.value) ? (t.value as KeyLike[]) : [])

/** A param track's summary after a keyframe edit — mode, how many keys, the
 *  ids (so the next `update_keyframe` needs no `get_param_track`), or the held
 *  value once Static. */
export function paramTrackResult(layerId: Uuid, paramKey: string, read: { tStartUs: number; track: AnimatedLike }): Record<string, unknown> {
  const keys = keysOf(read.track)
  return {
    layer_id: layerId, param_key: paramKey, mode: read.track.mode,
    ...(read.track.mode === 'Keyframed'
      ? { keyframes: keys.length, keyframe_ids: keys.map((k) => k.id), extrapolate: read.track.extrapolate ?? null }
      : { value: read.track.value }),
  }
}

/** One key's record, timeline-absolute and layer-local. */
export function keyframeRecord(layerId: Uuid, paramKey: string, tStartUs: number, key: KeyLike, keyframes: number): Record<string, unknown> {
  return { layer_id: layerId, param_key: paramKey, keyframe_id: key.id, t_us: key.t_us + tStartUs, t_local_us: key.t_us, value: key.value, keyframes }
}

/** `set_keyframe`'s answer: the key it inserted (the one id that is new) or
 *  updated in place (the key nearest the requested time), with `adjusted`
 *  when the grid moved it. */
export function setKeyframeResult(layerId: Uuid, paramKey: string, beforeTrack: AnimatedLike, read: { tStartUs: number; track: AnimatedLike }, requestedTUs: unknown): Record<string, unknown> {
  const was = new Set(keysOf(beforeTrack).map((k) => k.id))
  const keys = keysOf(read.track)
  const requested = typeof requestedTUs === 'number' ? requestedTUs : Number.NaN
  const key = keys.find((k) => !was.has(k.id))
    ?? [...keys].sort((x, y) => Math.abs(x.t_us + read.tStartUs - requested) - Math.abs(y.t_us + read.tStartUs - requested))[0]
  if (!key) return paramTrackResult(layerId, paramKey, read)
  return { ...keyframeRecord(layerId, paramKey, read.tStartUs, key, keys.length), adjusted: adjusted([['t_us', requestedTUs, key.t_us + read.tStartUs]]) }
}

/** `update_keyframe`'s answer: the key by id, as it now reads. */
export function keyframeByIdResult(layerId: Uuid, paramKey: string, keyframeId: string, read: { tStartUs: number; track: AnimatedLike }): Record<string, unknown> {
  const keys = keysOf(read.track)
  const key = keys.find((k) => k.id === keyframeId)
  return key ? keyframeRecord(layerId, paramKey, read.tStartUs, key, keys.length) : paramTrackResult(layerId, paramKey, read)
}
