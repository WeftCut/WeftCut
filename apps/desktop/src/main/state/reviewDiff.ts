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
  // Only an ANCHORED marker shifts: it rides its layer. A free marker that
  // moved was moved on purpose and reads as a timing modification.
  const shift = out.size === 1 && out.has('timing') && ma.anchor !== null && delta !== 0 && endsShift ? delta : null
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
 *  (`placement` with both locations) or moved in time along with other edits
 *  (a `shift` detail), or a translation group not carried. */
function isDeliberateMove(c: Change): boolean {
  if (c.class !== 'modified') return false
  if (c.delta_us !== undefined) return !c.carried
  if (c.kind !== 'Layer' && c.kind !== 'Marker') return false
  return (c.from !== undefined && c.to !== undefined && c.aspects.includes('placement')) || c.details.some((d) => d.type === 'shift')
}

/** Sets `was` on every deliberate move in `changes` that lacks it: each moved
 *  entity's baseline footprint, carried onto the current timeline by the
 *  content around it (`removedRangeNow`) — without the moves themselves, or
 *  the place would follow them to where they went. Returns new objects for the
 *  changes it fills. */
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

// ── Carried translations ──────────────────────────────────────────────────────

/**
 * The change a translation group is only content carried along by, if any
 * — a ripple delete closing up, an insert or a longer clip making room, a trim
 * pulling the rest in. Both must hold:
 *
 * - On every track it touches, it is the TAIL from its first clip on: every
 *   clip that started at or after it there and is still there moved the same
 *   way at least as far (a second ripple further on carries the rest further).
 *   A clip that stayed behind means the group moved relative to its
 *   neighbours: a deliberate move.
 * - Its new start is where another change of its composition now ends — the
 *   seam a removal left, the end of what was inserted or trimmed.
 *
 * Anything else — a gap closed with nothing removed, a lone clip moved — is a
 * deliberate move, marked like any modification: what cannot be told apart is
 * shown, never hidden.
 *
 * Returns the carrier — of the changes ending there, a removal first (a
 * ripple's seam), then a trim, then the first — or null.
 */
function carrierOf(compositionId: Uuid, delta: number, keys: readonly EntityKey[], before: EntityIndex, after: EntityIndex, others: readonly Change[], current: Project): Change | null {
  const fps = current.compositions[compositionId]?.fps
  const tolerance = fps ? Math.ceil((1_000_000 * fps.den) / fps.num) : 1
  const sign = Math.sign(delta)
  const firstOnTrack = new Map<Uuid, number>()
  let newStart = Infinity
  for (const k of keys) {
    const b = before.get(k)
    if (b?.kind !== 'Layer') continue
    firstOnTrack.set(b.track_id, Math.min(firstOnTrack.get(b.track_id) ?? Infinity, b.layer.t_start_us))
    newStart = Math.min(newStart, b.layer.t_start_us + delta)
  }
  if (firstOnTrack.size === 0) return null
  for (const v of before.values()) {
    if (v.kind !== 'Layer' || v.composition_id !== compositionId) continue
    const from = firstOnTrack.get(v.track_id)
    if (from === undefined || v.layer.t_start_us < from) continue
    const c = after.get(keyOf(v))
    if (c?.kind !== 'Layer' || c.track_id !== v.track_id) continue // gone, or gone elsewhere
    if ((c.layer.t_start_us - v.layer.t_start_us) * sign < Math.abs(delta) - tolerance) return null
  }
  const ending = others.filter((o) => o.ranges.some((r) => r.composition_id === compositionId && Math.abs(r.t_end_us - newStart) <= tolerance))
  return ending.find((o) => o.class === 'removed') ?? ending.find((o) => o.details.some((d) => d.type === 'trim')) ?? ending[0] ?? null
}

// ── diffProjects ──────────────────────────────────────────────────────────────

/**
 * Entity-level differences between the (effective) baseline and `current`.
 *
 * Classes: `added`, `removed` and `modified` (with aspects). A move to another
 * track or composition is `modified` with `placement` and both locations. A
 * layer or anchored marker whose ONLY difference is a pure translation of its
 * timing in place is `modified` with `timing` and `delta_us`, grouped per
 * composition and delta into one change — `carried` when it is the content
 * after another change closing up or making room (`carrierOf`), with that
 * change's id as `carried_by`. A deliberate move gets `was` (`placeMoves`). A
 * composition added or removed carries its own tracks in the same change.
 * Ordered by listed composition (current root first), then by time; changes
 * with no footprint come after the timed ones of their composition.
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
  const shifts = new Map<string, { composition_id: Uuid; delta: number; keys: EntityKey[]; ranges: TimeRange[]; layers: number }>()
  const compositionChanges = new Map<Uuid, Change>()
  const pendingTracks: Array<{ value: EntityValue; cls: 'added' | 'removed' }> = []

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
    if (shift !== null) {
      const comp = (c as LayerEntity | MarkerEntity).composition_id
      const gk = `${comp}|${shift}`
      let g = shifts.get(gk)
      if (!g) shifts.set(gk, g = { composition_id: comp, delta: shift, keys: [], ranges: [], layers: 0 })
      g.keys.push(key)
      if (b.kind === 'Layer') g.layers += 1
      g.ranges.push(footprint(c, after)!)
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

  const others = [...changes]
  for (const g of shifts.values()) {
    g.keys.sort()
    const change: Change = {
      id: `Shift:${g.composition_id}:${g.delta}`, class: 'modified', kind: g.layers > 0 ? 'Layer' : 'Marker', keys: g.keys, aspects: ['timing'],
      details: [{ type: 'shift', delta_us: g.delta }],
      composition_id: g.composition_id, composition_ids: [g.composition_id], delta_us: g.delta, ranges: mergeRanges(g.ranges),
    }
    const carrier = carrierOf(g.composition_id, g.delta, g.keys, before, after, others, current)
    if (carrier) { change.carried = true; change.carried_by = carrier.id }
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
