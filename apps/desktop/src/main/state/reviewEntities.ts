// Internal entity comparison and approval representation shared by history and diff.
import type { Composition, Layer, Link, Marker, Project, Track, TrackRole, Transition, Uuid } from './model'
import { entityKey, type EntityKey, type EntityKind } from '../../shared/review'

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

export { entityKey }
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
function effectiveEntities(src: BaselineSource): EntityIndex {
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

export function transitionEqual(a: Transition, b: Transition): boolean {
  // Compared: participants, duration, kind (+ direction). `extended_us` is the
  // inverse ops' bookkeeping, not something the user reviews (spec table).
  return a.from_layer === b.from_layer && a.to_layer === b.to_layer && a.duration_us === b.duration_us && jsonEqual(a.kind, b.kind)
}
export function linkLabel(l: Link): unknown { return (l as Link & { label?: unknown }).label ?? null }

/** Same relative order of the tracks both sides hold. Adding or removing a
 *  track is that track's own change, not a reorder of its composition. */
export function trackOrderEqual(a: readonly Uuid[], b: readonly Uuid[]): boolean {
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

/** Comparison indexes and candidate keys; snapshot sharing and approvals stay private. */
export function compareEntities(baseline: BaselineSource, current: Project): { before: EntityIndex; after: EntityIndex; keys: ReadonlySet<EntityKey> } {
  const before = effectiveEntities(baseline)
  const after = extractEntities(current)
  if (before === after) return { before, after, keys: new Set() }
  // Only the keys of compositions that may differ: one immer shared between
  // the two sides, with no approval reaching into it, holds the very same
  // entity values on both and cannot.
  const base = isOverlay(baseline) ? baseline.base : baseline
  const shared = sharedCompositions(baseline, current)
  const keys = new Set<EntityKey>()
  for (const p of [base, current])
    for (const c of Object.values(p.compositions)) if (!shared.has(c.id)) for (const v of compositionEntities(c)) keys.add(keyOf(v))
  if (isOverlay(baseline)) for (const k of baseline.approved.keys()) keys.add(k)
  return { before, after, keys }
}
