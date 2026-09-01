// apps/desktop/src/main/state/mutations/move.ts
import type { Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { floorShiftAtZero, gridForLayerKind, shiftOnGrids, snapOnGrid, type ShiftMember } from '../snap'
import { applyAddTrack } from './add'
import { applyDurationAutofit, checkTrackLock, locateLayerIn, locateTrack, pruneEmptiedTrack, requireLayer, requireSameComposition } from './helpers'
import { linkSiblingsExcluding, checkLinkLock } from './links'
import { CommandFailure } from '../errors'

/** Move one layer (and its link siblings) within its composition. The target
 *  track names a composition too, and it must be the layer's own: a track in
 *  another composition is refused (CrossCompositionMove) — a move never
 *  crosses, and crossing has its own op (`moveToComposition.ts`, which
 *  pre-compose, add-to-Group and ungroup stand beside). */
export function applyMoveLayer(p: Project, id: Uuid, newTrackId: Uuid, newTStartUs: number, escapeLink: boolean): void {
  const src = requireLayer(p, id)
  const c = src.comp
  const fps = c.fps
  // Read the source track's ID, not its index: the splices below shift indices,
  // and pruning has to name the lane the layer LEFT once the move has settled.
  const srcTrackId = src.track.id
  const target = src.layer
  // The requested start snaps on the TARGET's own grid — the audio lattice for an
  // Audio layer, the composition frame grid otherwise (spec R2-D6).
  const targetGrid = gridForLayerKind(target.params.kind, fps)
  const snapped = snapOnGrid(newTStartUs, targetGrid)
  const curStart = target.t_start_us
  if (src.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: srcTrackId })
  const dst = locateTrack(p, newTrackId)
  if (!dst) throw new CommandFailure({ error: 'TrackNotFound', track: newTrackId })
  if (dst.comp !== c) throw new CommandFailure({ error: 'CrossCompositionMove', layer: id, from: c.id, to: dst.comp.id })
  if (newTrackId !== srcTrackId && dst.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: newTrackId })
  const siblings = escapeLink ? [] : linkSiblingsExcluding(c, id)
  // Reject up-front if any member (incl. target) is locked / on a locked track.
  // Only fires for a coupled move with real siblings.
  if (!escapeLink && siblings.length > 0) checkLinkLock(c, id, [id, ...siblings])

  // ── Where the set lands ─────────────────────────────────────────────────────
  // Both halves are `renderer/grid.ts`'s, because the timeline has to promise
  // this answer before the command gives it: the delta is CLAMPED rather than each
  // member's start, so a set dragged toward zero stops as a set, and every member
  // then snaps both endpoints on its own lattice. `NegativeLayerStart` validation
  // is the structural half of the floor — a negative start is otherwise perfectly
  // canonical, so the grid backstop alone would wave it through.
  //
  // The moving SET, target first, read BEFORE the splices below — one list, so
  // the zero floor and the landing cannot disagree about who is in it. A sibling
  // that cannot be located is skipped, matching the fan-out loop's own tolerance
  // for a stale member id.
  const movers: ShiftMember[] = [target, ...siblings.map((sid) => locateLayerIn(c, sid)?.layer).filter((l) => l !== undefined)]
    .map((l) => ({ id: l.id, kind: l.params.kind, tStartUs: l.t_start_us, tEndUs: l.t_end_us }))
  const delta = floorShiftAtZero(movers, snapped - curStart)
  // One arithmetic for every site that has to agree about where this set lands —
  // the two mutations that decide it and the two timeline surfaces that draw it
  // in advance (`renderer/grid.ts`). Both endpoints, each member's own lattice.
  const landings = shiftOnGrids(movers, delta, fps)
  const targetLanding = landings.get(id)!
  const newStart = targetLanding.tStartUs

  // Remove the target layer.
  const layer = src.track.layers.splice(src.layerIndex, 1)[0]
  layer.t_start_us = newStart
  layer.t_end_us = targetLanding.tEndUs
  const dest = dst.track
  const at = dest.layers.findIndex((l) => l.t_start_us > newStart)
  dest.layers.splice(at < 0 ? dest.layers.length : at, 0, layer)

  // Link siblings follow + shift by the same delta.
  if (!escapeLink) {
    for (const sid of siblings) {
      const loc = locateLayerIn(c, sid)
      if (!loc) continue
      const siblingTrack = loc.track
      const s = siblingTrack.layers.splice(loc.layerIndex, 1)[0]
      if (delta !== 0) {
        // Each sibling lands on ITS OWN lattice, which `shiftOnGrids` owns and
        // documents: snapping a linked audio member on the composition frame grid
        // would drag it to the nearest video frame on any unrelated whole-link move
        // and silently spend the user's deliberately slipped sync offset (R2-D7 —
        // the offset is geometry and nothing else).
        const landed = landings.get(sid)!
        s.t_start_us = landed.tStartUs
        s.t_end_us = landed.tEndUs
      }
      // No per-sibling floor here: `delta` is already clamped so no member can cross
      // 0, and snapping a non-negative time can only return a non-negative lattice
      // point. Re-introducing one would resurrect the shortening defect.
      const sAt = siblingTrack.layers.findIndex((l) => l.t_start_us > s.t_start_us)
      siblingTrack.layers.splice(sAt < 0 ? siblingTrack.layers.length : sAt, 0, s)
    }
  }

  applyDurationAutofit(c)
  // Cleanup rides in the SAME mutation, so one undo restores the layer's previous
  // position and its track together. Runs last, on settled state: a same-track move
  // has already put the layer back. Only the target changes tracks — every sibling
  // is re-inserted on the one it came from — so this is the only track a move empties.
  pruneEmptiedTrack(c, srcTrackId)
}

/** Raise a set of layers onto ONE fresh lane at the tail of the track vector —
 *  the top of the z-stack, which is the only spawn point (ADR 0042 decision 2).
 *  Returns the new track's id.
 *
 *  Lives beside `applyMoveLayer` because it is a lane change and nothing else:
 *  the new lane is the destination, not the subject. Z-order is rearranged by
 *  repeating this, and every repetition has to clean up after itself, which is
 *  the rule this file already owns.
 *
 *  `anchor` decides whether the raise is also a MOVE, and it is the whole of the
 *  difference between this op's two entry points:
 *
 *  - `null` — no opinion. Every layer keeps its `t_start_us` / `t_end_us`
 *    verbatim, with no re-snap: an endpoint grid follows the layer's KIND, not
 *    its track, so times that were canonical stay canonical, and a set the
 *    caller never retimed must not drift on the way up. `applyDurationAutofit`
 *    is skipped for the same reason — nothing is added, removed or retimed, so
 *    `max(t_end_us)` cannot move, and running it would fold unrelated duration
 *    drift into this entry. This is the *Move to a new track* command's shape: a
 *    menu has no ghost, so it may not silently name a time the user did not see.
 *  - `{ layerId, tStartUs }` — the drag's landing. `layerId` lands on
 *    `tStartUs`, every other member holds its phase to it, and the whole set
 *    then re-snaps on each member's own lattice. Homomorphic with
 *    `applyMoveLayer` (an ABSOLUTE time, floored as a body at 0) rather than
 *    with `applyMoveLayersToComposition` (absolute, but REFUSED before 0): both
 *    of those are the rule for a move that stays inside one composition, which
 *    is what a raise is. The drop strip resolves the number from the pointer,
 *    which is the only value current enough to compute an absolute time from.
 *
 *  Two same-class layers landing on top of each other is left to `validate`
 *  (`LayerOverlap`), which runs after this inside `commit`. The command's
 *  `enabled` predicate prevents that request up front; re-checking it here would
 *  give one rule two homes to drift between. A landing cannot introduce one the
 *  verbatim raise would not have had: the shift is uniform, so members that did
 *  not overlap before still do not.
 *
 *  Link membership is untouched: `c.links` names layer ids and no invariant
 *  ties a link to a track, so the caller's explicit selection moves and nothing
 *  is dragged along — unlike `applyMoveLayer`, which fans a time delta out to
 *  siblings the caller did not name. The set is one composition's
 *  (CrossCompositionSet otherwise): the lane is minted there. */
export function applyMoveLayersToNewTrack(
  p: Project,
  idGen: IdGen,
  layerIds: readonly Uuid[],
  anchor: { layerId: Uuid; tStartUs: number } | null = null,
): Uuid {
  const ids = [...new Set(layerIds)]
  if (ids.length === 0) throw new CommandFailure({ error: 'InvalidArgument', field: 'layers', detail: 'at least one layer is required' })
  const c = requireSameComposition(p, ids)
  if (anchor !== null && !ids.includes(anchor.layerId))
    throw new CommandFailure({ error: 'InvalidArgument', field: 'anchor_layer_id',
      detail: `layer ${anchor.layerId} is not in the raised set, so there is nothing for ${anchor.tStartUs} µs to position` })
  // Locate and lock-check EVERY layer before the lane is minted, so a refusal
  // burns no id. The distinct source ids are read here, while the layers are
  // still on them: pruning needs the lanes they LEFT, and one raise can empty
  // several of them.
  const sourceTrackIds: Uuid[] = []
  for (const id of ids) {
    const { track } = checkTrackLock(p, id) // LayerNotFound, then TrackLocked
    if (!sourceTrackIds.includes(track.id)) sourceTrackIds.push(track.id)
  }

  // ── Where the set lands ─────────────────────────────────────────────────────
  // `applyMoveLayer`'s two steps, from the module both sides share
  // (`renderer/grid.ts`), so the drop strip's ghost and this landing are the
  // same numbers rather than two roundings of one intention. Empty for a
  // verbatim raise, which is what keeps "no opinion means no re-snap" a fact
  // about the code rather than a promise in a comment.
  const landings = anchor === null ? null : (() => {
    const movers: ShiftMember[] = ids
      .map((id) => locateLayerIn(c, id)!.layer) // located by the lock walk above
      .map((l) => ({ id: l.id, kind: l.params.kind, tStartUs: l.t_start_us, tEndUs: l.t_end_us }))
    const seed = locateLayerIn(c, anchor.layerId)!.layer
    // The requested start snaps on the ANCHOR's own grid first, then the delta
    // it implies carries the set — the same order `applyMoveLayer` uses, and the
    // reason a set dragged toward zero stops as one body instead of flattening
    // its phase against the boundary.
    const snapped = snapOnGrid(anchor.tStartUs, gridForLayerKind(seed.params.kind, c.fps))
    return shiftOnGrids(movers, floorShiftAtZero(movers, snapped - seed.t_start_us), c.fps)
  })()

  // `label: null` lets the renderer derive the name — a literal written here
  // could never be localized (ADR 0042).
  const trackId = applyAddTrack(p, idGen, null, undefined, c.id)
  const dest = c.tracks.find((t) => t.id === trackId)! // just inserted
  for (const id of ids) {
    const loc = locateLayerIn(c, id)! // verified above, and nothing has removed it
    const layer = loc.track.layers.splice(loc.layerIndex, 1)[0]
    const landed = landings?.get(id)
    if (landed) {
      layer.t_start_us = landed.tStartUs
      layer.t_end_us = landed.tEndUs
    }
    const at = dest.layers.findIndex((l) => l.t_start_us > layer.t_start_us)
    dest.layers.splice(at < 0 ? dest.layers.length : at, 0, layer)
  }
  // Once per DISTINCT source lane, on settled state: a multi-clip raise off two
  // lanes has to take both with it, in this same history entry.
  for (const srcTrackId of sourceTrackIds) pruneEmptiedTrack(c, srcTrackId)
  // Only when this call actually retimed something — see the `anchor` contract.
  if (landings !== null) applyDurationAutofit(c)
  return trackId
}
