// apps/desktop/src/main/state/mutations/move.ts
import type { Composition, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { applyAddTrack } from './add'
import { applyDurationAutofit, checkTrackLock, locateLayerIn, locateTrack, pruneEmptiedTrack, requireLayer, requireSameComposition } from './helpers'
import { linkSiblingsExcluding, checkLinkLock } from './links'
import { CommandFailure } from '../errors'

/** Earliest `t_start_us` across the whole moving set (target + link siblings) —
 *  the member that decides where the set stops when it is dragged toward zero.
 *  Read BEFORE the target is spliced out, so `targetStart` is passed in rather than
 *  re-located. A sibling that cannot be located is skipped, matching the move loop's
 *  own tolerance for a stale member id. */
function earliestStart(c: Composition, targetStart: number, siblings: readonly Uuid[]): number {
  let earliest = targetStart
  for (const sid of siblings) {
    const loc = locateLayerIn(c, sid)
    if (!loc) continue
    if (loc.layer.t_start_us < earliest) earliest = loc.layer.t_start_us
  }
  return earliest
}

/** Move one layer (and its link siblings) within its composition. The target
 *  track names a composition too, and it must be the layer's own: a track in
 *  another composition is refused (CrossCompositionMove) — a layer changes
 *  composition only through pre-compose, add-to-Group or ungroup. */
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

  // ── Clamp the DELTA, not each member's start ────────────────────────────────
  // Dragged toward zero, the moving set stops AS A SET: its earliest member lands
  // exactly on 0 and every other member keeps its distance from that member.
  //
  // `NegativeLayerStart` validation is the structural half: a negative start is
  // otherwise perfectly canonical, so the grid backstop alone would wave it through.
  //
  // 0 is a lattice point on every grid, so the earliest member needs no re-snap to
  // stay canonical, and every other member is still `its own start + delta` snapped
  // on its own lattice — which is exactly what keeps a slipped A/V sync offset
  // intact through a whole-link move (R2-D7).
  const delta = Math.max(snapped - curStart, -earliestStart(c, curStart, siblings))
  const newStart = snapOnGrid(curStart + delta, targetGrid)

  // Remove the target layer.
  const layer = src.track.layers.splice(src.layerIndex, 1)[0]
  layer.t_start_us = newStart
  // Re-snap t_end on the same grid (alternating 33_333/33_334µs frame widths at 30fps).
  layer.t_end_us = snapOnGrid(layer.t_end_us + delta, targetGrid)
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
        // LANDMINE: each sibling snaps on ITS OWN grid, not the target's. Snapping a
        // linked audio member on the composition frame grid here would drag it back
        // to the nearest video frame on any unrelated whole-link move, and the user's
        // deliberately slipped sync offset would silently vanish (spec § Two data-loss
        // dependencies, #1). The offset survives precisely because every member shifts
        // by the same `delta` and then lands on its own lattice — which is also how the
        // implicit sync offset is stored at all (R2-D7: no field, just geometry).
        const g = gridForLayerKind(s.params.kind, fps)
        s.t_start_us = snapOnGrid(s.t_start_us + delta, g)
        s.t_end_us = snapOnGrid(s.t_end_us + delta, g)
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
 *  Each layer keeps its `t_start_us` / `t_end_us` verbatim. No re-snap: an
 *  endpoint grid follows the layer's KIND, not its track, so times that were
 *  canonical stay canonical. That is also why `applyDurationAutofit` is NOT
 *  called — nothing is added, removed or retimed, so `max(t_end_us)` cannot
 *  move, and running it would fold unrelated duration drift into this entry.
 *
 *  Two same-class layers landing on top of each other is left to `validate`
 *  (`LayerOverlap`), which runs after this inside `commit`. The command's
 *  `enabled` predicate prevents that request up front; re-checking it here would
 *  give one rule two homes to drift between.
 *
 *  Link membership is untouched: `c.links` names layer ids and no invariant
 *  ties a link to a track, so the caller's explicit selection moves and nothing
 *  is dragged along — unlike `applyMoveLayer`, which has a time delta for
 *  siblings to follow. The set is one composition's (CrossCompositionSet
 *  otherwise): the lane is minted there. */
export function applyMoveLayersToNewTrack(p: Project, idGen: IdGen, layerIds: readonly Uuid[]): Uuid {
  const ids = [...new Set(layerIds)]
  if (ids.length === 0) throw new CommandFailure({ error: 'InvalidArgument', field: 'layers', detail: 'at least one layer is required' })
  const c = requireSameComposition(p, ids)
  // Locate and lock-check EVERY layer before the lane is minted, so a refusal
  // burns no id. The distinct source ids are read here, while the layers are
  // still on them: pruning needs the lanes they LEFT, and one raise can empty
  // several of them.
  const sourceTrackIds: Uuid[] = []
  for (const id of ids) {
    const { track } = checkTrackLock(p, id) // LayerNotFound, then TrackLocked
    if (!sourceTrackIds.includes(track.id)) sourceTrackIds.push(track.id)
  }
  // `label: null` lets the renderer derive the name — a literal written here
  // could never be localized (ADR 0042).
  const trackId = applyAddTrack(p, idGen, null, undefined, c.id)
  const dest = c.tracks.find((t) => t.id === trackId)! // just inserted
  for (const id of ids) {
    const loc = locateLayerIn(c, id)! // verified above, and nothing has removed it
    const layer = loc.track.layers.splice(loc.layerIndex, 1)[0]
    const at = dest.layers.findIndex((l) => l.t_start_us > layer.t_start_us)
    dest.layers.splice(at < 0 ? dest.layers.length : at, 0, layer)
  }
  // Once per DISTINCT source lane, on settled state: a multi-clip raise off two
  // lanes has to take both with it, in this same history entry.
  for (const srcTrackId of sourceTrackIds) pruneEmptiedTrack(c, srcTrackId)
  return trackId
}
