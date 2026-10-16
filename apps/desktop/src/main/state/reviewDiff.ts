// apps/desktop/src/main/state/reviewDiff.ts
//
// Entity-level structural diff between a Review baseline and the current
// project, and its projection onto per-composition time ranges (spec
// `.scratch/agent-review/spec.md` Part B — Diff; ADR 0115).
//
// Pure: no I/O, no actor. Both sides are whole projects — the baseline is the
// snapshot History keeps.
//
// Preference-shaped fields — the ones History patches into every snapshot
// (track enabled/muted/solo/locked/height, the composition envelope, settings,
// media pool) — are never compared: a value patched everywhere cannot differ.
import { layerRate, sourceIn, sourceOut } from '../../renderer/layerTiming'
import { approximateTime, compareTime, divideTime, subtractTime } from '../../renderer/timeMapping'
import type { Composition, Effect, Layer, LayerParams, Marker, MediaItem, Project, Uuid } from './model'
import { hasSourceWindow } from './mutations/helpers'
import { mediaLabel } from './summary'
import { TEXT_NAME_MAX, textSnippet } from '../../shared/textSnippet'
import { changeKind, type Change, type ChangeAspect, type ChangeClass, type ChangeDetail, type EntityKind, type GroupDecoration, type PlacedRange } from '../../shared/review'

import { compareEntities, trackOrderEqual, linkLabel, entitiesEqual, entityKey, extractEntities, jsonEqual, type EntityIndex, type EntityValue } from './reviewEntities'

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

/** Classify changed fields of this layer alone. */
function compareLayers(a: LayerEntity, b: LayerEntity): { aspects: Set<ChangeAspect>; keys: ParamKeys } {
  const out = new Set<ChangeAspect>()
  const keys: ParamKeys = { params: new Set(), keyframes: new Set() }
  const la = a.layer, lb = b.layer
  if (a.composition_id !== b.composition_id || a.track_id !== b.track_id) out.add('placement')
  // Timeline times compare only on one clock: across compositions the two
  // values are not the same quantity (the move itself is `placement`).
  if (a.composition_id === b.composition_id && (la.t_start_us !== lb.t_start_us || la.t_end_us !== lb.t_end_us)) out.add('timing')
  if (la.label !== lb.label) out.add('label')
  if (la.enabled !== lb.enabled || la.locked !== lb.locked) out.add('flags')
  if (!jsonEqual(la.effects, lb.effects)) out.add('effects')
  if (!jsonEqual(la.metadata, lb.metadata)) out.add('params')
  if (la.params !== lb.params) {
    const pa = la.params as unknown as Record<string, unknown>
    const pb = lb.params as unknown as Record<string, unknown>
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (TIMING_PARAM_KEYS.has(k)) {
        if (!jsonEqual(pa[k], pb[k])) out.add('timing')
      } else if (RETIME_PARAM_KEYS.has(k)) {
        if (!jsonEqual(pa[k], pb[k])) out.add('retime')
      } else paramChanges(pa[k], pb[k], k, keys)
    }
  }
  if (keys.params.size > 0) out.add('params')
  if (keys.keyframes.size > 0) out.add('keyframes')
  return { aspects: out, keys }
}

/** A marker tied to the same clip on both sides is placed by its anchor —
 *  the model's truth; `t_us` is a cache re-derived from the clip on every
 *  commit (`reconcileMarkers`). So it compares the source instant it names
 *  and a region's length, the fields that are its own: riding along with its
 *  clip changes neither, and the clip's change already says the clip moved.
 *  A region's end follows by a re-snapped delta, so its length may differ by
 *  a microsecond at a fractional rate without anything having been edited. */
function anchoredTimingEqual(ma: Marker, mb: Marker): boolean {
  const len = (m: Marker) => (m.end_t_us === null ? null : m.end_t_us - m.t_us)
  const la = len(ma), lb = len(mb)
  const lengthEqual = la === null || lb === null ? la === lb : Math.abs(la - lb) <= 1
  return ma.anchor!.src_us === mb.anchor!.src_us && jsonEqual(ma.anchor!.src_fraction, mb.anchor!.src_fraction) && lengthEqual
}

function compareMarkers(a: MarkerEntity, b: MarkerEntity): { aspects: Set<ChangeAspect> } {
  const out = new Set<ChangeAspect>()
  const ma = a.marker, mb = b.marker
  const sameAnchor = ma.anchor != null && mb.anchor != null && ma.anchor.layer === mb.anchor.layer
  if (a.composition_id !== b.composition_id) out.add('placement')
  if (a.composition_id === b.composition_id) {
    const timingEqual = sameAnchor ? anchoredTimingEqual(ma, mb) : ma.t_us === mb.t_us && ma.end_t_us === mb.end_t_us
    if (!timingEqual) out.add('timing')
  }
  if (ma.label !== mb.label || ma.note !== mb.note) out.add('label')
  if (!jsonEqual(ma.color, mb.color)) out.add('params')
  // Tied, untied or tied to another clip; a new instant on the same clip is timing.
  if (!sameAnchor && (ma.anchor != null || mb.anchor != null)) out.add('placement')
  return { aspects: out }
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

/** Where an entity lives: its composition and, for a layer, its track. Null
 *  for a composition. */
function locationOf(v: EntityValue): { composition_id: Uuid; track_id: Uuid | null } | null {
  if (v.kind === 'Composition') return null
  return { composition_id: v.composition_id, track_id: v.kind === 'Layer' ? v.track_id : null }
}

// ── Details ───────────────────────────────────────────────────────────────────
//
// What a change did, as facts the renderer words (`ChangeDetail`). Each aspect
// says what it can in aspect order; one with nothing more to say is named by
// itself, so every aspect a change lists is in its details.

/** Details per aspect, with a generic field category when no finer fact exists. */
function detailsOf(aspects: readonly ChangeAspect[], say: (aspect: ChangeAspect, out: ChangeDetail[]) => void): ChangeDetail[] {
  const out: ChangeDetail[] = []
  for (const aspect of aspects) {
    const n = out.length
    say(aspect, out)
    if (out.length === n) out.push({ type: 'aspect', aspect })
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

/** Compare only this entity's timing values. No edit classification. */
function timeDetails(a: number, b: number, field: Extract<ChangeDetail, { type: 'time' }>['field']): ChangeDetail[] {
  return a === b ? [] : [{ type: 'time', field, from_us: a, to_us: b }]
}

/** Window differences only, not a reconstruction of the editing gesture.
 *  Source windows allow a trim to remain measurable after a move. Without
 *  one, only nested timeline spans identify which edges gained/lost time. */
function trimDetails(a: Layer, b: Layer, rebased: boolean): ChangeDetail[] {
  if (a.params.kind !== b.params.kind || rateOf(a.params) !== rateOf(b.params)) return []
  if ('media' in a.params && 'media' in b.params && a.params.media !== b.params.media) return []
  if ('composition' in a.params && 'composition' in b.params && a.params.composition !== b.params.composition) return []
  let start: number, end: number
  const windowed = hasSourceWindow(a.params) && hasSourceWindow(b.params)
    || 'content_window' in a.params && a.params.content_window !== undefined
    || 'content_window' in b.params && b.params.content_window !== undefined
  if (windowed) {
    const head = subtractTime(sourceIn(b.params), sourceIn(a.params))
    const tail = subtractTime(sourceOut(b), sourceOut(a))
    // Equal source translations are a slip, not a shorter/longer window.
    if (compareTime(head, tail) === 0) return []
    start = -approximateTime(divideTime(head, layerRate(b.params)))
    end = approximateTime(divideTime(tail, layerRate(b.params)))
  } else {
    if (rebased) return []
    const ds = b.t_start_us - a.t_start_us, de = b.t_end_us - a.t_end_us
    if (ds * de > 0 || ds === de) return []
    start = -ds; end = de
  }
  const out: ChangeDetail[] = []
  if (start !== 0) out.push({ type: 'trim', side: 'start', delta_us: start })
  if (end !== 0) out.push({ type: 'trim', side: 'end', delta_us: end })
  return out
}

function layerTimingDetails(a: Layer, b: Layer, rebased: boolean): ChangeDetail[] {
  // Across compositions only the source clock is shared.
  const out = rebased ? [] : [...timeDetails(a.t_start_us, b.t_start_us, 'start'), ...timeDetails(a.t_end_us, b.t_end_us, 'end')]
  if (hasSourceWindow(a.params) && hasSourceWindow(b.params)) {
    out.push(...timeDetails(approximateTime(sourceIn(a.params)), approximateTime(sourceIn(b.params)), 'source_start'))
    out.push(...timeDetails(approximateTime(sourceOut(a)), approximateTime(sourceOut(b)), 'source_end'))
  }
  return [...out, ...trimDetails(a, b, rebased)]
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
      case 'timing': out.push(...layerTimingDetails(la, lb, rebased)); return
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
      case 'timing':
        out.push(...timeDetails(ma.t_us, mb.t_us, 'start'))
        // A point marker has no end; one side's region end against the
        // other's point compares that point.
        if (ma.end_t_us !== null || mb.end_t_us !== null) out.push(...timeDetails(ma.end_t_us ?? ma.t_us, mb.end_t_us ?? mb.t_us, 'end'))
        return
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

/** An entity's own name in a snapshot, as the rest of the app would show it
 *  first: a clip's label, else its media's or its text's, a Group clip's
 *  composition label; a marker's, track's or composition's label. Undefined
 *  when it has none — the surface then names its kind. `index` is the same
 *  snapshot's entities; `media` the pool (never compared, the same on both). */
function nameOf(v: EntityValue, index: EntityIndex, media: Record<Uuid, MediaItem>): string | undefined {
  const name = (() => {
    switch (v.kind) {
      case 'Layer': {
        const own = v.layer.label?.trim()
        if (own) return own
        const p = v.layer.params
        if ('media' in p) { const m = media[p.media]; return m ? mediaLabel(m) : undefined }
        if (p.kind === 'Text') return textSnippet(p.content, TEXT_NAME_MAX)
        if (p.kind === 'CompositionRef') { const c = index.get(entityKey('Composition', p.composition)); return c?.kind === 'Composition' ? c.label ?? undefined : undefined }
        return undefined
      }
      case 'Marker': return v.marker.label
      case 'Track': case 'Composition': return v.label ?? undefined
      default: return undefined
    }
  })()
  return name?.trim() || undefined
}

// ── Footprints and ranges ─────────────────────────────────────────────────────

/** Where an entity sits on its composition's timeline — on its track, for a
 *  layer; null when it has no time footprint (track, link, composition).
 *  `index` is the SAME side's entities — a transition's footprint is read off
 *  its own side's layers. */
function footprint(v: EntityValue, index: EntityIndex): PlacedRange | null {
  switch (v.kind) {
    case 'Layer': return { composition_id: v.composition_id, track_id: v.track_id, t_start_us: v.layer.t_start_us, t_end_us: v.layer.t_end_us }
    case 'Marker': return { composition_id: v.composition_id, track_id: null, t_start_us: v.marker.t_us, t_end_us: v.marker.end_t_us ?? v.marker.t_us }
    case 'Transition': {
      // The overlap is [incoming.t_start, outgoing.t_end] and its length is
      // duration_us (validate's overlap === duration).
      const d = v.transition.duration_us
      const to = index.get(entityKey('Layer', v.transition.to_layer))
      if (to?.kind === 'Layer') return { composition_id: v.composition_id, track_id: null, t_start_us: to.layer.t_start_us, t_end_us: to.layer.t_start_us + d }
      const from = index.get(entityKey('Layer', v.transition.from_layer))
      if (from?.kind === 'Layer') return { composition_id: v.composition_id, track_id: null, t_start_us: from.layer.t_end_us - d, t_end_us: from.layer.t_end_us }
      return null
    }
    default: return null
  }
}

/** Historical facts projected only onto surviving entities by identity.
 * Removed entities have no known current position. Their historical footprint
 * stays in before_ranges, never guessed from neighbouring material. */
export function locateChanges(changes: readonly Change[], current: Project): Change[] {
  const now = extractEntities(current)
  return changes.map(c => {
    const entity = now.get(c.id)
    const range = c.class !== 'removed' && entity ? footprint(entity, now) : null
    return { ...c, ranges: range ? [range] : [] }
  })
}

/** A modified layer's or marker's change, kept per pair of model objects and
 *  their places: everything it says — what differs, its details, both
 *  footprints — is read off those alone. The Review view is recomputed on
 *  every commit, and after a ripple most of its changes are of objects the
 *  commit did not touch: they are found here, the very same Change, instead
 *  of compared again. `null`: the pair differs in no compared field. */
interface KeptModification { b: Kept; c: Kept; change: Change | null }
const modifications = new WeakMap<object, WeakMap<object, KeptModification>>()
type Kept = LayerEntity | MarkerEntity
const keptObject = (v: Kept): object => (v.kind === 'Layer' ? v.layer : v.marker)
const keepable = (v: EntityValue): v is Kept => v.kind === 'Layer' || v.kind === 'Marker'
const samePlace = (x: Kept, y: Kept): boolean =>
  x.composition_id === y.composition_id && (x.kind !== 'Layer' || x.track_id === (y as LayerEntity).track_id)
function keptModification(b: EntityValue, c: EntityValue): Change | null | undefined {
  if (!keepable(b) || !keepable(c) || b.kind !== c.kind || keptObject(b) === keptObject(c)) return undefined
  const hit = modifications.get(keptObject(b))?.get(keptObject(c))
  return hit && samePlace(hit.b, b) && samePlace(hit.c, c) ? hit.change : undefined
}
function keepModification(b: EntityValue, c: EntityValue, change: Change | null): void {
  if (!keepable(b) || !keepable(c) || b.kind !== c.kind) return
  let byAfter = modifications.get(keptObject(b))
  if (!byAfter) modifications.set(keptObject(b), byAfter = new WeakMap())
  byAfter.set(keptObject(c), { b, c, change })
}

/** Net values only; one stable change per entity. */
export function diffProjects(baseline: Project, current: Project): Change[] {
  const { before, after, keys } = compareEntities(baseline, current)
  const changes: Change[] = []

  const emit = (cls: ChangeClass, b: EntityValue | undefined, c: EntityValue | undefined, details: ChangeDetail[]): Change => {
    const v = (c ?? b)!
    const fc = c && footprint(c, after)
    const fb = b && footprint(b, before)
    const change: Change = {
      id: entityKey(v.kind, v.id), class: cls, details,
      composition_id: (c && locationOf(c))?.composition_id ?? (b && locationOf(b))?.composition_id ?? null,
      ranges: fc ? [fc] : [],
    }
    if (fb) change.before_ranges = [fb]
    // Gone from the current project, it can be named only from the baseline.
    if (cls === 'removed' && b) { const name = nameOf(b, before, current.media_pool); if (name) change.before_name = name }
    changes.push(change)
    return change
  }

  for (const key of keys) {
    const b = before.get(key), c = after.get(key)
    const kept = b && c ? keptModification(b, c) : undefined
    if (kept !== undefined) { if (kept !== null) changes.push(kept); continue }
    if (entitiesEqual(b, c)) continue
    if (!b || !c) {
      const v = (b ?? c)!
      const cls = b ? 'removed' : 'added'
      emit(cls, b, c, lengthDetails(v))
      continue
    }
    let aspects: Set<ChangeAspect>
    let params: ParamKeys | null = null
    if (b.kind === 'Layer') ({ aspects, keys: params } = compareLayers(b, c as LayerEntity))
    else if (b.kind === 'Marker') ({ aspects } = compareMarkers(b, c as MarkerEntity))
    else aspects = compareOther(b, c)
    if (aspects.size === 0) { keepModification(b, c, null); continue } // differs only in an uncompared field
    const lb = locationOf(b), lc = locationOf(c)
    const moved = lb !== null && lc !== null && (lb.composition_id !== lc.composition_id || lb.track_id !== lc.track_id)
    if (moved) aspects.add('placement')
    const ordered = orderedAspects(aspects)
    const details = b.kind === 'Layer' ? layerDetails(b, c as LayerEntity, ordered, params!)
      : b.kind === 'Marker' ? markerDetails(b, c as MarkerEntity, ordered) : otherDetails(ordered)
    keepModification(b, c, emit('modified', b, c, details))
  }

  const rootId = current.root_id
  const rank = (c: Change): string => c.composition_id === null ? '\u0002' : c.composition_id === rootId ? '\u0000' : `\u0001${c.composition_id}`
  changes.sort((x, y) => {
    const rx = rank(x), ry = rank(y)
    if (rx !== ry) return rx < ry ? -1 : 1
    const xr = x.ranges[0] ?? x.before_ranges?.[0], yr = y.ranges[0] ?? y.before_ranges?.[0]
    const tx = !!xr, ty = !!yr
    if (tx !== ty) return tx ? -1 : 1
    const d = tx ? (xr!.t_start_us - yr!.t_start_us) || (xr!.t_end_us - yr!.t_end_us) : 0
    return d || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  })
  return changes
}

// ── Group propagation ─────────────────────────────────────────────────────────

/**
 * Every Group layer in `current` whose `params.composition` holds a change —
 * recursively: a Group layer inside a decorated Group's composition decorates
 * the Group layers showing THAT composition, up to the root — from either
 * side's composition, so a clip moved out of a Group still decorates it. Only
 * a change with a place on the composition's timeline decorates (a layer,
 * marker or transition): a composition-level change (a Group's label, its
 * creation) is not inside it, and a track or link inside has no place there.
 */
const FOOTPRINT_KINDS: ReadonlySet<EntityKind> = new Set(['Layer', 'Marker', 'Transition'])

/** A composition's Group layers, kept per composition object: a commit
 *  re-reads only the compositions it touched. */
const groupLayers = new WeakMap<Composition, readonly Layer[]>()
function groupLayersOf(c: Composition): readonly Layer[] {
  let out = groupLayers.get(c)
  if (!out) {
    const found: Layer[] = []
    for (const t of c.tracks) for (const l of t.layers) if (l.params.kind === 'CompositionRef') found.push(l)
    groupLayers.set(c, out = found)
  }
  return out
}

export function groupDecorations(changes: readonly Change[], current: Project): GroupDecoration[] {
  const shownBy = new Map<Uuid, Array<{ layer: Layer; composition_id: Uuid }>>()
  for (const c of Object.values(current.compositions))
    for (const l of groupLayersOf(c)) {
      const ref = (l.params as Extract<LayerParams, { kind: 'CompositionRef' }>).composition
      const list = shownBy.get(ref) ?? []
      list.push({ layer: l, composition_id: c.id })
      shownBy.set(ref, list)
    }
  // No Group layer anywhere — the common case — decorates nothing.
  if (shownBy.size === 0) return []
  const out = new Map<Uuid, GroupDecoration>()
  for (const change of changes) {
    if (!FOOTPRINT_KINDS.has(changeKind(change))) continue
    const seen = new Set<Uuid>()
    const queue = [...new Set([...change.ranges, ...change.before_ranges ?? []].map(r => r.composition_id))]
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
