// apps/desktop/src/main/state/mutations/moveToComposition.ts
// The crossing primitive: one set of layers, one destination composition, one
// landing time. Callers name that time and own the refusals that are about
// THEM — `applyGroupsAddMembers` reads it off a Group clip's placement. The two
// crossings that also MINT or DISSOLVE a composition around the set, pre-compose
// and ungroup, stay in `groups.ts`. See ADR 0052 § Group semantics.
import type { Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { layerOverlapClass } from '../validate'
import { applyAddTrack, compositionRefPath } from './add'
import {
  applyDurationAutofit, compositionOf, insertSorted, locateLayerIn, moveLinksAndTransitions,
  pickFreeOverlayTrack, pruneEmptiedTrack, requireSameComposition,
} from './helpers'

/** Move `layerIds` — one or more layers of ONE composition — into
 *  `destCompositionId`, landing `anchorLayerId` at `anchorTStartUs` while every
 *  other member keeps its phase relative to that anchor. Preserving the set's
 *  mutual geometry is what lets a transition between two moved members survive.
 *
 *  The landing is ABSOLUTE rather than a delta, homomorphic with
 *  `applyMoveLayer`, because an absolute time is only safe to compute where the
 *  value it derives from is current. A caller in the renderer reads the pointer,
 *  which always is; a `t_start_us` read from the renderer's project mirror lags
 *  two round trips, so a `base + delta` computed there would eat the previous
 *  commit. Every caller resolves its own number and hands over one.
 *
 *  Both endpoints of every member re-snap on that member's OWN grid at the
 *  DESTINATION's rate: the delta between two canonical times is not itself
 *  canonical at a fractional rate. Two compositions at different rates therefore
 *  do not round trip — A → B → A need not return a layer to the microsecond it
 *  left (ADR 0037, ADR 0038). Keyframes are layer-local, so the whole-layer
 *  shift leaves them alone.
 *
 *  Destination lanes are assigned per SOURCE TRACK, never per member. Members of
 *  one source track never overlap each other except by an authorized transition
 *  overlap, so moving a track's whole block onto ONE lane preserves their mutual
 *  geometry exactly. Per-member placement could bounce one of a transition's two
 *  participants elsewhere, and `reconcileTransitions`, which runs project-wide
 *  inside every commit, would then silently drop it.
 *
 *  `destTrackId` picks which lane a block lands on:
 *
 *  - `null` — no opinion. The k-th source track bottom-up prefers the
 *    destination's k-th lane, else bounces to `pickFreeOverlayTrack`, else
 *    spawns one. A menu has no ghost, so bouncing is honest for it.
 *  - a lane id — every block lands there, and a locked or occupied lane is
 *    refused instead of bounced. A drag HAS a ghost, so a bounce would make the
 *    ghost a lie. Naming a lane does not make placement per-member: the blocks
 *    stay blocks and simply share one lane.
 *  - `'spawn'` — one fresh lane at the top of the destination's z-stack, which
 *    is where the destination's drop strip puts content.
 *
 *  Links and transitions follow the set, markers do not
 *  (`moveLinksAndTransitions`). Emptied source lanes are pruned and BOTH
 *  compositions autofit.
 *
 *  Every refusal is decided before the first write, so a refused move leaves the
 *  project byte-identical and burns no id: an empty set, an `anchorLayerId`
 *  outside it, a destination that is the source composition, or a member landing
 *  before composition time 0 → `InvalidArgument` (composition time has no
 *  negative half, and a move CLAMPS its set to 0, which here would slide the
 *  whole set off the picture it was placed against); a member id that names no
 *  layer → `LayerNotFound`; a set spanning two compositions →
 *  `CrossCompositionSet`; an unknown destination → `CompositionNotFound`; a
 *  named lane that is not one of the destination's → `TrackNotFound`; a locked
 *  source lane or a locked named lane → `TrackLocked`; a locked member →
 *  `GroupLockedMember` (the name is Group-flavoured, the rule is not); a member
 *  that is itself a Group whose composition already reaches the destination →
 *  `CompositionCycle`; a named lane already holding same-class content at the
 *  landing times → `LayerOverlap`.
 *
 *  LANDMINE: the root is an ORDINARY destination here. `RootComposition` guards
 *  a `CompositionRef` that would point at the root, so it belongs to the callers
 *  that hold one; copying it down would refuse the move out of a Group and back
 *  into the film, which is half of what this op exists for. */
export function applyMoveLayersToComposition(
  p: Project,
  idGen: IdGen,
  layerIds: readonly Uuid[],
  destCompositionId: Uuid,
  anchorLayerId: Uuid,
  anchorTStartUs: number,
  destTrackId: Uuid | 'spawn' | null,
): void {
  const ids = [...new Set(layerIds)]
  const parent = requireSameComposition(p, ids) // InvalidArgument (empty) / LayerNotFound / CrossCompositionSet
  if (!ids.includes(anchorLayerId))
    throw new CommandFailure({ error: 'InvalidArgument', field: 'anchor_layer_id',
      detail: `layer ${anchorLayerId} is not in the moving set, so there is nothing for ${anchorTStartUs} µs to position` })
  const dest = compositionOf(p, destCompositionId)
  // This op crosses; a landing inside the composition the set is already in is
  // `applyMoveLayer`'s, which re-lanes one layer without touching links.
  // LANDMINE: `moveLinksAndTransitions` splices `from` while pushing to `to`, so
  // handing it one composition twice never terminates — the guard is what keeps
  // that unreachable, not an accident of who calls this.
  if (dest === parent)
    throw new CommandFailure({ error: 'InvalidArgument', field: 'to_composition_id',
      detail: `the set is already in composition ${dest.id}; move within a composition with move_layer` })

  const located = ids.map((id) => locateLayerIn(parent, id)!) // requireSameComposition located each
  // Never partial: taking the unlocked half of a selection would leave a split
  // set the user did not ask for and a refusal they cannot act on.
  for (const m of located) {
    if (m.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: m.track.id })
    if (m.layer.locked) throw new CommandFailure({ error: 'GroupLockedMember', layer: m.layer.id })
  }
  // A member that is itself a Group whose composition already reaches `dest` —
  // `dest` included — would make the destination contain itself. The same
  // question `applyAddGroupLayer` asks, so the same walk answers it, and the
  // degenerate "a Group clip is asked to move into the composition it shows"
  // falls out for free: its composition IS `dest`, and a composition always
  // reaches itself.
  for (const m of located) {
    if (m.layer.params.kind !== 'CompositionRef') continue
    const reached = compositionRefPath(p, m.layer.params.composition, dest.id)
    if (reached !== null)
      throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'CompositionCycle', path: [dest.id, ...reached] } })
  }

  const anchor = located.find((m) => m.layer.id === anchorLayerId)!
  const offset = anchorTStartUs - anchor.layer.t_start_us
  const landing = new Map<Uuid, { t0: number; t1: number }>()
  for (const m of located) {
    const grid = gridForLayerKind(m.layer.params.kind, dest.fps)
    const t0 = snapOnGrid(m.layer.t_start_us + offset, grid)
    if (t0 < 0)
      throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids',
        detail: `layer ${m.layer.id} would land at ${t0} µs in composition ${dest.id}, before its start; anchor the set at ${anchor.layer.t_start_us - m.layer.t_start_us} µs or later` })
    landing.set(m.layer.id, { t0, t1: snapOnGrid(m.layer.t_end_us + offset, grid) })
  }

  // A named lane is vetted here, with the rest of the refusals, so that it too
  // decides before the first write. The two tests are the ones the preference
  // walk below applies as well: a locked lane must not RECEIVE content any more
  // than it may lose it (`pickFreeOverlayTrack`'s rule), and collision is per
  // overlap class, because validate keeps a separate visual and audio chain on a
  // lane — picture and audio coexist there, so a cross-class "collision" is not
  // one.
  if (destTrackId !== null && destTrackId !== 'spawn') {
    const lane = dest.tracks.find((t) => t.id === destTrackId)
    if (!lane) throw new CommandFailure({ error: 'TrackNotFound', track: destTrackId })
    if (lane.locked) throw new CommandFailure({ error: 'TrackLocked', track: lane.id })
    for (const m of located) {
      const span = landing.get(m.layer.id)!
      const cls = layerOverlapClass(m.layer.params)
      const hit = lane.layers.find((l) => layerOverlapClass(l.params) === cls && span.t0 < l.t_end_us && l.t_start_us < span.t1)
      if (hit)
        throw new CommandFailure({ error: 'ValidationFailed', detail: {
          rule: 'LayerOverlap', track: lane.id,
          a: hit.id, a_start: hit.t_start_us, a_end: hit.t_end_us,
          b: m.layer.id, b_start: span.t0, b_end: span.t1,
        } })
    }
  }

  // The source composition's index order IS z order, read before any splice.
  const formerTrackIds = [...new Set(located.map((m) => m.trackIndex))].sort((a, b) => a - b).map((i) => parent.tracks[i].id)
  // Snapshotted before a lane can be spawned, so a lane this op mints is never
  // also a preference.
  const existingLanes = dest.tracks.map((t) => t.id)
  const fixedLane: Uuid | null = destTrackId === 'spawn' ? applyAddTrack(p, idGen, null, undefined, dest.id) : destTrackId
  formerTrackIds.forEach((formerId, k) => {
    const block = located.filter((m) => m.track.id === formerId)
    const spans = block.map((m) => landing.get(m.layer.id)!)
    let laneId = fixedLane
    if (laneId === null) {
      // The destination's k-th lane read off `dest` — pre-compose's A roll /
      // B roll / fresh mapping against an existing skeleton instead of a minted
      // one. Blocks are placed one at a time, so a later block's free-lane
      // search sees the earlier placements.
      const preferred = k < existingLanes.length ? dest.tracks.find((t) => t.id === existingLanes[k])! : null
      const clear = preferred !== null && !preferred.locked && !block.some((m, i) =>
        preferred.layers.some((l) => layerOverlapClass(l.params) === layerOverlapClass(m.layer.params)
          && spans[i].t0 < l.t_end_us && l.t_start_us < spans[i].t1))
      laneId = preferred !== null && clear
        ? preferred.id
        : pickFreeOverlayTrack(dest, Math.min(...spans.map((s) => s.t0)), Math.max(...spans.map((s) => s.t1)))
          ?? applyAddTrack(p, idGen, null, undefined, dest.id)
    }
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
