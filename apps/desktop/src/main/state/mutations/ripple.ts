// apps/desktop/src/main/state/mutations/ripple.ts
//
// Ripple delete: remove a set of layers AND close the span they vacated, so
// everything after it moves left and the composition gets shorter.
//
// Owns the EDIT and nothing else — the deletes, the sweep that re-times every
// downstream layer, and the one duration autofit that follows. The arithmetic
// and all four refusals belong to `renderer/ripple/plan.ts`, which the renderer
// runs against its own mirror to grey the row in advance; commit's reconcile
// slot owns dropping a deleted participant's transition and a deleted anchor's
// markers, so neither is repeated here.
//
// ADR 0062.
import type { Composition, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { planRipple, planRippleGap, type RippleMove, type RippleView } from '../../../renderer/ripple/plan'
import { applyDeleteLayer } from './delete'
import { applyDurationAutofit, insertSorted, locateLayerIn, requireSameComposition, requireTrack } from './helpers'
import { frameGrid, gridIndex, timeUsAtGridIndex } from '../snap'

/** What the ripple touched: the layers it removed, the ones it re-timed, and the
 *  lanes emptying left behind. The actor names all three in its history refs. */
export interface RippleDeleteResult { deleted: Uuid[]; moved: Uuid[]; prunedTracks: Uuid[] }

/** What closing a gap touched: the lane it sat on and the layers the closing
 *  re-timed. Nothing is deleted and no lane can empty. */
export interface RippleGapResult { track: Uuid; moved: Uuid[] }

/** The actor's `Composition` as the planner's structural view. The planner
 *  learns neither side's layer model (the renderer mirror adapts through the
 *  twin of this mapper), so the adaptation is one screen and lives here. */
export function rippleViewOfComposition(c: Composition): RippleView {
  return {
    fps: c.fps,
    tracks: c.tracks.map((t) => ({
      id: t.id,
      locked: t.locked,
      layers: t.layers.map((l) => ({
        id: l.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us, locked: l.locked, kind: l.params.kind,
      })),
    })),
    links: c.links.map((g) => ({ id: g.id, members: g.members })),
    transitions: c.transitions.map((tr) => ({ from_layer: tr.from_layer, to_layer: tr.to_layer, duration_us: tr.duration_us })),
  }
}

/**
 * Delete `ids` and close what they vacated, across every track of their one
 * composition.
 *
 * The plan is computed FIRST, off untouched state, and a refusal is thrown
 * before a single layer is spliced — so a refused ripple leaves the draft
 * byte-identical and the commit records nothing. `requireSameComposition` owns
 * the empty set, the unknown id and the cross-composition set; the planner owns
 * the four ripple refusals.
 */
export function applyRippleDeleteLayers(p: Project, ids: readonly Uuid[]): RippleDeleteResult {
  const c = requireSameComposition(p, ids) // InvalidArgument / LayerNotFound / CrossCompositionSet
  const deleted = [...new Set(ids)]
  const plan = planRipple(rippleViewOfComposition(c), deleted)
  if (!plan.ok) throw new CommandFailure(plan.refusal)

  // Each delete runs its own TrackLocked guard, drops the layer from its link,
  // prunes the lane it emptied and autofits — nothing of that is repeated below.
  const prunedTracks: Uuid[] = []
  for (const id of deleted) {
    const pruned = applyDeleteLayer(p, id)
    if (pruned !== null) prunedTracks.push(pruned)
  }

  const moved = applySweep(c, plan.moves)
  return { deleted, moved, prunedTracks }
}

/**
 * Close the gap `[s, e)` on `trackId`: every layer of its composition that starts
 * at or after `e` moves left by `e - s`, on every track, and nothing is deleted
 * (ADR 0069). The plan is computed FIRST, off untouched state, and a refusal is
 * thrown before a single layer is re-timed — `GapNotFound` when the span is not
 * a gap as the actor sees it (the renderer's mirror can lag), and the ripple's
 * own four when the closing would not be clean.
 */
export function applyRippleDeleteGap(p: Project, trackId: Uuid, s: number, e: number): RippleGapResult {
  const { comp: c } = requireTrack(p, trackId) // TrackNotFound
  const plan = planRippleGap(rippleViewOfComposition(c), { track: trackId, s, e })
  if (!plan.ok) throw new CommandFailure(plan.refusal)
  return { track: trackId, moved: applySweep(c, plan.moves) }
}

/**
 * The sweep: write every landing, keep a travelling transition's frame count,
 * and autofit once. Shared by the deletion and the gap closing — what differs
 * between them is how the holes were found, and that is the planner's business.
 */
function applySweep(c: Composition, plannedMoves: readonly RippleMove[]): Uuid[] {
  // Moves are keyed by LAYER id and re-located one at a time, never by the track
  // index the plan carries: a delete above may have pruned a whole lane out of
  // the vector. Both endpoints come from the plan — a landing plus the old
  // length would be off-lattice at fractional rates — and the zero floor is the
  // planner's assert, not a clamp here.
  // A transition whose BOTH participants move keeps its geometry but not
  // necessarily its numbers: a duration is the distance between two lattice
  // points, and at a fractional rate that distance depends on where the pair
  // sits (one frame at 30 fps is 33 333 µs or 33 334 µs by position). The
  // planner authorized this pair on the overlap it LANDS with, so the stored
  // duration has to follow the landing or reconcile drops the transition for a
  // rounding artefact. `extended_us` is the same kind of number — the borrowed
  // tail is a whole count of frames past the hard cut — so it is re-measured
  // as that count at the new position, NOT shifted by the duration's change:
  // a pure-placement overlap (nothing borrowed) must still read 0 afterwards,
  // or removing the transition later would shrink the outgoing layer by a
  // phantom microsecond and put its end off the grid. The count is read off
  // the OLD geometry, before the sweep moves anything.
  //
  // No delta check: the planner refuses a pair whose participants moved by
  // different amounts, so both-moved already means uniformly moved. Both
  // participants are visual (validate's rule), hence the composition frame grid.
  const movedSet = new Set(plannedMoves.map((m) => m.layer))
  const grid = frameGrid(c.fps)
  const borrowedFrames = new Map<Uuid, number>()
  for (const tr of c.transitions) {
    if (!movedSet.has(tr.from_layer) || !movedSet.has(tr.to_layer)) continue
    const fromEnd = locateLayerIn(c, tr.from_layer)!.layer.t_end_us
    borrowedFrames.set(tr.id, gridIndex(fromEnd, grid) - gridIndex(fromEnd - tr.extended_us, grid))
  }

  const moved: Uuid[] = []
  for (const move of plannedMoves) {
    const loc = locateLayerIn(c, move.layer)! // a mover is a REMAINING layer, and only `deleted` was removed
    const layer = loc.track.layers.splice(loc.layerIndex, 1)[0]
    layer.t_start_us = move.t_start_us
    layer.t_end_us = move.t_end_us
    insertSorted(loc.track, layer)
    moved.push(move.layer)
  }

  for (const tr of c.transitions) {
    const frames = borrowedFrames.get(tr.id)
    if (frames === undefined) continue
    const from = locateLayerIn(c, tr.from_layer)!.layer
    const to = locateLayerIn(c, tr.to_layer)!.layer
    tr.duration_us = from.t_end_us - to.t_start_us
    tr.extended_us = from.t_end_us - timeUsAtGridIndex(gridIndex(from.t_end_us, grid) - frames, grid)
  }

  // The sweep lowered the high-water mark; each delete's own autofit ran before
  // it (ADR 0005 — a pinned composition keeps its length either way).
  applyDurationAutofit(c)
  return moved
}
