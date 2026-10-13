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
import type { Composition, Layer, Link, Marker, Project, Track, TrackRole, Transition, Uuid } from './model'
import type { Change, ChangeAspect, ChangeClass, EntityKey, EntityKind, EntityLocation, GroupDecoration, TimeRange } from '../../shared/review'

export type { Change, ChangeAspect, ChangeClass, EntityKey, EntityKind, EntityLocation, GroupDecoration, TimeRange }

// ── Entities ──────────────────────────────────────────────────────────────────

/** One entity's compared value plus where it lives. Composition and Track
 *  values are slim (only compared fields), so an approved overlay entry never
 *  pins a whole track's layers. A composition's `track_order` (its tracks'
 *  ids, top of the list first) is compared because it is the z-order: a
 *  `move_track` reorder is a reviewable `placement` change of the composition. Layer/Marker/Transition/Link hold the model
 *  object itself (shared with the snapshot, never copied). */
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
export function parseEntityKey(key: EntityKey): { kind: EntityKind; id: Uuid } {
  const at = key.indexOf(':')
  return { kind: key.slice(0, at) as EntityKind, id: key.slice(at + 1) }
}
function keyOf(v: EntityValue): EntityKey { return entityKey(v.kind, v.id) }

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
/** Classify a params subtree difference: an animated track that is keyframed
 *  on either side is `keyframes`; any other difference is `params`. */
function paramAspects(a: unknown, b: unknown, out: Set<ChangeAspect>): void {
  if (jsonEqual(a, b)) return
  if (isAnimated(a) || isAnimated(b)) {
    const bothStatic = isAnimated(a) && isAnimated(b) && a.mode === 'Static' && b.mode === 'Static'
    out.add(bothStatic ? 'params' : 'keyframes')
    return
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ra = a as Record<string, unknown>
    const rb = b as Record<string, unknown>
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) paramAspects(ra[k], rb[k], out)
    return
  }
  out.add('params')
}

type LayerEntity = Extract<EntityValue, { kind: 'Layer' }>
type MarkerEntity = Extract<EntityValue, { kind: 'Marker' }>

/** Aspects of a layer difference, plus the translation if the difference is
 *  exactly a pure translation on the same track. */
function compareLayers(a: LayerEntity, b: LayerEntity): { aspects: Set<ChangeAspect>; shift: number | null } {
  const out = new Set<ChangeAspect>()
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
      } else paramAspects(pa[k], pb[k], out)
    }
  }
  const delta = lb.t_start_us - la.t_start_us
  const shift = out.size === 1 && out.has('timing') && !windowChanged && delta !== 0 && lb.t_end_us - la.t_end_us === delta ? delta : null
  return { aspects: out, shift }
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

// ── diffProjects ──────────────────────────────────────────────────────────────

/**
 * Entity-level differences between the (effective) baseline and `current`.
 *
 * Classes: `added`, `removed`, `moved` (layer track/composition, or any other
 * entity's composition, changed), `modified` (with aspects) and `shifted` (a
 * layer or anchored marker whose ONLY difference is a pure translation of its
 * timing in place; grouped per composition and delta into one change). A
 * composition added or removed carries its own tracks in the same change.
 * Ordered by listed composition (current root first), then by time; changes
 * with no footprint come after the timed ones of their composition.
 */
export function diffProjects(baseline: BaselineSource, current: Project): Change[] {
  const before = effectiveEntities(baseline)
  const after = extractEntities(current)
  if (before === after) return []
  const changes: Change[] = []
  const shifts = new Map<string, { composition_id: Uuid; delta: number; keys: EntityKey[]; ranges: TimeRange[]; layers: number }>()
  const compositionChanges = new Map<Uuid, Change>()
  const pendingTracks: Array<{ value: EntityValue; cls: 'added' | 'removed' }> = []

  const emit = (cls: ChangeClass, b: EntityValue | undefined, c: EntityValue | undefined, aspects: ChangeAspect[]): Change => {
    const v = (c ?? b)!
    const ranges: TimeRange[] = []
    const fb = b && footprint(b, before)
    const fc = c && footprint(c, after)
    if (fb) ranges.push(fb)
    if (fc) ranges.push(fc)
    const lb = b && locationOf(b), lc = c && locationOf(c)
    const comps = [...new Set([lc?.composition_id, lb?.composition_id].filter((x): x is Uuid => x !== undefined))]
    const change: Change = {
      id: keyOf(v), class: cls, kind: v.kind, keys: [keyOf(v)], aspects,
      composition_id: lc?.composition_id ?? lb?.composition_id ?? null, composition_ids: comps,
      ranges: mergeRanges(ranges),
    }
    if (cls === 'moved' && lb && lc) { change.from = lb; change.to = lc }
    changes.push(change)
    return change
  }

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key), c = after.get(key)
    if (entitiesEqual(b, c)) continue
    if (!b || !c) {
      const v = (b ?? c)!
      const cls = b ? 'removed' : 'added'
      if (v.kind === 'Track') { pendingTracks.push({ value: v, cls }); continue }
      const ch = emit(cls, b, c, [])
      if (v.kind === 'Composition') compositionChanges.set(v.id, ch)
      continue
    }
    let aspects: Set<ChangeAspect>
    let shift: number | null = null
    if (b.kind === 'Layer') ({ aspects, shift } = compareLayers(b, c as LayerEntity))
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
      g.ranges.push(footprint(b, before)!, footprint(c, after)!)
      continue
    }
    const lb = locationOf(b), lc = locationOf(c)
    const moved = lb !== null && lc !== null && (lb.composition_id !== lc.composition_id || lb.track_id !== lc.track_id)
    if (moved) aspects.add('placement')
    emit(moved ? 'moved' : 'modified', b, c, orderedAspects(aspects))
  }

  // A composition's tracks arrive and leave with it: fold them into its change.
  for (const { value, cls } of pendingTracks) {
    const owner = value.kind === 'Track' ? compositionChanges.get(value.composition_id) : undefined
    if (owner && owner.class === cls) owner.keys.push(keyOf(value))
    else emit(cls, cls === 'removed' ? value : undefined, cls === 'added' ? value : undefined, [])
  }

  for (const g of shifts.values()) {
    g.keys.sort()
    changes.push({
      id: `Shift:${g.composition_id}:${g.delta}`, class: 'shifted', kind: g.layers > 0 ? 'Layer' : 'Marker', keys: g.keys, aspects: [],
      composition_id: g.composition_id, composition_ids: [g.composition_id], delta_us: g.delta, ranges: mergeRanges(g.ranges),
    })
  }

  const rootId = current.root_id
  const rank = (c: Change): string => c.composition_id === null ? '\u0002' : c.composition_id === rootId ? '\u0000' : `\u0001${c.composition_id}`
  changes.sort((x, y) => {
    const rx = rank(x), ry = rank(y)
    if (rx !== ry) return rx < ry ? -1 : 1
    const tx = x.ranges.length > 0, ty = y.ranges.length > 0
    if (tx !== ty) return tx ? -1 : 1
    const d = tx ? (x.ranges[0].t_start_us - y.ranges[0].t_start_us) || (x.ranges[0].t_end_us - y.ranges[0].t_end_us) : 0
    return d || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  })
  return changes
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
