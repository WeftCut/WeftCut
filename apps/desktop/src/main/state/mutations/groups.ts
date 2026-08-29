// apps/desktop/src/main/state/mutations/groups.ts
// Pre-compose, add-to-Group and ungroup — the only three mutations that move
// layers BETWEEN compositions (every other op is scoped to one; ADR 0052, spec
// § Group semantics) — plus the composition-envelope ops with no other home:
// rename and delete. Rendering, navigation and the UI surface live elsewhere.
import type { Animated, Composition, CompositionRefParams, Layer, Project, Track, Transform, Uuid } from '../model'
import { eachLayer, newComposition } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { frameGrid, gridForLayerKind, snapOnGrid } from '../snap'
import { layerOverlapClass } from '../validate'
import { applyAddTrack, compositionRefPath, defaultTransform } from './add'
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

/** Links and transitions follow the SET across a composition boundary — the
 *  half both crossing ops share. A link or transition whose every member is in
 *  `memberSet` moves to `to` keeping its id; a link straddling the boundary
 *  loses its inside members and dissolves below two; a straddling transition is
 *  left in `from` for `reconcileTransitions` to drop and the actor to log — the
 *  drop rule has one home, and the commit runs it anyway. Markers are never
 *  touched: they mark a composition's own time, not the layers that left it. */
function moveLinksAndTransitions(from: Composition, to: Composition, memberSet: ReadonlySet<Uuid>): void {
  for (let i = 0; i < from.links.length;) {
    const link = from.links[i]
    const inside = link.members.filter((m) => memberSet.has(m)).length
    if (inside === link.members.length) { to.links.push(link); from.links.splice(i, 1); continue }
    if (inside > 0) {
      link.members = link.members.filter((m) => !memberSet.has(m))
      if (link.members.length < 2) { from.links.splice(i, 1); continue }
    }
    i++
  }
  for (let i = 0; i < from.transitions.length;) {
    const tr = from.transitions[i]
    if (memberSet.has(tr.from_layer) && memberSet.has(tr.to_layer)) { to.transitions.push(tr); from.transitions.splice(i, 1); continue }
    i++
  }
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
 *  Links and transitions follow the set — see `moveLinksAndTransitions`.
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

  moveLinksAndTransitions(parent, child, memberSet)

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

/** Add members to an existing Group (spec § Add members to an existing Group):
 *  move `layerIds` — one or more layers of ONE composition P — into the
 *  composition the Group layer `groupLayerId` shows. This is
 *  `applyGroupsCreate`'s body with the destination SUPPLIED rather than minted,
 *  and it is a separate op so that the four `CrossCompositionMove` /
 *  `CrossCompositionSet` refusals stay untouched: a move never crosses
 *  composition, and crossing has one name. It is the mutation ADR 0053
 *  decision 8 reserves — the decision that keeps a drag between two timeline
 *  Panels refused says in the same breath that the gap it leaves is filled by
 *  an op of its own, reached by pointing at the Group you mean.
 *
 *  The Group LAYER names the destination, not the composition id — it is what
 *  the user pointed at, and it fixes which placement the offset is measured
 *  from. Members land at `t − group.t_start_us + group.src_in_us`, so they keep
 *  the screen position they had: a clip visible under the Group clip stays
 *  where it looked, and one outside its window arrives outside it, which is
 *  overhang and tolerated in state (ADR 0052 §6). Chosen over landing the set at
 *  the destination's playhead because this is a structural regrouping, not a
 *  paste, and a regrouping that moves pictures is a surprise.
 *
 *  The Group layer is never written — not its `src_out_us`, not its `t_end_us`,
 *  not its lane. Duration autofit is per composition (docs/features.md
 *  § Groups), so a destination that grows changes the OVERHANG of every Group
 *  clip that shows it, the pointed-at one included, and retrims none of them.
 *
 *  Links and transitions follow the set (`moveLinksAndTransitions`); keyframes
 *  are layer-local, so the whole-layer shift leaves them alone. Emptied source
 *  lanes are pruned and BOTH compositions autofit. Every refusal below is
 *  decided before the first write, so a refused op leaves the project
 *  byte-identical and burns no id. */
export function applyGroupsAddMembers(p: Project, idGen: IdGen, layerIds: readonly Uuid[], groupLayerId: Uuid): void {
  const ids = [...new Set(layerIds)]
  const parent = requireSameComposition(p, ids) // InvalidArgument (empty) / LayerNotFound / CrossCompositionSet
  const ref = requireLayer(p, groupLayerId)
  // The set and the Group clip must be siblings, or "move into the Group I can
  // see" stops being what the op means: a Group layer in another composition
  // names a destination the caller is not looking at, and its placement — which
  // is what the landing offset is measured from — is in another time base.
  if (ref.comp !== parent)
    throw new CommandFailure({ error: 'CrossCompositionSet', layer: groupLayerId, composition: ref.comp.id, expected: parent.id })
  const gp = ref.layer.params
  if (gp.kind !== 'CompositionRef') throw new CommandFailure({ error: 'WrongLayerKind', layer: groupLayerId, expected: 'CompositionRef' })
  // Nothing may contain the timeline export renders. A `CompositionRef` at the
  // root is already `RootReferenced`, so this is that wall said at the gesture.
  const dest = compositionOf(p, gp.composition)
  if (dest.id === p.root_id) throw new CommandFailure({ error: 'RootComposition', composition: dest.id })

  const located = ids.map((id) => locateLayerIn(parent, id)!) // requireSameComposition located each
  // Locks before any id is minted or layer moved, for pre-compose's reason
  // above. The Group layer's OWN lock is not consulted: this op never writes it,
  // and a lock protects a layer from being edited, not the composition it
  // happens to point at — the same reason an edit INSIDE a Group is not refused
  // by a locked Group clip in the parent.
  for (const m of located) {
    if (m.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: m.track.id })
    if (m.layer.locked) throw new CommandFailure({ error: 'GroupLockedMember', layer: m.layer.id })
  }
  // A member that is itself a Group whose composition already reaches `dest` —
  // `dest` included — would make the destination contain itself. The same
  // question `applyAddGroupLayer` asks, so the same walk answers it, and the
  // degenerate "the Group layer is in its own member list" falls out for free:
  // its composition IS `dest`, and a composition always reaches itself.
  for (const m of located) {
    if (m.layer.params.kind !== 'CompositionRef') continue
    const reached = compositionRefPath(p, m.layer.params.composition, dest.id)
    if (reached !== null)
      throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'CompositionCycle', path: [dest.id, ...reached] } })
  }

  // `src_in − t_start` is the parent-to-destination time map. Both endpoints
  // re-snap on the layer's OWN grid: the delta between two canonical times is
  // not itself canonical at a fractional rate, which is why pre-compose re-snaps
  // after its `-t0` too.
  const offset = gp.src_in_us - ref.layer.t_start_us
  // The landing can be NEGATIVE — the Group clip starts after a member, or its
  // window is trimmed in — and composition time has no negative half
  // (`NegativeLayerStart`). A move CLAMPS its set to 0; doing that here would
  // slide the whole set off the picture it was placed against, so this refuses
  // instead and names the earliest parent time that lands on 0.
  const landing = new Map<Uuid, { t0: number; t1: number }>()
  for (const m of located) {
    const grid = gridForLayerKind(m.layer.params.kind, dest.fps)
    const t0 = snapOnGrid(m.layer.t_start_us + offset, grid)
    if (t0 < 0)
      throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids',
        detail: `layer ${m.layer.id} would land at ${t0} µs inside composition ${dest.id}, before its start; move it to ${ref.layer.t_start_us - gp.src_in_us} µs or later first` })
    landing.set(m.layer.id, { t0, t1: snapOnGrid(m.layer.t_end_us + offset, grid) })
  }

  // Lanes map per SOURCE TRACK, not per member. Members of one source track
  // never overlap each other except by an authorized transition overlap, so
  // moving a track's whole block onto ONE destination lane preserves their
  // mutual geometry exactly — and that is what lets a transition between two
  // moved members survive. Per-member placement could bounce one of a
  // transition's two participants elsewhere, and `reconcileTransitions`, which
  // runs project-wide inside every commit, would then silently drop it.
  //
  // The k-th source track bottom-up (P's index order IS z order, read before any
  // splice) prefers the destination's k-th lane — pre-compose's A roll / B roll
  // / fresh mapping, read off `dest` instead of a fresh skeleton. The lane ids
  // are snapshotted first, so a lane this op spawns is never also a preference,
  // and blocks are placed one at a time, so a later block's free-lane search
  // sees the earlier placements.
  const existingLanes = dest.tracks.map((t) => t.id)
  const formerTrackIds = [...new Set(located.map((m) => m.trackIndex))].sort((a, b) => a - b).map((i) => parent.tracks[i].id)
  formerTrackIds.forEach((formerId, k) => {
    const block = located.filter((m) => m.track.id === formerId)
    const spans = block.map((m) => landing.get(m.layer.id)!)
    const preferred = k < existingLanes.length ? dest.tracks.find((t) => t.id === existingLanes[k])! : null
    // A locked lane must not RECEIVE content any more than it may lose it
    // (`pickFreeOverlayTrack`'s rule). The collision test is per overlap class:
    // validate keeps a separate visual and audio chain on a lane, so picture and
    // audio coexist there and a cross-class "collision" is not one.
    const clear = preferred !== null && !preferred.locked && !block.some((m, i) =>
      preferred.layers.some((l) => layerOverlapClass(l.params) === layerOverlapClass(m.layer.params)
        && spans[i].t0 < l.t_end_us && l.t_start_us < spans[i].t1))
    const laneId = preferred !== null && clear
      ? preferred.id
      : pickFreeOverlayTrack(dest, Math.min(...spans.map((s) => s.t0)), Math.max(...spans.map((s) => s.t1)))
        ?? applyAddTrack(p, idGen, null, undefined, dest.id)
    const lane = dest.tracks.find((t) => t.id === laneId)!
    for (const m of block) {
      // Re-locate: the splices shift `layerIndex` (helpers.ts LocatedLayer).
      const loc = locateLayerIn(parent, m.layer.id)!
      const layer = loc.track.layers.splice(loc.layerIndex, 1)[0]
      const span = landing.get(m.layer.id)!
      layer.t_start_us = span.t0
      layer.t_end_us = span.t1
      insertSorted(lane, layer)
    }
  })

  moveLinksAndTransitions(parent, dest, new Set(ids))
  for (const formerId of formerTrackIds) pruneEmptiedTrack(parent, formerId)
  applyDurationAutofit(parent)
  applyDurationAutofit(dest)
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
