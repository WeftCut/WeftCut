// apps/desktop/src/main/state/mutations/groups.ts
// Pre-compose and ungroup — the only two mutations that move layers BETWEEN
// compositions (every other op is scoped to one; ADR 0052, spec § Group
// semantics) — plus the composition-envelope ops with no other home: rename and
// delete. Rendering, navigation and the UI surface live elsewhere.
import type { Animated, Composition, CompositionRefParams, Layer, Project, Track, Transform, Uuid } from '../model'
import { eachLayer, newComposition } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { frameGrid, gridForLayerKind, snapOnGrid } from '../snap'
import { layerOverlapClass } from '../validate'
import { applyAddTrack, defaultTransform } from './add'
import {
  applyDurationAutofit, cloneLayer, compositionOf, dropLayerFromLinks, hasSourceWindow, locateLayerIn,
  pickFreeOverlayTrack, pruneEmptiedTrack, requireLayer, requireSameComposition, shiftLayerKeyframes,
} from './helpers'

export interface GroupCreateResult { compositionId: Uuid; layerId: Uuid }
export type GroupNotPlainReason = 'transform' | 'opacity' | 'effects' | 'blend_mode'

/** A blank label is no label: the renderer derives "Group N" from null, and a
 *  stored `''` would render as an empty name (same rule as `applyRenameTrack`). */
function normalizeLabel(label: string | null): string | null {
  const next = label?.trim()
  return next ? next : null
}

function insertSorted(track: Track, layer: Layer): void {
  const at = track.layers.findIndex((l) => l.t_start_us > layer.t_start_us)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, layer)
}

/** How many Group layers, in any composition, reference `compositionId`. */
export function compositionRefCount(p: Project, compositionId: Uuid): number {
  let n = 0
  for (const { layer } of eachLayer(p)) if (layer.params.kind === 'CompositionRef' && layer.params.composition === compositionId) n++
  return n
}

/** Pre-compose (spec § Pre-compose, steps 1–5): move `layerIds` — one or more
 *  layers of ONE composition P — into a new composition C that copies P's
 *  settings and the reserved A/B skeleton, and place C back in P as one Group
 *  layer at the set's earliest start. Members shift by `-t0` on their own
 *  lattice (keyframes are layer-local, so a whole-layer shift leaves them alone
 *  — same as `applyMoveLayer`). P's tracks that held members map bottom-up onto
 *  C's A roll, B roll, then fresh transient lanes, so relative z-order survives.
 *
 *  Links fully inside the set move to C with their ids; a straddling link loses
 *  its inside members and dissolves below two. Transitions between two members
 *  move; a straddling one is left in P for `reconcileTransitions` to drop and the
 *  actor to log — the drop rule has one home, and the commit runs it anyway.
 *  Markers stay in P.
 *
 *  The Group layer lands on the top-most former track; if its span now collides
 *  there it takes the drop strip's route (`pickFreeOverlayTrack`, else a lane
 *  spawned above). Returns the new composition's and Group layer's ids. */
export function applyGroupsCreate(p: Project, idGen: IdGen, layerIds: readonly Uuid[], label: string | null): GroupCreateResult {
  const ids = [...new Set(layerIds)]
  const parent = requireSameComposition(p, ids) // InvalidArgument (empty) / LayerNotFound / CrossCompositionSet
  // Every lock is checked before ANY id is minted or layer moved: a pre-compose
  // that took the unlocked half of a selection would leave a Group the user did
  // not ask for and a refusal they cannot act on (never partial); and refusing
  // here rather than mid-move keeps the id contract — a refused op burns no id.
  const located = ids.map((id) => locateLayerIn(parent, id)!) // requireSameComposition located each
  for (const m of located) {
    if (m.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: m.track.id })
    if (m.layer.locked) throw new CommandFailure({ error: 'GroupLockedMember', layer: m.layer.id })
  }
  const memberSet = new Set(ids)
  const t0 = Math.min(...located.map((m) => m.layer.t_start_us))
  // Former tracks bottom-up: P's index order IS z order. Read before any splice.
  const formerTrackIds = [...new Set(located.map((m) => m.trackIndex))].sort((a, b) => a - b).map((i) => parent.tracks[i].id)
  const topFormerId = formerTrackIds[formerTrackIds.length - 1]

  const { width, height, fps, sample_rate, channels, color_space, background } = parent
  const child = newComposition(idGen(), idGen, normalizeLabel(label), { width, height, fps, sample_rate, channels, color_space, background })
  p.compositions[child.id] = child
  const skeleton = child.tracks.map((t) => t.id) // A roll, B roll
  const laneOf = new Map<Uuid, Uuid>()
  formerTrackIds.forEach((formerId, k) => {
    laneOf.set(formerId, k < skeleton.length ? skeleton[k] : applyAddTrack(p, idGen, null, undefined, child.id))
  })

  for (const id of ids) {
    // Re-locate: the splices below shift `layerIndex` (helpers.ts LocatedLayer).
    const loc = locateLayerIn(parent, id)!
    const layer = loc.track.layers.splice(loc.layerIndex, 1)[0]
    // `-t0` is a delta between two canonical times, which at a fractional rate
    // is not itself canonical — re-snap on the layer's OWN grid, as move does.
    const grid = gridForLayerKind(layer.params.kind, fps)
    layer.t_start_us = snapOnGrid(layer.t_start_us - t0, grid)
    layer.t_end_us = snapOnGrid(layer.t_end_us - t0, grid)
    insertSorted(child.tracks.find((t) => t.id === laneOf.get(loc.track.id))!, layer)
  }

  for (let i = 0; i < parent.links.length;) {
    const link = parent.links[i]
    const inside = link.members.filter((m) => memberSet.has(m)).length
    if (inside === link.members.length) { child.links.push(link); parent.links.splice(i, 1); continue }
    if (inside > 0) {
      link.members = link.members.filter((m) => !memberSet.has(m))
      if (link.members.length < 2) { parent.links.splice(i, 1); continue }
    }
    i++
  }
  for (let i = 0; i < parent.transitions.length;) {
    const tr = parent.transitions[i]
    if (memberSet.has(tr.from_layer) && memberSet.has(tr.to_layer)) { child.transitions.push(tr); parent.transitions.splice(i, 1); continue }
    i++
  }

  applyDurationAutofit(child)
  const tEnd = snapOnGrid(t0 + child.duration_us, frameGrid(fps))
  const top = parent.tracks.find((t) => t.id === topFormerId)! // pruning runs after placement
  const collides = top.layers.some((l) => layerOverlapClass(l.params) === 'visual' && l.t_start_us < tEnd && t0 < l.t_end_us)
  const laneId = collides ? (pickFreeOverlayTrack(parent, t0, tEnd) ?? applyAddTrack(p, idGen, null, undefined, parent.id)) : topFormerId
  const params: CompositionRefParams = {
    kind: 'CompositionRef', composition: child.id, src_in_us: 0, src_out_us: child.duration_us,
    transform: defaultTransform(), opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal',
  }
  const layerId = idGen()
  insertSorted(parent.tracks.find((t) => t.id === laneId)!, {
    id: layerId, label: null, t_start_us: t0, t_end_us: tEnd, enabled: true, locked: false, metadata: {}, params, effects: [],
  })
  for (const formerId of formerTrackIds) pruneEmptiedTrack(parent, formerId)
  applyDurationAutofit(parent)
  return { compositionId: child.id, layerId }
}

const ANIMATED_TRANSFORM_KEYS = ['x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y'] as const
function isStatic(a: Animated<number>, value: number): boolean { return a.mode === 'Static' && a.value === value }

/** Why a Group layer is not plain, or null when it is. Plain = identity
 *  transform (including the `scale_linked` default), static opacity 1, no
 *  effects, Normal blend — exactly what ungroup could not carry onto the members. */
export function groupNotPlainReason(layer: Layer): GroupNotPlainReason | null {
  const pa = layer.params as CompositionRefParams
  const ident: Transform = defaultTransform()
  const identity = ANIMATED_TRANSFORM_KEYS.every((k) => isStatic(pa.transform[k], (ident[k] as { value: number }).value))
    && pa.transform.scale_linked === ident.scale_linked
  if (!identity) return 'transform'
  if (!isStatic(pa.opacity, 1)) return 'opacity'
  if (layer.effects.length > 0) return 'effects'
  if (pa.blend_mode !== 'Normal') return 'blend_mode'
  return null
}

/** Ungroup (spec § Ungroup; Resolve's *Decompose in Place*): expand the Group
 *  layer `layerId` back into its composition's members, in the parent P.
 *
 *  Refused unless the Group layer is plain (`GroupNotPlain { reason }`): a
 *  transform, an opacity or an effect chain on the Group applies to the
 *  composite and has no per-member equivalent, so expanding would discard the
 *  user's work silently — the outcome ADR 0048 and the refusal-surfacing
 *  decision (docs/features.md) both forbid. Refusing names the reason instead.
 *
 *  Every member of C intersecting the window `[src_in, src_out)` is copied into
 *  P at `t + t_start − src_in`, trimmed to the window with its source window
 *  following and keyframes re-based (trim's content-glue rule); members wholly
 *  outside are dropped. C's tracks become fresh transient lanes inserted at the
 *  ref's track index (z preserved; empty lanes are not created). Links and
 *  transitions inside carry over under fresh ids with remapped members — a link
 *  the window takes below two dissolves; a transition the trim broke is left for
 *  reconcile. The ref layer is removed and its lane pruned. C is removed when
 *  nothing references it any more; a second reference keeps it. */
export function applyGroupsUngroup(p: Project, idGen: IdGen, layerId: Uuid): void {
  const ref = requireLayer(p, layerId)
  if (ref.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: ref.track.id })
  const pa = ref.layer.params
  if (pa.kind !== 'CompositionRef') throw new CommandFailure({ error: 'WrongLayerKind', layer: layerId, expected: 'CompositionRef' })
  const reason = groupNotPlainReason(ref.layer)
  if (reason !== null) throw new CommandFailure({ error: 'GroupNotPlain', layer: layerId, reason })
  const parent = ref.comp
  const child = compositionOf(p, pa.composition)
  const { src_in_us: srcIn, src_out_us: srcOut } = pa
  const offset = ref.layer.t_start_us - srcIn

  const idMap = new Map<Uuid, Uuid>()
  const fresh: Track[] = []
  for (const t of child.tracks) {
    const hits = t.layers.filter((l) => l.t_start_us < srcOut && srcIn < l.t_end_us)
    if (hits.length === 0) continue
    const lane: Track = {
      id: idGen(), label: t.label, enabled: t.enabled, locked: t.locked, muted: t.muted, solo: t.solo,
      removable: true, role: null, transient: true, height_px: t.height_px, layers: [],
    }
    for (const l of hits) {
      const copy = cloneLayer(l)
      copy.id = idGen()
      idMap.set(l.id, copy.id)
      const a = Math.max(l.t_start_us, srcIn)
      const b = Math.min(l.t_end_us, srcOut)
      const cutIn = a - l.t_start_us
      const cutOut = l.t_end_us - b
      if (hasSourceWindow(copy.params)) { copy.params.src_in_us += cutIn; copy.params.src_out_us -= cutOut }
      if (cutIn > 0) shiftLayerKeyframes(copy.params, -cutIn)
      const grid = gridForLayerKind(copy.params.kind, parent.fps)
      copy.t_start_us = snapOnGrid(a + offset, grid)
      copy.t_end_us = snapOnGrid(b + offset, grid)
      lane.layers.push(copy) // `hits` is t-sorted and shifts uniformly, so this stays sorted
    }
    fresh.push(lane)
  }
  parent.tracks.splice(ref.trackIndex, 0, ...fresh)

  for (const link of child.links) {
    const members = link.members.flatMap((m) => { const n = idMap.get(m); return n === undefined ? [] : [n] }).sort()
    if (members.length < 2) continue
    const id = idGen()
    parent.links.push(link.label === undefined ? { id, members } : { id, label: link.label, members })
  }
  for (const tr of child.transitions) {
    const from = idMap.get(tr.from_layer)
    const to = idMap.get(tr.to_layer)
    if (from === undefined || to === undefined) continue
    parent.transitions.push({ id: idGen(), from_layer: from, to_layer: to, duration_us: tr.duration_us, kind: { ...tr.kind }, extended_us: tr.extended_us })
  }

  const refTrack = ref.track
  refTrack.layers.splice(refTrack.layers.findIndex((l) => l.id === layerId), 1)
  dropLayerFromLinks(parent, layerId)
  pruneEmptiedTrack(parent, refTrack.id)
  if (compositionRefCount(p, child.id) === 0) delete p.compositions[child.id]
  applyDurationAutofit(parent)
}

/** Name a Group's composition (null / blank clears back to the derived name).
 *  The root is refused: it has no name in the UI — it is "the timeline". */
export function applyGroupsRename(p: Project, compositionId: Uuid, label: string | null): void {
  const c = compositionOf(p, compositionId)
  if (c.id === p.root_id) throw new CommandFailure({ error: 'RootComposition', composition: compositionId })
  c.label = normalizeLabel(label)
}

/** Remove an UNREFERENCED composition (spec § Invariants: orphans are legal and
 *  this is one of the two ways a composition leaves). A referenced one is
 *  refused with its reference count; the root is never removable. */
export function applyCompositionsDelete(p: Project, compositionId: Uuid): void {
  const c: Composition = compositionOf(p, compositionId)
  if (c.id === p.root_id) throw new CommandFailure({ error: 'RootComposition', composition: compositionId })
  const refCount = compositionRefCount(p, compositionId)
  if (refCount > 0) throw new CommandFailure({ error: 'CompositionInUse', composition: compositionId, ref_count: refCount })
  delete p.compositions[compositionId]
}
