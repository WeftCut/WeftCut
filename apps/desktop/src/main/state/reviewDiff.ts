// apps/desktop/src/main/state/reviewDiff.ts
//
// Entity-level structural diff between a Review baseline and the current
// project, and its projection onto per-composition time ranges (spec
// `.scratch/agent-review/spec.md` Part B — Diff; ADR 0115).
//
// Pure: no I/O, no actor. The baseline side is either a plain `Project` or a
// `base` project plus a per-entity `approved` overlay — the representation
// History keeps (ticket 05), so partial approval never needs a synthetic
// project (ADR 0115 rejects building one: it need not validate).
//
// Preference-shaped fields — the ones History patches into every snapshot
// (track enabled/muted/solo/locked/height, the composition envelope, settings,
// media pool, audio roles) — are never compared: a value patched everywhere
// cannot differ, and an approved value that bypassed the patch must not show
// up as a false difference either.
import { contentAt, localAtContent, sourceIn } from '../../renderer/layerTiming'
import { approximateTime, exactTime, subtractTime } from '../../renderer/timeMapping'
import type { Composition, Effect, Layer, LayerParams, Link, Marker, Project, Track, TrackRole, Transition, Uuid } from './model'
import { hasSourceWindow } from './mutations/helpers'
import { parseEntityKey, type Change, type ChangeAspect, type ChangeClass, type ChangeDetail, type EntityKey, type EntityKind, type EntityLocation, type GroupDecoration, type PlacedRange, type TimeRange } from '../../shared/review'

export { parseEntityKey }
export type { Change, ChangeAspect, ChangeClass, ChangeDetail, EntityKey, EntityKind, EntityLocation, GroupDecoration, PlacedRange, TimeRange }

// ── Entities ──────────────────────────────────────────────────────────────────

/** One entity's compared value plus where it lives. Composition and Track
 *  values are slim (only compared fields), so an approved overlay entry never
 *  pins a whole track's layers. A composition's `track_order` (its tracks'
 *  ids, top of the list first) is compared because it is the z-order: a
 *  `move_track` reorder is a reviewable `placement` change of the
 *  composition. Layer/Marker/Transition/Link hold the model object itself
 *  (shared with the snapshot, never copied). */
export type EntityValue =
  | { kind: 'Composition'; id: Uuid; label: string | null; track_order: readonly Uuid[] }
  | { kind: 'Track'; id: Uuid; composition_id: Uuid; label: string | null; role: TrackRole | null }
  | { kind: 'Layer'; id: Uuid; composition_id: Uuid; track_id: Uuid; layer: Layer }
  | { kind: 'Marker'; id: Uuid; composition_id: Uuid; marker: Marker }
  | { kind: 'Transition'; id: Uuid; composition_id: Uuid; transition: Transition }
  | { kind: 'Link'; id: Uuid; composition_id: Uuid; link: Link }

/** Overlay sentinel: "approved as not existing" (an approved removal). */
export const ABSENT: unique symbol = Symbol('Absent')
export type Absent = typeof ABSENT

export type EntityIndex = ReadonlyMap<EntityKey, EntityValue>

/** The effective baseline: `approved.get(key) ?? valueIn(base, key)`, with
 *  `ABSENT` meaning the entity is approved as gone. */
export interface BaselineOverlay {
  base: Project
  approved: ReadonlyMap<EntityKey, EntityValue | Absent>
}
export type BaselineSource = Project | BaselineOverlay

export function entityKey(kind: EntityKind, id: Uuid): EntityKey { return `${kind}:${id}` }
function keyOf(v: EntityValue): EntityKey { return entityKey(v.kind, v.id) }
/** The composition an entity lives in — its own id for a Composition. */
function compositionOf(v: EntityValue): Uuid { return v.kind === 'Composition' ? v.id : v.composition_id }

// Per-composition memo: immer shares untouched compositions between snapshots,
// so walking a history of snapshots extracts each composition object once.
const compositionMemo = new WeakMap<Composition, readonly EntityValue[]>()
function compositionEntities(c: Composition): readonly EntityValue[] {
  const hit = compositionMemo.get(c)
  if (hit) return hit
  const out: EntityValue[] = [{ kind: 'Composition', id: c.id, label: c.label, track_order: c.tracks.map((t) => t.id) }]
  for (const t of c.tracks) {
    out.push({ kind: 'Track', id: t.id, composition_id: c.id, label: t.label, role: t.role })
    for (const l of t.layers) out.push({ kind: 'Layer', id: l.id, composition_id: c.id, track_id: t.id, layer: l })
  }
  for (const m of c.markers) out.push({ kind: 'Marker', id: m.id, composition_id: c.id, marker: m })
  for (const tr of c.transitions) out.push({ kind: 'Transition', id: tr.id, composition_id: c.id, transition: tr })
  for (const g of c.links) out.push({ kind: 'Link', id: g.id, composition_id: c.id, link: g })
  compositionMemo.set(c, out)
  return out
}

const projectMemo = new WeakMap<Project, EntityIndex>()
/** Every compared entity of `p`, by key. Memoized on project identity. */
export function extractEntities(p: Project): EntityIndex {
  const hit = projectMemo.get(p)
  if (hit) return hit
  const out = new Map<EntityKey, EntityValue>()
  for (const c of Object.values(p.compositions)) for (const v of compositionEntities(c)) out.set(keyOf(v), v)
  projectMemo.set(p, out)
  return out
}

function isOverlay(src: BaselineSource): src is BaselineOverlay {
  return (src as BaselineOverlay).approved instanceof Map && 'base' in src
}

/** The effective baseline entity index: base entities with approved values
 *  laid over them. */
export function effectiveEntities(src: BaselineSource): EntityIndex {
  if (!isOverlay(src)) return extractEntities(src)
  if (src.approved.size === 0) return extractEntities(src.base)
  const out = new Map(extractEntities(src.base))
  for (const [k, v] of src.approved) {
    if (v === ABSENT) out.delete(k)
    else out.set(k, v)
  }
  return out
}

// ── Equality ──────────────────────────────────────────────────────────────────

/** Structural equality over JSON-shaped values; an `undefined` property equals
 *  a missing one (the wire omits both). Reference-equal subtrees short-circuit,
 *  which is what makes immer-shared snapshots cheap to compare. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  for (const k of Object.keys(ra)) if (ra[k] !== undefined && !jsonEqual(ra[k], rb[k])) return false
  for (const k of Object.keys(rb)) if (rb[k] !== undefined && ra[k] === undefined) return false
  return true
}

function transitionEqual(a: Transition, b: Transition): boolean {
  // Compared: participants, duration, kind (+ direction). `extended_us` is the
  // inverse ops' bookkeeping, not something the user reviews (spec table).
  return a.from_layer === b.from_layer && a.to_layer === b.to_layer && a.duration_us === b.duration_us && jsonEqual(a.kind, b.kind)
}
function linkLabel(l: Link): unknown { return (l as Link & { label?: unknown }).label ?? null }

/** Same relative order of the tracks both sides hold. Adding or removing a
 *  track is that track's own change, not a reorder of its composition. */
function trackOrderEqual(a: readonly Uuid[], b: readonly Uuid[]): boolean {
  if (a === b) return true
  const inA = new Set(a), inB = new Set(b)
  const ca = a.filter((id) => inB.has(id)), cb = b.filter((id) => inA.has(id))
  return ca.length === cb.length && ca.every((id, i) => id === cb[i])
}

/** Are two entity values equal under the compared fields (location included)? */
export function entitiesEqual(a: EntityValue | undefined, b: EntityValue | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind || a.id !== b.id) return false
  switch (a.kind) {
    case 'Composition': { const c = b as typeof a; return a.label === c.label && trackOrderEqual(a.track_order, c.track_order) }
    case 'Track': { const t = b as typeof a; return a.composition_id === t.composition_id && a.label === t.label && a.role === t.role }
    case 'Layer': { const l = b as typeof a; return a.composition_id === l.composition_id && a.track_id === l.track_id && jsonEqual(a.layer, l.layer) }
    case 'Marker': { const m = b as typeof a; return a.composition_id === m.composition_id && jsonEqual(a.marker, m.marker) }
    case 'Transition': { const t = b as typeof a; return a.composition_id === t.composition_id && transitionEqual(a.transition, t.transition) }
    case 'Link': { const g = b as typeof a; return a.composition_id === g.composition_id && jsonEqual(a.link.members, g.link.members) && jsonEqual(linkLabel(a.link), linkLabel(g.link)) }
  }
}

// ── Changes ───────────────────────────────────────────────────────────────────

const ASPECT_ORDER: readonly ChangeAspect[] = ['placement', 'timing', 'retime', 'params', 'keyframes', 'effects', 'label', 'flags']
function orderedAspects(s: ReadonlySet<ChangeAspect>): ChangeAspect[] { return ASPECT_ORDER.filter((a) => s.has(a)) }

// Params keys that are timing rather than appearance: the source window and its
// exact remainders (ADR 0092 constant-time remapping) and the rate.
const TIMING_PARAM_KEYS = new Set(['src_in_us', 'src_out_us', 'source_phase', 'content_window'])
const RETIME_PARAM_KEYS = new Set(['time_map', 'preserve_pitch', 'frame_interpolation'])

function isAnimated(v: unknown): v is { mode: 'Static' | 'Keyframed'; value: unknown } {
  if (typeof v !== 'object' || v === null) return false
  const m = (v as { mode?: unknown }).mode
  return (m === 'Static' || m === 'Keyframed') && 'value' in v
}
/** The params whose value (`params`) or keyframes (`keyframes`) differ, by wire
 *  key — insertion-ordered, deduped. */
interface ParamKeys { params: Set<string>; keyframes: Set<string> }

/** A params field's wire key under `parent` (`''` at the top), named flat the
 *  way the inspector's param keys are: a transform track by its own name, the
 *  position by `x`/`y`/`path_progress` (its mode or path as `position`), a font
 *  or outline field as `font_size_px`/`outline_width`; anything deeper is its
 *  top-level field (`crop`, `shadow`, `props`). */
function paramKeyOf(parent: string, k: string): string {
  if (parent === '') return k
  if (parent === 'transform') return k
  if (parent === 'position') return k === 'x' || k === 'y' ? k : k === 'progress' ? 'path_progress' : 'position'
  if (parent === 'font' || parent === 'outline') return `${parent}_${k}`
  return parent
}

/** Classify a params subtree difference under wire key `key`: an animated
 *  track that is keyframed on either side is `keyframes`; any other difference
 *  is `params`. */
function paramChanges(a: unknown, b: unknown, key: string, out: ParamKeys): void {
  if (jsonEqual(a, b)) return
  if (isAnimated(a) || isAnimated(b)) {
    const bothStatic = isAnimated(a) && isAnimated(b) && a.mode === 'Static' && b.mode === 'Static'
    ;(bothStatic ? out.params : out.keyframes).add(key)
    return
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ra = a as Record<string, unknown>
    const rb = b as Record<string, unknown>
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) paramChanges(ra[k], rb[k], paramKeyOf(key, k), out)
    return
  }
  out.params.add(key)
}

type LayerEntity = Extract<EntityValue, { kind: 'Layer' }>
type MarkerEntity = Extract<EntityValue, { kind: 'Marker' }>

/** Aspects of a layer difference, plus the translation if the difference is
 *  exactly a pure translation on the same track, and the params keys that
 *  differ. */
function compareLayers(a: LayerEntity, b: LayerEntity): { aspects: Set<ChangeAspect>; shift: number | null; keys: ParamKeys } {
  const out = new Set<ChangeAspect>()
  const keys: ParamKeys = { params: new Set(), keyframes: new Set() }
  const la = a.layer, lb = b.layer
  if (a.composition_id !== b.composition_id || a.track_id !== b.track_id) out.add('placement')
  if (la.t_start_us !== lb.t_start_us || la.t_end_us !== lb.t_end_us) out.add('timing')
  if (la.label !== lb.label) out.add('label')
  if (la.enabled !== lb.enabled || la.locked !== lb.locked) out.add('flags')
  if (!jsonEqual(la.effects, lb.effects)) out.add('effects')
  if (!jsonEqual(la.metadata, lb.metadata)) out.add('params')
  let windowChanged = false
  if (la.params !== lb.params) {
    const pa = la.params as unknown as Record<string, unknown>
    const pb = lb.params as unknown as Record<string, unknown>
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (TIMING_PARAM_KEYS.has(k)) {
        if (!jsonEqual(pa[k], pb[k])) { out.add('timing'); windowChanged = true }
      } else if (RETIME_PARAM_KEYS.has(k)) {
        if (!jsonEqual(pa[k], pb[k])) out.add('retime')
      } else paramChanges(pa[k], pb[k], k, keys)
    }
  }
  if (keys.params.size > 0) out.add('params')
  if (keys.keyframes.size > 0) out.add('keyframes')
  const delta = lb.t_start_us - la.t_start_us
  const shift = out.size === 1 && out.has('timing') && !windowChanged && delta !== 0 && lb.t_end_us - la.t_end_us === delta ? delta : null
  return { aspects: out, shift, keys }
}

/** Whether layer `b` is `a` as it was, or `a` translated in time and nothing
 *  else — the `shifted` rule of `diffProjects`, for one layer wherever it now
 *  sits. An outdated tack (`main/agent/tacks.ts`) is one whose covered layer
 *  fails this. */
export function layerUnchangedOrShifted(a: Layer, b: Layer): boolean {
  if (a === b) return true
  const wrap = (layer: Layer): LayerEntity => ({ kind: 'Layer', id: layer.id, composition_id: '', track_id: '', layer })
  const { aspects, shift } = compareLayers(wrap(a), wrap(b))
  return aspects.size === 0 || shift !== null
}

function compareMarkers(a: MarkerEntity, b: MarkerEntity): { aspects: Set<ChangeAspect>; shift: number | null } {
  const out = new Set<ChangeAspect>()
  const ma = a.marker, mb = b.marker
  if (a.composition_id !== b.composition_id) out.add('placement')
  if (ma.t_us !== mb.t_us || ma.end_t_us !== mb.end_t_us) out.add('timing')
  if (ma.label !== mb.label || ma.note !== mb.note) out.add('label')
  if (!jsonEqual(ma.color, mb.color)) out.add('params')
  if (!jsonEqual(ma.anchor, mb.anchor)) out.add('placement')
  const delta = mb.t_us - ma.t_us
  const endsShift = ma.end_t_us === null ? mb.end_t_us === null : mb.end_t_us !== null && mb.end_t_us - ma.end_t_us === delta
  // Anchored or free, a translation is read against the content around it
  // (`resolveMotion`): its anchor's, or the material under it.
  const shift = out.size === 1 && out.has('timing') && delta !== 0 && endsShift ? delta : null
  return { aspects: out, shift }
}

function compareOther(a: EntityValue, b: EntityValue): Set<ChangeAspect> {
  const out = new Set<ChangeAspect>()
  switch (a.kind) {
    case 'Composition': {
      const c = b as typeof a
      if (!trackOrderEqual(a.track_order, c.track_order)) out.add('placement')
      if (a.label !== c.label) out.add('label')
      break
    }
    case 'Track': {
      const t = b as typeof a
      if (a.composition_id !== t.composition_id) out.add('placement')
      if (a.label !== t.label) out.add('label')
      if (a.role !== t.role) out.add('params')
      break
    }
    case 'Transition': {
      const ta = a.transition, tb = (b as typeof a).transition
      if (a.composition_id !== (b as typeof a).composition_id) out.add('placement')
      if (ta.from_layer !== tb.from_layer || ta.to_layer !== tb.to_layer) out.add('placement')
      if (ta.duration_us !== tb.duration_us) out.add('timing')
      if (!jsonEqual(ta.kind, tb.kind)) out.add('params')
      break
    }
    case 'Link': {
      const g = b as typeof a
      if (a.composition_id !== g.composition_id) out.add('placement')
      if (!jsonEqual(a.link.members, g.link.members)) out.add('placement')
      if (!jsonEqual(linkLabel(a.link), linkLabel(g.link))) out.add('label')
      break
    }
    default: break
  }
  return out
}

function locationOf(v: EntityValue): EntityLocation | null {
  if (v.kind === 'Composition') return null
  return { composition_id: v.composition_id, track_id: v.kind === 'Layer' ? v.track_id : null }
}

// ── Details ───────────────────────────────────────────────────────────────────
//
// What a change did, as facts the renderer words (`ChangeDetail`). Each aspect
// says what it can in aspect order; one with nothing more to say is named by
// itself, so every aspect a change lists is in its details.

/** Details per aspect, in order; `say` pushes an aspect's facts, or answers
 *  true when another detail already says it (a composition move's timing). */
function detailsOf(aspects: readonly ChangeAspect[], say: (aspect: ChangeAspect, out: ChangeDetail[]) => boolean | void): ChangeDetail[] {
  const out: ChangeDetail[] = []
  for (const aspect of aspects) {
    const n = out.length
    if (say(aspect, out) !== true && out.length === n) out.push({ type: 'aspect', aspect })
  }
  return out
}

/** An added or removed entity's length: a layer's, a ranged marker's, a
 *  transition's. */
function lengthDetails(v: EntityValue): ChangeDetail[] {
  const d = v.kind === 'Layer' ? v.layer.t_end_us - v.layer.t_start_us
    : v.kind === 'Marker' ? (v.marker.end_t_us === null ? null : v.marker.end_t_us - v.marker.t_us)
      : v.kind === 'Transition' ? v.transition.duration_us : null
  return d === null ? [] : [{ type: 'length', duration_us: d }]
}

/**
 * How an entity's timing changed, read the way the timeline shows it. `ds` and
 * `de` are how far its start and end edges moved; `content`, for a layer with
 * a source window, how far the material at its old start (`dc`) and old end
 * (`dce`) moved on the timeline — the same unless the rate changed — and its
 * source window in source time (`slip`).
 *
 * - Both edges moved alike with the material: a `shift`, and a `slip` when the
 *   material moved within them.
 * - Otherwise each edge is trimmed by how far it moved against the material
 *   at that end — cut (< 0) or added (> 0) there — and the whole moved
 *   (`shift dc`) only when the material moved and the start edge went with it:
 *   a start that stayed put means the clip did not move (a ripple head trim
 *   slides the material under it). A retime that kept its material trims
 *   nothing: its speed says why it is shorter. Without material to read, the
 *   edges alone are trimmed.
 *
 * `rebased`: the two sides are on different timelines (a move to another
 * composition), so only edges against material are facts — no shift, and a
 * layer without material is measured from its start.
 */
function timingDetails(ds: number, de: number, content: { dc: number; dce: number; slip: number } | null, rebased: boolean): ChangeDetail[] {
  const out: ChangeDetail[] = []
  const shift = (d: number) => { if (d !== 0 && !rebased) out.push({ type: 'shift', delta_us: d }) }
  const trim = (side: 'start' | 'end', d: number) => { if (d !== 0) out.push({ type: 'trim', side, delta_us: d }) }
  if (ds === de && (!content || content.dce === content.dc)) {
    shift(ds)
    if (content && content.dc !== ds && content.slip !== 0) out.push({ type: 'slip', delta_us: content.slip })
    return out
  }
  const along = content ? content.dc : rebased ? ds : 0
  const alongEnd = content ? content.dce : along
  if (content && ds !== 0) shift(content.dc)
  trim('start', along - ds)
  trim('end', de - alongEnd)
  return out
}

/** A layer's `timingDetails`: content math while both sides window a source —
 *  at each end apart when the rate changed. A retimed layer with no window to
 *  read says only where its start went: its speed says its length. */
function layerTimingDetails(a: Layer, b: Layer, rebased: boolean): ChangeDetail[] {
  const ds = b.t_start_us - a.t_start_us, de = b.t_end_us - a.t_end_us
  const windowed = hasSourceWindow(a.params) && hasSourceWindow(b.params)
  const retimed = rateOf(a.params) !== rateOf(b.params)
  if (retimed && !windowed) return timingDetails(ds, ds, null, rebased)
  const dc = windowed ? Math.round(throughContent(a, b, a.t_start_us) - a.t_start_us) : 0
  const content = windowed ? {
    dc,
    dce: retimed ? Math.round(throughContent(a, b, a.t_end_us) - a.t_end_us) : dc,
    slip: Math.round(approximateTime(subtractTime(sourceIn(b.params), sourceIn(a.params)))),
  } : null
  return timingDetails(ds, de, content, rebased)
}

/** A layer's constant playback rate; null for a time map that is not one. */
function rateOf(p: LayerParams): number | null {
  const map = 'time_map' in p ? p.time_map : undefined
  if (!map) return 1
  return map.kind === 'Affine' ? approximateTime(map.rate) : null
}

/** One detail per effect instance (by id) added, removed or changed. A
 *  reorder alone says nothing here. */
function effectDetails(a: readonly Effect[], b: readonly Effect[]): ChangeDetail[] {
  const was = new Map(a.map((e) => [e.id, e]))
  const now = new Set(b.map((e) => e.id))
  const out: ChangeDetail[] = []
  for (const e of b) {
    const p = was.get(e.id)
    if (!p) out.push({ type: 'effect', op: 'added', effect: e.kind })
    else if (!jsonEqual(p, e)) out.push({ type: 'effect', op: 'changed', effect: e.kind })
  }
  for (const e of a) if (!now.has(e.id)) out.push({ type: 'effect', op: 'removed', effect: e.kind })
  return out
}

function layerDetails(a: LayerEntity, b: LayerEntity, aspects: readonly ChangeAspect[], keys: ParamKeys): ChangeDetail[] {
  const la = a.layer, lb = b.layer
  const rebased = a.composition_id !== b.composition_id
  return detailsOf(aspects, (aspect, out) => {
    switch (aspect) {
      case 'placement':
        if (rebased) out.push({ type: 'composition', from: a.composition_id, to: b.composition_id })
        else if (a.track_id !== b.track_id) out.push({ type: 'track', from: a.track_id, to: b.track_id })
        return
      // A retime's new length is said by its speed.
      case 'timing': out.push(...layerTimingDetails(la, lb, rebased)); return rebased || rateOf(la.params) !== rateOf(lb.params)
      case 'retime': { const from = rateOf(la.params), to = rateOf(lb.params); if (from !== to) out.push({ type: 'speed', from, to }); return }
      case 'params': if (keys.params.size > 0) out.push({ type: 'params', keys: [...keys.params] }); return
      case 'keyframes': if (keys.keyframes.size > 0) out.push({ type: 'keyframes', keys: [...keys.keyframes] }); return
      case 'effects': out.push(...effectDetails(la.effects, lb.effects)); return
      case 'label': out.push({ type: 'label' }); return
      case 'flags':
        if (la.enabled !== lb.enabled) out.push({ type: 'enabled', value: lb.enabled })
        if (la.locked !== lb.locked) out.push({ type: 'locked', value: lb.locked })
        return
    }
  })
}

function markerDetails(a: MarkerEntity, b: MarkerEntity, aspects: readonly ChangeAspect[]): ChangeDetail[] {
  const ma = a.marker, mb = b.marker
  const rebased = a.composition_id !== b.composition_id
  return detailsOf(aspects, (aspect, out) => {
    switch (aspect) {
      case 'placement': if (rebased) out.push({ type: 'composition', from: a.composition_id, to: b.composition_id }); return
      case 'timing': out.push(...timingDetails(mb.t_us - ma.t_us, (mb.end_t_us ?? mb.t_us) - (ma.end_t_us ?? ma.t_us), null, rebased)); return rebased
      case 'label': out.push({ type: 'label' }); return
      case 'params': if (!jsonEqual(ma.color, mb.color)) out.push({ type: 'params', keys: ['color'] }); return
    }
  })
}

/** Transitions, tracks, compositions, links: a label by itself, anything else
 *  by its aspect. */
function otherDetails(aspects: readonly ChangeAspect[]): ChangeDetail[] {
  return detailsOf(aspects, (aspect, out) => { if (aspect === 'label') out.push({ type: 'label' }) })
}

// ── Footprints and ranges ─────────────────────────────────────────────────────

/** Where an entity sits on its composition's timeline; null when it has no
 *  time footprint (track, link, composition). `index` is the SAME side's
 *  entities — a transition's footprint is read off its own side's layers. */
function footprint(v: EntityValue, index: EntityIndex): TimeRange | null {
  switch (v.kind) {
    case 'Layer': return { composition_id: v.composition_id, t_start_us: v.layer.t_start_us, t_end_us: v.layer.t_end_us }
    case 'Marker': return { composition_id: v.composition_id, t_start_us: v.marker.t_us, t_end_us: v.marker.end_t_us ?? v.marker.t_us }
    case 'Transition': {
      // The overlap is [incoming.t_start, outgoing.t_end] and its length is
      // duration_us (validate's overlap === duration).
      const d = v.transition.duration_us
      const to = index.get(entityKey('Layer', v.transition.to_layer))
      if (to?.kind === 'Layer') return { composition_id: v.composition_id, t_start_us: to.layer.t_start_us, t_end_us: to.layer.t_start_us + d }
      const from = index.get(entityKey('Layer', v.transition.from_layer))
      if (from?.kind === 'Layer') return { composition_id: v.composition_id, t_start_us: from.layer.t_end_us - d, t_end_us: from.layer.t_end_us }
      return null
    }
    default: return null
  }
}

/** Merge overlapping or adjacent ranges per composition; output sorted by
 *  composition, then start. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) =>
    a.composition_id < b.composition_id ? -1 : a.composition_id > b.composition_id ? 1 : a.t_start_us - b.t_start_us || a.t_end_us - b.t_end_us)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.composition_id === r.composition_id && r.t_start_us <= last.t_end_us) last.t_end_us = Math.max(last.t_end_us, r.t_end_us)
    else out.push({ ...r })
  }
  return out
}

// ── Removed entities on the current timeline ──────────────────────────────────
//
// Every range a change carries is drawn on the CURRENT timeline, so it is the
// current footprint — the baseline one is in the baseline's time, which any
// later ripple has moved out from under it. A removed entity has no current
// footprint; its baseline one is carried over by the content around it, the
// way a tack follows content (ADR 0115): each end through the clip that was
// under it (A roll first, then track order) if that clip still shows that
// material, else through the neighbour on its own track — the end of the clip
// before it, the material of the clip after it — else where it was. A ripple
// delete collapses the range to the seam it left.

type LayerPair = { base: Layer; cur: Layer; track: Uuid }

/** Where baseline instant `t` of `base`'s material now sits, through `cur`
 *  (the same layer, current side). A layer with no source window carries its
 *  start's delta. Unsnapped: a range is read, never edited. */
function throughContent(base: Layer, cur: Layer, t: number): number {
  if (!hasSourceWindow(base.params) || !hasSourceWindow(cur.params)) return t + cur.t_start_us - base.t_start_us
  const content = contentAt(base.params, exactTime(t - base.t_start_us))
  return cur.t_start_us + approximateTime(localAtContent(cur.params, content))
}

/** The baseline layers of a composition that still exist in it, A-roll tracks
 *  first, then track order (the tack edge rule). */
function survivingLayers(before: EntityIndex, after: EntityIndex, compositionId: Uuid): LayerPair[] {
  const comp = before.get(entityKey('Composition', compositionId))
  if (comp?.kind !== 'Composition') return []
  const role = (track: Uuid) => { const t = before.get(entityKey('Track', track)); return t?.kind === 'Track' ? t.role : null }
  const order = [...comp.track_order.filter((t) => role(t) === 'ARoll'), ...comp.track_order.filter((t) => role(t) !== 'ARoll')]
  const rank = new Map(order.map((t, i) => [t, i]))
  const out: LayerPair[] = []
  for (const v of before.values()) {
    if (v.kind !== 'Layer' || v.composition_id !== compositionId) continue
    const c = after.get(keyOf(v))
    if (c?.kind === 'Layer' && c.composition_id === compositionId) out.push({ base: v.layer, cur: c.layer, track: v.track_id })
  }
  return out.sort((a, b) => (rank.get(a.track) ?? Infinity) - (rank.get(b.track) ?? Infinity))
}

/** A removed entity's baseline footprint `r`, carried onto the current
 *  timeline. `trackId` is the removed layer's track (null for a marker or a
 *  transition), whose neighbours are the fallback. */
export function removedRangeNow(r: TimeRange, trackId: Uuid | null, layers: readonly LayerPair[]): TimeRange {
  const s = r.t_start_us, e = r.t_end_us
  let start: number | null = null
  let end: number | null = null
  // Under: the clip that showed material at the instant, while it still shows
  // some of it — clamped to what is left of it when that frame was trimmed off.
  for (const p of layers) {
    if (!(p.base.t_start_us <= s && s < p.base.t_end_us)) continue
    const t = throughContent(p.base, p.cur, s)
    if (t >= p.cur.t_end_us) continue
    start = Math.max(t, p.cur.t_start_us)
    break
  }
  if (e > s) for (const p of layers) {
    if (!(p.base.t_start_us < e && e <= p.base.t_end_us)) continue
    const t = throughContent(p.base, p.cur, e)
    if (t <= p.cur.t_start_us) continue
    end = Math.min(t, p.cur.t_end_us)
    break
  }
  // Beside, on its own track: where the clip before it now ends, where the
  // material of the clip after it now starts.
  if (trackId !== null) {
    const own = layers.filter((p) => p.track === trackId)
    if (start === null) {
      const before = own.filter((p) => p.base.t_end_us <= s).sort((a, b) => b.base.t_end_us - a.base.t_end_us)[0]
      if (before) start = s + before.cur.t_end_us - before.base.t_end_us
    }
    if (end === null && e > s) {
      const after = own.filter((p) => p.base.t_start_us >= e).sort((a, b) => a.base.t_start_us - b.base.t_start_us)[0]
      if (after) end = e + throughContent(after.base, after.cur, after.base.t_start_us) - after.base.t_start_us
    }
  }
  if (e <= s) { const t = start ?? s; return { composition_id: r.composition_id, t_start_us: t, t_end_us: t } }
  // One end found: the other keeps the length — except that an end pulled in
  // before where it was (the clip after it closed up) is the seam itself.
  if (start === null && end === null) return { ...r }
  if (start === null) start = Math.min(s, end!)
  if (end === null) end = start + (e - s)
  return { composition_id: r.composition_id, t_start_us: start, t_end_us: Math.max(start, end) }
}

/**
 * Changes computed against an earlier project `then` — their ranges in its
 * time — placed on `current`'s timeline instead: each entity still there at
 * its current footprint; one gone since, and a range in a composition none of
 * the change's entities is in now (a removal's seam, the place a move left),
 * carried by the content around it (`removedRangeNow`). Everything else about
 * a change stays: it says what was done then. What one agent call did
 * (`History.opDiff`) is diffed at its own moment and drawn on today's timeline.
 */
export function carryChangesTo(changes: readonly Change[], then: Project, current: Project): Change[] {
  if (then === current) return [...changes]
  const a = extractEntities(then), b = extractEntities(current)
  const surviving = new Map<Uuid, LayerPair[]>()
  const survivors = (compositionId: Uuid) => {
    let hit = surviving.get(compositionId)
    if (!hit) surviving.set(compositionId, hit = survivingLayers(a, b, compositionId))
    return hit
  }
  // A place a move left is carried by the content around it, less what moved
  // on purpose: the call's own moves, and any layer gone to another track since.
  const moved = new Set(changes.filter((c) => c.was).flatMap((c) => c.keys))
  if (moved.size > 0) for (const v of a.values()) {
    if (v.kind !== 'Layer') continue
    const now = b.get(keyOf(v))
    if (now?.kind === 'Layer' && now.track_id !== v.track_id) moved.add(keyOf(v))
  }
  const unmoved = memoSurvivors(survivors, moved)
  return changes.map((c) => {
    if (c.ranges.length === 0) return c
    const was = c.was?.map((w): PlacedRange => ({ ...removedRangeNow(w, w.track_id, unmoved(w.composition_id)), track_id: w.track_id }))
    const out: TimeRange[] = []
    for (const k of c.keys) {
      const now = b.get(k)
      const f = now && footprint(now, b)
      if (f) { out.push(f); continue }
      const was = a.get(k)
      const fw = was && footprint(was, a)
      if (fw) out.push(removedRangeNow(fw, was!.kind === 'Layer' ? was!.track_id : null, survivors(fw.composition_id)))
    }
    const placed = new Set(out.map((r) => r.composition_id))
    const single = c.keys.length === 1 ? a.get(c.keys[0]) : undefined
    const track = c.from?.track_id ?? (single?.kind === 'Layer' ? single.track_id : null)
    for (const r of c.ranges) if (!placed.has(r.composition_id)) out.push(removedRangeNow(r, track, survivors(r.composition_id)))
    return was ? { ...c, ranges: mergeRanges(out), was } : { ...c, ranges: mergeRanges(out) }
  })
}

/** `survivors` less the layers `moved` names, memoized per composition. */
function memoSurvivors(survivors: (compositionId: Uuid) => LayerPair[], moved: ReadonlySet<EntityKey>): (compositionId: Uuid) => LayerPair[] {
  const memo = new Map<Uuid, LayerPair[]>()
  return (compositionId) => {
    let hit = memo.get(compositionId)
    if (!hit) memo.set(compositionId, hit = survivors(compositionId).filter((p) => !moved.has(entityKey('Layer', p.base.id))))
    return hit
  }
}

/** A deliberate move: a layer or marker gone to another track or composition
 *  (`placement` with both locations) or moved in time on its own along with
 *  other edits (a `shift` detail), or a translation group not carried. */
function isDeliberateMove(c: Change): boolean {
  if (c.class !== 'modified') return false
  if (c.delta_us !== undefined) return !c.carried
  if (c.kind !== 'Layer' && c.kind !== 'Marker') return false
  return (c.from !== undefined && c.to !== undefined && c.aspects.includes('placement')) || c.details.some((d) => d.type === 'shift')
}

/** Sets `was` on every deliberate move in `changes` that lacks it — one to
 *  another composition, a demoted carried change: each moved entity's
 *  baseline footprint, carried onto the current timeline by the content
 *  around it (`removedRangeNow`) — without the moves themselves, or the place
 *  would follow them to where they went. Returns new objects for the changes
 *  it fills. */
function placeMoves(changes: readonly Change[], before: EntityIndex, survivors: (compositionId: Uuid) => LayerPair[]): Change[] {
  const moves = changes.filter(isDeliberateMove)
  if (!moves.some((c) => !c.was)) return [...changes]
  const unmoved = memoSurvivors(survivors, new Set(moves.flatMap((c) => c.keys)))
  return changes.map((c) => {
    if (c.was || !isDeliberateMove(c)) return c
    const was: PlacedRange[] = []
    for (const k of c.keys) {
      const v = before.get(k)
      const f = v && footprint(v, before)
      if (!f) continue
      const track = v!.kind === 'Layer' ? v!.track_id : null
      was.push({ ...removedRangeNow(f, track, unmoved(f.composition_id)), track_id: track })
    }
    return { ...c, was }
  })
}

/** `placeMoves` against a baseline: what History calls once a carried shift,
 *  its carrier on the other list, is shown as the deliberate move it is. */
export function placeDeliberateMoves(changes: readonly Change[], baseline: BaselineSource, current: Project): Change[] {
  if (!changes.some((c) => !c.was && isDeliberateMove(c))) return [...changes]
  const before = effectiveEntities(baseline), after = extractEntities(current)
  const memo = new Map<Uuid, LayerPair[]>()
  return placeMoves(changes, before, (id) => {
    let hit = memo.get(id)
    if (!hit) memo.set(id, hit = survivingLayers(before, after, id))
    return hit
  })
}

/** Group decorations computed against `then`, on `current`: a Group clip
 *  still there at its current footprint; one gone since is not drawn. */
export function carryDecorationsTo(decorations: readonly GroupDecoration[], current: Project): GroupDecoration[] {
  const b = extractEntities(current)
  const out: GroupDecoration[] = []
  for (const d of decorations) {
    const v = b.get(entityKey('Layer', d.layer_id))
    if (v?.kind === 'Layer') out.push({ ...d, composition_id: v.composition_id, t_start_us: v.layer.t_start_us, t_end_us: v.layer.t_end_us })
  }
  return out
}

// ── Movement against the content around it ────────────────────────────────────
//
// A changed layer or marker's movement is measured against where the content
// around it took it, not against the baseline. Its displacement (`measures`:
// where its baseline start's material now sits, as `timingDetails` reads it)
// is matched against reference displacements — how far the content around it
// was carried, each with the change that carried it:
//
// - before it on its own track: the baseline layer that started before it and
//   ends last (a co-starting A/V partner never counts), at its end — or where
//   it still overlaps it, at its start — and the reference that layer was
//   itself measured from; with layers removed after that one, the seam a
//   ripple of them closed (or the gap they left); with layers added between,
//   the room they made (less that seam: a replace);
// - under it, off the A roll: the A-roll clip its start sat over, as a tack's
//   end follows it; with none, the A-roll content before it;
// - an anchored marker: its layer's own reference; a free one: the material
//   under it.
//
// Within half a frame of a reference with a source, it was CARRIED by that
// source. Otherwise its own movement is its displacement less its primary
// reference — the material under it off the A roll, else the content before
// it; of those, the one nearest — and its details and `was` are read from that
// carried place. One that did not move — or, with no material to read, kept
// an edge where it was — is measured from where it was.

/** Where a reference displacement came from: the id of the change that moved
 *  that content (in the same list), `APPROVED` for motion an approval already
 *  accepted, null for content that did not move. */
const APPROVED = '\u0000approved'
interface Ref { d: number; source: string | null }

/** How one changed layer or marker moved. `ref` is what it is measured from:
 *  its carried displacement and carrier when `carried`, else its primary
 *  reference. `id` is the change it is listed in. `accepted`: a pure
 *  translation that only moved with content an approval accepted — shown as
 *  the move it is, placed like a demoted orphan (`placeMoves`). */
interface Motion { ref: Ref; carried: boolean; id: string; accepted: boolean }

/** A changed layer or marker that stays in its composition. `shift`: the
 *  delta of a pure translation, else null. */
interface Moving { key: EntityKey; b: LayerEntity | MarkerEntity; c: LayerEntity | MarkerEntity; shift: number | null; aspects: Set<ChangeAspect>; params: ParamKeys | null }

const NO_REF: Ref = { d: 0, source: null }

/** The displacements a layer's movement is read from, in order: its edges
 *  when they moved alike, else the material at its start — none when its
 *  start stayed put (a ripple head trim slides the material; the clip did not
 *  move) — and, with no material to read, either edge. As `timingDetails`. */
function layerMeasures(a: Layer, b: Layer): number[] {
  const ds = b.t_start_us - a.t_start_us, de = b.t_end_us - a.t_end_us
  const windowed = hasSourceWindow(a.params) && hasSourceWindow(b.params)
  const retimed = rateOf(a.params) !== rateOf(b.params)
  if (!windowed) return ds === de || retimed ? [ds] : [ds, de]
  const dc = Math.round(throughContent(a, b, a.t_start_us) - a.t_start_us)
  const dce = retimed ? Math.round(throughContent(a, b, a.t_end_us) - a.t_end_us) : dc
  if (ds === de && dce === dc) return [ds]
  return ds !== 0 ? [dc] : []
}

/** How far the content of baseline layer `base` (`cur` now) at baseline
 *  instant `t` moved: its material inside it, its edge at its end. */
function displacementAt(base: Layer, cur: Layer, t: number): number {
  if (t >= base.t_end_us) return cur.t_end_us - base.t_end_us
  if (hasSourceWindow(base.params) && hasSourceWindow(cur.params)) return Math.round(throughContent(base, cur, t) - t)
  return cur.t_start_us - base.t_start_us
}

/** A track's baseline layers, latest end first (then latest start) — the
 *  order the content before an instant is looked for in — and the longest. */
interface Lane { xs: LayerEntity[]; longest: number }
function sortLane(lane: Lane): Lane {
  lane.xs.sort((x, y) => y.layer.t_end_us - x.layer.t_end_us || y.layer.t_start_us - x.layer.t_start_us)
  lane.longest = lane.xs.reduce((n, x) => Math.max(n, x.layer.t_end_us - x.layer.t_start_us), 0)
  return lane
}
/** The first index of `lane` whose layer may start before `s`: every one
 *  ending later than `s` plus the longest starts after it. */
function firstBefore(lane: Lane, s: number): number {
  const bound = s + lane.longest
  let lo = 0, hi = lane.xs.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lane.xs[mid].layer.t_end_us > bound) lo = mid + 1; else hi = mid }
  return lo
}

/** `v` moved `d` in time — its carried place, from which its own edits read. */
function translated<T extends LayerEntity | MarkerEntity>(v: T, d: number): T {
  if (d === 0) return v
  if (v.kind === 'Layer') return { ...v, layer: { ...v.layer, t_start_us: v.layer.t_start_us + d, t_end_us: v.layer.t_end_us + d } }
  const m = (v as MarkerEntity).marker
  return { ...v, marker: { ...m, t_us: m.t_us + d, end_t_us: m.end_t_us === null ? null : m.end_t_us + d } }
}

/** The reference of `refs` nearest `m` (the first of equals). */
function nearest(refs: readonly Ref[], m: number): Ref {
  let best = refs[0] ?? NO_REF
  for (const r of refs) if (Math.abs(m - r.d) < Math.abs(m - best.d)) best = r
  return best
}

/** The first measure within `tol` of a reference with a source, and the
 *  nearest such reference; null when none is. */
function matchRef(measures: readonly number[], refs: readonly Ref[], tol: number): { m: number; ref: Ref } | null {
  for (const m of measures) {
    if (m === 0) continue
    let best: Ref | null = null
    for (const r of refs) if (r.source !== null && Math.abs(m - r.d) <= tol && (!best || Math.abs(m - r.d) < Math.abs(m - best.d))) best = r
    if (best) return { m, ref: best }
  }
  return null
}

/** The baselines references are read in. `geo`: the effective one, except
 *  that a layer approved at the value it still has (or approved gone and
 *  still gone) reads from the base — the content around it is measured as it
 *  was, and its motion since is accepted (`APPROVED`): approving a ripple
 *  approves the move of what it carried, a clip edited since included. A
 *  change whose own baseline is an approved value (`approved`) was placed
 *  after that motion, so it reads the effective baseline (`before`) instead. */
interface ReferenceBaseline { geo: EntityIndex; accepted: Set<EntityKey>; approved: Set<EntityKey>; before: EntityIndex }
function referenceBaseline(baseline: BaselineSource, before: EntityIndex, after: EntityIndex): ReferenceBaseline {
  const accepted = new Set<EntityKey>(), approved = new Set<EntityKey>()
  if (!isOverlay(baseline) || baseline.approved.size === 0) return { geo: before, accepted, approved, before }
  const base = extractEntities(baseline.base)
  let geo: Map<EntityKey, EntityValue> | null = null
  for (const [k, v] of baseline.approved) {
    if (v !== ABSENT && (v.kind === 'Layer' || v.kind === 'Marker')) approved.add(k)
    const was = base.get(k)
    if (was?.kind !== 'Layer') continue
    const now = after.get(k)
    if (v === ABSENT ? now !== undefined : !entitiesEqual(v, now)) continue
    ;(geo ??= new Map(before)).set(k, was)
    accepted.add(k)
  }
  return { geo: geo ?? before, accepted, approved, before }
}

/**
 * How each of `moving` — the changed layers and markers staying in one
 * composition — moved, against the content around it. Resolved in the order
 * references are read: A-roll tracks first, then track order, each in
 * baseline time order; markers last. `rb` is `referenceBaseline`'s; `tol` is
 * half a frame.
 */
function resolveMotion(compositionId: Uuid, moving: readonly Moving[], rb: ReferenceBaseline, after: EntityIndex, tol: number): Map<EntityKey, Motion> {
  const out = new Map<EntityKey, Motion>()
  const comp = rb.geo.get(entityKey('Composition', compositionId))
  const trackOrder = comp?.kind === 'Composition' ? comp.track_order : []
  const role = (t: Uuid) => { const v = rb.geo.get(entityKey('Track', t)); return v?.kind === 'Track' ? v.role : null }
  const aRoll = trackOrder.filter((t) => role(t) === 'ARoll')
  const now = (k: EntityKey): LayerEntity | null => { const v = after.get(k); return v?.kind === 'Layer' && v.composition_id === compositionId ? v : null }

  /** One baseline references are read in: its layers per track (`Lane`),
   *  the A-roll tracks' together, and the layers on each track now that were
   *  not there, what an insert made room with. */
  interface Frame { index: EntityIndex; accepted: ReadonlySet<EntityKey>; byTrack: Map<Uuid, Lane>; aRoll: Lane | null; arrived: Map<Uuid, Layer[]> }
  const frameOf = (index: EntityIndex, accepted: ReadonlySet<EntityKey>): Frame => {
    const byTrack = new Map<Uuid, Lane>()
    const arrived = new Map<Uuid, Layer[]>()
    for (const v of index.values()) if (v.kind === 'Layer' && v.composition_id === compositionId) {
      let lane = byTrack.get(v.track_id)
      if (!lane) byTrack.set(v.track_id, lane = { xs: [], longest: 0 })
      lane.xs.push(v)
    }
    for (const lane of byTrack.values()) sortLane(lane)
    for (const v of after.values()) {
      if (v.kind !== 'Layer' || v.composition_id !== compositionId) continue
      const g = index.get(keyOf(v))
      if (g?.kind === 'Layer' && g.composition_id === compositionId && g.track_id === v.track_id) continue
      let list = arrived.get(v.track_id)
      if (!list) arrived.set(v.track_id, list = [])
      list.push(v.layer)
    }
    return { index, accepted, byTrack, aRoll: null, arrived }
  }
  const geo = frameOf(rb.geo, rb.accepted)
  let effective: Frame | null = null
  /** The frame a change reads: the effective baseline when its own baseline
   *  is an approved value (accepted content has not moved since). */
  const frameFor = (k: EntityKey): Frame =>
    rb.accepted.size > 0 && rb.approved.has(k) ? (effective ??= frameOf(rb.before, new Set())) : geo

  /** What baseline layer `v` (still in the composition) says of the content
   *  at baseline instant `t`: how far it moved and what moved it — and the
   *  reference it was itself measured from, which the content after it may
   *  have stayed with when it moved on its own. */
  const refsOf = (f: Frame, v: LayerEntity, t: number): Ref[] => {
    const k = keyOf(v)
    const m = out.get(k)
    if (!m && !f.accepted.has(k)) return [NO_REF]
    const d = displacementAt(v.layer, now(k)!.layer, t)
    if (!m) return [{ d, source: d === 0 ? null : APPROVED }]
    const source = m.carried && Math.abs(d - m.ref.d) <= tol ? m.ref.source : d === 0 ? null : m.id
    const refs: Ref[] = [{ d, source }]
    if (m.ref.source !== null && (m.ref.d !== d || m.ref.source !== source)) refs.push(m.ref)
    return refs
  }

  /** The references the content before baseline instant `s` on `tracks`
   *  gives a layer (`self`) now starting at `nowStart`. */
  const contentBefore = (f: Frame, tracks: readonly Uuid[], s: number, self: EntityKey, nowStart: number): Ref[] => {
    // One track, or the A-roll ones together.
    const lane = tracks.length === 1 ? f.byTrack.get(tracks[0]) : (f.aRoll ??= sortLane({ xs: aRoll.flatMap((t) => f.byTrack.get(t)?.xs ?? []), longest: 0 }))
    // Removed (or gone elsewhere) after the last layer still there, nearest
    // first: each its length and its change.
    const run: Ref[] = []
    let p: LayerEntity | null = null
    for (let i = lane ? firstBefore(lane, s) : 0; lane && i < lane.xs.length; i++) {
      const x = lane.xs[i]
      if (x.layer.t_start_us >= s) continue
      const k = keyOf(x)
      if (k === self) continue
      if (now(k)?.track_id === x.track_id) { p = x; break }
      run.push({ d: x.layer.t_end_us - x.layer.t_start_us, source: f.accepted.has(k) ? APPROVED : k })
    }
    const base = p ? refsOf(f, p, Math.min(p.layer.t_end_us, s)) : [NO_REF]
    const refs = [...base]
    // The seam a ripple of the nearest or the farthest of them closed.
    for (let i = 1; i <= run.length; i++) {
      for (const part of i === run.length ? [run] : [run.slice(0, i), run.slice(run.length - i)]) {
        const len = part.reduce((n, r) => n + r.d, 0)
        for (const b of base) refs.push({ d: b.d - len, source: part[0].source })
      }
    }
    // The room layers that arrived between it and that content made — after
    // a seam closed, too (a replace).
    const from = p ? now(keyOf(p))!.layer.t_end_us - tol : -Infinity
    const room = tracks.flatMap((t) => f.arrived.get(t) ?? []).filter((l) => l.t_start_us >= from && l.t_end_us <= nowStart + tol)
    if (room.length > 0) {
      const len = room.reduce((n, l) => n + l.t_end_us - l.t_start_us, 0)
      const last = room.reduce((x, y) => (y.t_end_us > x.t_end_us ? y : x))
      for (const r of refs.slice()) refs.push({ d: r.d + len, source: entityKey('Layer', last.id) })
    }
    return refs
  }

  /** The references of the A-roll material at baseline instant `s`, or null
   *  when no A-roll clip still in the composition was there. */
  const under = (f: Frame, s: number): Ref[] | null => {
    for (const t of aRoll) {
      const lane = f.byTrack.get(t)
      for (let i = lane ? firstBefore(lane, s) : 0; lane && i < lane.xs.length && s < lane.xs[i].layer.t_end_us; i++) {
        const v = lane.xs[i]
        if (v.layer.t_start_us <= s && now(keyOf(v))) return refsOf(f, v, s)
      }
    }
    return null
  }

  const resolve = ({ key, b, c, shift }: Moving): void => {
    const f = frameFor(key)
    let measures: number[]
    let refs: () => { all: Ref[]; primary: Ref[] }
    if (b.kind === 'Layer') {
      const cl = (c as LayerEntity).layer, s = b.layer.t_start_us
      measures = layerMeasures(b.layer, cl)
      refs = () => {
        const own = contentBefore(f, [b.track_id], s, key, cl.t_start_us)
        if (aRoll.includes(b.track_id)) return { all: own, primary: own }
        const u = under(f, s)
        if (u) return { all: [...u, ...own], primary: u }
        return { all: aRoll.length > 0 ? [...own, ...contentBefore(f, aRoll, s, key, cl.t_start_us)] : own, primary: own }
      }
    } else {
      const mb = b.marker
      measures = [(c as MarkerEntity).marker.t_us - mb.t_us]
      refs = () => {
        const anchor = mb.anchor ? f.index.get(entityKey('Layer', mb.anchor.layer)) : undefined
        if (anchor?.kind === 'Layer' && anchor.composition_id === compositionId && now(keyOf(anchor))) {
          const m = out.get(keyOf(anchor))
          const own = m ? [m.ref] : refsOf(f, anchor, Math.min(Math.max(mb.t_us, anchor.layer.t_start_us), anchor.layer.t_end_us))
          return { all: own, primary: own }
        }
        const u = under(f, mb.t_us) ?? [NO_REF]
        return { all: u, primary: u }
      }
    }
    const m0 = measures.find((m) => m !== 0)
    if (m0 === undefined) { out.set(key, { ref: NO_REF, carried: false, id: key, accepted: false }); return }
    const { all, primary } = refs()
    const hit = matchRef(measures, all, tol)
    if (hit && !(shift !== null && hit.ref.source === APPROVED)) {
      const ref = { d: hit.m, source: hit.ref.source }
      out.set(key, { ref, carried: true, id: shift !== null ? `Shift:${compositionId}:${hit.m}:${hit.ref.source}` : key, accepted: false })
      return
    }
    // An edge without material that stayed put: trimmed there, not moved.
    const ref = hit || measures.includes(0) ? NO_REF : nearest(primary, m0)
    out.set(key, { ref, carried: false, id: shift !== null ? `Shift:${compositionId}:${shift - ref.d}` : key, accepted: hit !== null })
  }

  const byKey = new Map(moving.map((x) => [x.key, x]))
  for (const t of [...aRoll, ...trackOrder.filter((t) => !aRoll.includes(t))]) {
    const list = [...geo.byTrack.get(t)?.xs ?? []].sort((x, y) => x.layer.t_start_us - y.layer.t_start_us || x.layer.t_end_us - y.layer.t_end_us)
    for (const v of list) { const x = byKey.get(keyOf(v)); if (x && x.b.kind === 'Layer') resolve(x) }
  }
  for (const x of moving) if (x.b.kind === 'Layer' && !out.has(x.key)) resolve(x)
  const markers = moving.filter((x) => x.b.kind === 'Marker').sort((x, y) => (x.b as MarkerEntity).marker.t_us - (y.b as MarkerEntity).marker.t_us)
  for (const x of markers) resolve(x)
  return out
}

// ── diffProjects ──────────────────────────────────────────────────────────────

/**
 * Entity-level differences between the (effective) baseline and `current`.
 *
 * Classes: `added`, `removed` and `modified` (with aspects). A move to another
 * track or composition is `modified` with `placement` and both locations. A
 * layer or marker moving within its composition is measured against the
 * content around it (`resolveMotion`):
 *
 * - a pure translation CARRIED by another change is grouped per composition,
 *   carrier and delta into one `carried` change (`carried_by`);
 * - a pure translation of its own is grouped per composition and own delta,
 *   `delta_us` that delta, `was` its carried place;
 * - carried and edited besides, it is a change of its own whose details leave
 *   the carried move out, with `carried_by` and `carried_us`;
 * - moved on its own and edited, its `shift` is its own movement and `was` its
 *   carried place.
 *
 * A move to another composition is placed by `placeMoves`. A composition
 * added or removed carries its own tracks in the same change. Ordered by
 * listed composition (current root first), then by time; changes with no
 * footprint come after the timed ones of their composition.
 */
export function diffProjects(baseline: BaselineSource, current: Project): Change[] {
  const before = effectiveEntities(baseline)
  const after = extractEntities(current)
  if (before === after) return []
  // Only the keys of compositions that may differ: one immer shared between
  // the two sides, with no approval reaching into it, holds the very same
  // entity values on both and cannot.
  const base = isOverlay(baseline) ? baseline.base : baseline
  const shared = sharedCompositions(baseline, current)
  const keys = new Set<EntityKey>()
  for (const p of [base, current])
    for (const c of Object.values(p.compositions)) if (!shared.has(c.id)) for (const v of compositionEntities(c)) keys.add(keyOf(v))
  if (isOverlay(baseline)) for (const k of baseline.approved.keys()) keys.add(k)
  const changes: Change[] = []
  const compositionChanges = new Map<Uuid, Change>()
  const pendingTracks: Array<{ value: EntityValue; cls: 'added' | 'removed' }> = []
  const moving = new Map<Uuid, Moving[]>()

  const surviving = new Map<Uuid, LayerPair[]>()
  const survivors = (compositionId: Uuid) => {
    let hit = surviving.get(compositionId)
    if (!hit) surviving.set(compositionId, hit = survivingLayers(before, after, compositionId))
    return hit
  }
  const emit = (cls: ChangeClass, b: EntityValue | undefined, c: EntityValue | undefined, aspects: ChangeAspect[], details: ChangeDetail[], moved = false): Change => {
    const v = (c ?? b)!
    // The current footprint. Where the entity is no longer — removed, or moved
    // to another composition — its baseline one, carried onto that
    // composition's current timeline (`removedRangeNow`).
    const ranges: TimeRange[] = []
    const fc = c && footprint(c, after)
    const left = b && (!c || compositionOf(b) !== compositionOf(c))
    const fb = left ? footprint(b!, before) : null
    if (fc) ranges.push(fc)
    if (fb) ranges.push(removedRangeNow(fb, b!.kind === 'Layer' ? b!.track_id : null, survivors(fb.composition_id)))
    const lb = b && locationOf(b), lc = c && locationOf(c)
    const comps = [...new Set([lc?.composition_id, lb?.composition_id].filter((x): x is Uuid => x !== undefined))]
    const change: Change = {
      id: keyOf(v), class: cls, kind: v.kind, keys: [keyOf(v)], aspects, details,
      composition_id: lc?.composition_id ?? lb?.composition_id ?? null, composition_ids: comps,
      ranges: mergeRanges(ranges),
    }
    if (moved && lb && lc) { change.from = lb; change.to = lc }
    // A removed entity's baseline place: where the timeline ghosts it.
    else if (cls === 'removed' && lb) change.from = lb
    changes.push(change)
    return change
  }

  for (const key of keys) {
    const b = before.get(key), c = after.get(key)
    if (entitiesEqual(b, c)) continue
    if (!b || !c) {
      const v = (b ?? c)!
      const cls = b ? 'removed' : 'added'
      if (v.kind === 'Track') { pendingTracks.push({ value: v, cls }); continue }
      const ch = emit(cls, b, c, [], lengthDetails(v))
      if (v.kind === 'Composition') compositionChanges.set(v.id, ch)
      continue
    }
    let aspects: Set<ChangeAspect>
    let shift: number | null = null
    let params: ParamKeys | null = null
    if (b.kind === 'Layer') ({ aspects, shift, keys: params } = compareLayers(b, c as LayerEntity))
    else if (b.kind === 'Marker') ({ aspects, shift } = compareMarkers(b, c as MarkerEntity))
    else aspects = compareOther(b, c)
    if (aspects.size === 0) continue // differs only in an uncompared field
    // Staying in its composition, a layer or marker is read against the
    // content around it once every such one is known.
    if ((b.kind === 'Layer' || b.kind === 'Marker') && b.composition_id === (c as LayerEntity | MarkerEntity).composition_id) {
      let list = moving.get(b.composition_id)
      if (!list) moving.set(b.composition_id, list = [])
      list.push({ key, b, c: c as LayerEntity | MarkerEntity, shift, aspects, params })
      continue
    }
    const lb = locationOf(b), lc = locationOf(c)
    const moved = lb !== null && lc !== null && (lb.composition_id !== lc.composition_id || lb.track_id !== lc.track_id)
    if (moved) aspects.add('placement')
    const ordered = orderedAspects(aspects)
    const details = b.kind === 'Layer' ? layerDetails(b, c as LayerEntity, ordered, params!)
      : b.kind === 'Marker' ? markerDetails(b, c as MarkerEntity, ordered) : otherDetails(ordered)
    emit('modified', b, c, ordered, details, moved)
  }

  // A composition's tracks arrive and leave with it: fold them into its change.
  for (const { value, cls } of pendingTracks) {
    const owner = value.kind === 'Track' ? compositionChanges.get(value.composition_id) : undefined
    if (owner && owner.class === cls) owner.keys.push(keyOf(value))
    else emit(cls, cls === 'removed' ? value : undefined, cls === 'added' ? value : undefined, [], [])
  }

  const rb = referenceBaseline(baseline, before, after)
  type Group = { composition_id: Uuid; delta: number; carrier: string | null; keys: EntityKey[]; ranges: TimeRange[]; was: PlacedRange[]; layers: number }
  const groups = new Map<string, Group>()
  /** Where `b` would be had it only gone with the content around it, on the
   *  current timeline: its place carried by `d`. */
  const carriedPlace = (b: LayerEntity | MarkerEntity, d: number): PlacedRange =>
    ({ ...footprint(translated(b, d), before)!, track_id: b.kind === 'Layer' ? b.track_id : null })
  for (const [compositionId, list] of moving) {
    const fps = current.compositions[compositionId]?.fps
    const tol = fps ? Math.ceil((500_000 * fps.den) / fps.num) : 1
    const motion = resolveMotion(compositionId, list, rb, after, tol)
    for (const { key, b, c, shift, aspects, params } of list) {
      const m = motion.get(key)!
      const rho = m.ref.d
      if (shift !== null) {
        const carrier = m.carried ? m.ref.source : null
        const delta = m.carried ? rho : shift - rho
        let g = groups.get(m.id)
        if (!g) groups.set(m.id, g = { composition_id: compositionId, delta, carrier, keys: [], ranges: [], was: [], layers: 0 })
        g.keys.push(key)
        if (b.kind === 'Layer') g.layers += 1
        g.ranges.push(footprint(c, after)!)
        if (!m.carried && !m.accepted) g.was.push(carriedPlace(b, rho))
        continue
      }
      const moved = b.kind === 'Layer' && b.track_id !== (c as LayerEntity).track_id
      if (moved) aspects.add('placement')
      let ordered = orderedAspects(aspects)
      let details = b.kind === 'Layer' ? layerDetails(translated(b, rho), c as LayerEntity, ordered, params!) : markerDetails(translated(b, rho), c as MarkerEntity, ordered)
      // Carried, its timing is the carrier's to say: what is left is its own.
      const unsaid = (d: ChangeDetail) => d.type === 'aspect' && d.aspect === 'timing'
      if (m.carried && ordered.length > 1 && details.some(unsaid)) {
        ordered = ordered.filter((a) => a !== 'timing')
        details = details.filter((d) => !unsaid(d))
      }
      const change = emit('modified', b, c, ordered, details, moved)
      if (m.carried && m.ref.source !== APPROVED) { change.carried_by = m.ref.source!; change.carried_us = rho }
      if (moved || details.some((d) => d.type === 'shift')) change.was = [carriedPlace(b, rho)]
    }
  }
  for (const g of groups.values()) {
    g.keys.sort()
    const change: Change = {
      id: g.carrier !== null ? `Shift:${g.composition_id}:${g.delta}:${g.carrier}` : `Shift:${g.composition_id}:${g.delta}`,
      class: 'modified', kind: g.layers > 0 ? 'Layer' : 'Marker', keys: g.keys, aspects: ['timing'],
      details: [{ type: 'shift', delta_us: g.delta }],
      composition_id: g.composition_id, composition_ids: [g.composition_id], delta_us: g.delta, ranges: mergeRanges(g.ranges),
    }
    if (g.carrier !== null) { change.carried = true; change.carried_by = g.carrier }
    else if (g.was.length > 0) change.was = g.was
    changes.push(change)
  }
  const placed = placeMoves(changes, before, survivors)

  const rootId = current.root_id
  const rank = (c: Change): string => c.composition_id === null ? '\u0002' : c.composition_id === rootId ? '\u0000' : `\u0001${c.composition_id}`
  placed.sort((x, y) => {
    const rx = rank(x), ry = rank(y)
    if (rx !== ry) return rx < ry ? -1 : 1
    const tx = x.ranges.length > 0, ty = y.ranges.length > 0
    if (tx !== ty) return tx ? -1 : 1
    const d = tx ? (x.ranges[0].t_start_us - y.ranges[0].t_start_us) || (x.ranges[0].t_end_us - y.ranges[0].t_end_us) : 0
    return d || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  })
  return placed
}

/** Ids of the compositions `current` shares by reference with the baseline's
 *  base project, less every one an approved overlay entry lives in on either
 *  side — the compositions `diffProjects` can skip. */
function sharedCompositions(baseline: BaselineSource, current: Project): Set<Uuid> {
  const base = isOverlay(baseline) ? baseline.base : baseline
  const out = new Set<Uuid>()
  for (const [id, c] of Object.entries(current.compositions)) if (base.compositions[id] === c) out.add(id)
  if (out.size === 0 || !isOverlay(baseline) || baseline.approved.size === 0) return out
  const inBase = extractEntities(base)
  for (const [k, v] of baseline.approved) {
    if (v !== ABSENT) out.delete(compositionOf(v))
    const b = inBase.get(k)
    if (b) out.delete(compositionOf(b))
  }
  return out
}

// ── Group propagation ─────────────────────────────────────────────────────────

/**
 * Every Group layer in `current` whose `params.composition` holds a change —
 * recursively: a Group layer inside a decorated Group's composition decorates
 * the Group layers showing THAT composition, up to the root. Composition-level
 * changes (a Group's label, its creation) do not decorate: they are not inside
 * the composition.
 */
export function groupDecorations(changes: readonly Change[], current: Project): GroupDecoration[] {
  const shownBy = new Map<Uuid, Array<{ layer: Layer; composition_id: Uuid }>>()
  for (const c of Object.values(current.compositions))
    for (const t of c.tracks)
      for (const l of t.layers)
        if (l.params.kind === 'CompositionRef') {
          const list = shownBy.get(l.params.composition) ?? []
          list.push({ layer: l, composition_id: c.id })
          shownBy.set(l.params.composition, list)
        }
  const out = new Map<Uuid, GroupDecoration>()
  for (const change of changes) {
    if (change.kind === 'Composition') continue
    const seen = new Set<Uuid>()
    const queue = [...change.composition_ids]
    while (queue.length > 0) {
      const comp = queue.shift()!
      if (seen.has(comp)) continue // cycle guard; validate forbids cycles anyway
      seen.add(comp)
      for (const { layer, composition_id } of shownBy.get(comp) ?? []) {
        let d = out.get(layer.id)
        if (!d) out.set(layer.id, d = { layer_id: layer.id, composition_id, t_start_us: layer.t_start_us, t_end_us: layer.t_end_us, change_ids: [] })
        if (!d.change_ids.includes(change.id)) d.change_ids.push(change.id)
        queue.push(composition_id)
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.composition_id < b.composition_id ? -1 : a.composition_id > b.composition_id ? 1 : a.t_start_us - b.t_start_us))
}

// ── Touched keys between consecutive snapshots ────────────────────────────────

/**
 * The keys of every entity whose compared value differs between two
 * snapshots — what an Agent commit touched (ticket 05 calls this per commit).
 * Walks by reference first: an untouched composition, track array, track or
 * layer that immer shared between the two is skipped without a deep compare.
 * Agrees with the key set of `diffProjects(before, after)`.
 */
export function touchedEntityKeys(before: Project, after: Project): Set<EntityKey> {
  const out = new Set<EntityKey>()
  if (before === after || before.compositions === after.compositions) return out
  for (const id of new Set([...Object.keys(before.compositions), ...Object.keys(after.compositions)])) {
    const a = before.compositions[id], b = after.compositions[id]
    if (a === b) continue
    if (!a || !b) {
      for (const v of compositionEntities((a ?? b)!)) out.add(keyOf(v))
      continue
    }
    if (a.label !== b.label) out.add(entityKey('Composition', id))
    if (a.tracks !== b.tracks) {
      if (!trackOrderEqual(a.tracks.map((t) => t.id), b.tracks.map((t) => t.id))) out.add(entityKey('Composition', id))
      touchedTracks(a.tracks, b.tracks, out)
    }
    if (a.markers !== b.markers) touchedList(a.markers, b.markers, 'Marker', (x, y) => jsonEqual(x, y), out)
    if (a.transitions !== b.transitions) touchedList(a.transitions, b.transitions, 'Transition', transitionEqual, out)
    if (a.links !== b.links) touchedList(a.links, b.links, 'Link', (x, y) => jsonEqual(x.members, y.members) && jsonEqual(linkLabel(x), linkLabel(y)), out)
  }
  return out
}

function touchedList<T extends { id: Uuid }>(a: readonly T[], b: readonly T[], kind: EntityKind, eq: (x: T, y: T) => boolean, out: Set<EntityKey>): void {
  const byId = new Map(a.map((x) => [x.id, x]))
  for (const y of b) {
    const x = byId.get(y.id)
    byId.delete(y.id)
    if (x !== y && (!x || !eq(x, y))) out.add(entityKey(kind, y.id))
  }
  for (const id of byId.keys()) out.add(entityKey(kind, id))
}

function touchedTracks(a: readonly Track[], b: readonly Track[], out: Set<EntityKey>): void {
  // A layer key is touched when it left a track, joined one, or changed in
  // place; a layer that moved between two tracks of this composition is seen
  // on both and added once (Set). Cross-composition moves are seen per side.
  const layersBefore = new Map<Uuid, { track: Uuid; layer: Layer }>()
  const layersAfter = new Map<Uuid, { track: Uuid; layer: Layer }>()
  const tracksBefore = new Map(a.map((t) => [t.id, t]))
  for (const tb of b) {
    const ta = tracksBefore.get(tb.id)
    tracksBefore.delete(tb.id)
    if (ta === tb) continue
    if (!ta) out.add(entityKey('Track', tb.id))
    else if (ta.label !== tb.label || ta.role !== tb.role) out.add(entityKey('Track', tb.id))
    if (ta?.layers === tb.layers) continue
    for (const l of ta?.layers ?? []) layersBefore.set(l.id, { track: ta!.id, layer: l })
    for (const l of tb.layers) layersAfter.set(l.id, { track: tb.id, layer: l })
  }
  for (const ta of tracksBefore.values()) {
    out.add(entityKey('Track', ta.id))
    for (const l of ta.layers) layersBefore.set(l.id, { track: ta.id, layer: l })
  }
  // A layer on a reference-shared track is in neither map; ids are unique, so
  // one found on a single side truly left or arrived on this composition.
  for (const [id, x] of layersBefore) {
    const y = layersAfter.get(id)
    if (!y || x.track !== y.track || (x.layer !== y.layer && !jsonEqual(x.layer, y.layer))) out.add(entityKey('Layer', id))
  }
  for (const id of layersAfter.keys()) if (!layersBefore.has(id)) out.add(entityKey('Layer', id))
}
