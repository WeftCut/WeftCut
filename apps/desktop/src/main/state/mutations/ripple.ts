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
// docs/features.md#ripple-delete.
import type { Composition, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { planRipple, planRippleGap, type RippleMove, type RippleView } from '../../../renderer/ripple/plan'
import type { IdGen } from '../ids'
import { applyDeleteLayer } from './delete'
import { applyDurationAutofit, insertSorted, locateLayerIn, requireSameComposition, requireTrack } from './helpers'
import { linkSiblingsOverlapping } from './links'
import { applySplitLinked } from './split'
import { frameGrid, gridIndex, snapOnGrid, timeUsAtGridIndex } from '../snap'

/** What the ripple touched: the layers it removed, the ones it re-timed, and the
 *  lanes emptying left behind. The actor names all three in its history refs. */
export interface RippleDeleteResult { deleted: Uuid[]; moved: Uuid[]; prunedTracks: Uuid[] }

/** The part of a clip a cut leaves behind it (`start`) or ahead of it (`end`). */
export type ClipPart = 'start' | 'end'

/** What deleting a part touched: the layers the cut shortened (`kept`), the
 *  layers that existed before it and are gone (`deleted`), what the ripple
 *  re-timed, and where the cut sits once the hole is closed —
 *  the start of what was after it (`start`), or the cut itself, which nothing
 *  moved (`end`). */
export interface RippleDeletePartResult extends RippleDeleteResult { kept: Uuid[]; at_t_us: number }

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
 * Cut every layer in `ids` at `atTUsRaw` and ripple-delete the `part` on the
 * deleted side of the cut, in one edit (docs/features.md#delete-start-or-end).
 *
 * The cut is Split's, link fan-out and partition included, so a linked A/V
 * pair loses the same part of both members; every piece of the deleted side
 * plus the link partners lying inside it (`linkSiblingsOverlapping`) goes to
 * ONE `applyRippleDeleteLayers`, so the holes merge as they would for a ripple
 * delete of the selection. The SURVIVING half of every cut layer keeps its id,
 * so its transitions, anchored markers and selection stay with it; with the id
 * on the deleted half, an outgoing transition would ride the deleted start and
 * leave the survivor overlapping the next clip with nothing authorizing it.
 *
 * A target an earlier target's fan-out already cut is skipped; one the cut
 * does not fall strictly inside is `SplitOutsideLayer`; a cut strictly inside
 * a transition's overlap is `LayerOverlap`, as Split's is. Every refusal throws
 * inside the recipe, so the draft is discarded and nothing records.
 */
export function applyRippleDeletePart(p: Project, idGen: IdGen, ids: readonly Uuid[], atTUsRaw: number, part: ClipPart, escapeLink: boolean): RippleDeletePartResult {
  const c = requireSameComposition(p, ids) // InvalidArgument / LayerNotFound / CrossCompositionSet
  const at = snapOnGrid(atTUsRaw, frameGrid(c.fps))
  const targets = [...new Set(ids)]
  const keep = part === 'start' ? 'right' : 'left'
  const overlaps = transitionOverlaps(c)
  const cut = new Set<Uuid>()
  const pieces: Uuid[] = []
  for (const id of targets) {
    if (cut.has(id)) continue
    for (const halves of applySplitLinked(p, idGen, id, at, escapeLink, keep)) {
      cut.add(keep === 'left' ? halves.left : halves.right)
      pieces.push(keep === 'left' ? halves.right : halves.left)
    }
  }
  refuseCutInsideTransition(overlaps, cut, at)
  const doomed = new Set(pieces)
  for (const piece of pieces) for (const sid of linkSiblingsOverlapping(c, piece)) doomed.add(sid)
  const result = applyRippleDeleteLayers(p, [...doomed])
  const survivor = locateLayerIn(c, targets[0])!.layer
  // The pieces are born and removed inside this edit, so no snapshot holds
  // them and nothing outside it can name them; `deleted` lists only layers
  // that existed before (a linked member that went along).
  const fresh = new Set(pieces)
  return { ...result, deleted: result.deleted.filter((id) => !fresh.has(id)), kept: [...cut], at_t_us: part === 'start' ? survivor.t_start_us : survivor.t_end_us }
}

interface TransitionOverlap { track: Uuid; from: Uuid; fromStart: number; fromEnd: number; to: Uuid; toStart: number; toEnd: number }

/** Every transition's two layers as they stand before the cut: the overlap a
 *  transition plays over is `[toStart, fromEnd]`. */
function transitionOverlaps(c: Composition): TransitionOverlap[] {
  return c.transitions.map((tr) => {
    const from = locateLayerIn(c, tr.from_layer)!
    const to = locateLayerIn(c, tr.to_layer)!.layer
    return { track: from.track.id, from: tr.from_layer, fromStart: from.layer.t_start_us, fromEnd: from.layer.t_end_us, to: tr.to_layer, toStart: to.t_start_us, toEnd: to.t_end_us }
  })
}

/** A cut strictly inside a transition's overlap leaves the transition a
 *  duration its layers no longer overlap by. Split refuses there: commit drops
 *  the transition and the two layers it authorized now overlap. This edit
 *  refuses the same way, before the ripple's sweep re-measures the transition
 *  on the moved pair and keeps it over a sliver of the outgoing clip. A cut at
 *  either end of the overlap leaves the transition whole on one side: it stays
 *  with a kept part or goes with a deleted one. */
function refuseCutInsideTransition(overlaps: readonly TransitionOverlap[], cut: ReadonlySet<Uuid>, at: number): void {
  for (const o of overlaps) {
    if (!(cut.has(o.from) || cut.has(o.to)) || at <= o.toStart || at >= o.fromEnd) continue
    throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'LayerOverlap', track: o.track, a: o.from, a_start: o.fromStart, a_end: o.fromEnd, b: o.to, b_start: o.toStart, b_end: o.toEnd } })
  }
}

/**
 * Close the gap `[s, e)` on `trackId`: every layer of its composition that starts
 * at or after `e` moves left by `e - s`, on every track, and nothing is deleted
 * (docs/features.md#ripple-delete). The plan is computed FIRST, off untouched
 * state, and a refusal is thrown before a single layer is re-timed —
 * `GapNotFound` when the span is not a gap as the actor sees it (the renderer's
 * mirror can lag), and the ripple's own four when the closing would not be
 * clean.
 */
export function applyRippleDeleteGap(p: Project, trackId: Uuid, s: number, e: number): RippleGapResult {
  const { comp: c } = requireTrack(p, trackId) // TrackNotFound
  const plan = planRippleGap(rippleViewOfComposition(c), { track: trackId, s, e })
  if (!plan.ok) throw new CommandFailure(plan.refusal)
  return { track: trackId, moved: applySweep(c, plan.moves) }
}

/**
 * The sweep: write every landing, keep a travelling transition's frame count,
 * and autofit once. Shared by the deletion, the gap closing, `shift_layers`'
 * sweep and the insert move — what differs between them is how the landings
 * were found, and that is the planner's business. Each landed layer stays on
 * its own track.
 */
export function applySweep(c: Composition, plannedMoves: readonly RippleMove[]): Uuid[] {
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
  // different amounts, so both-moved already means uniformly moved. Every
  // layer edge sits on frames (ADR 0038), an audio pair's too, hence the
  // composition frame grid.
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
  // it (docs/data-model.md#composition — a pinned composition keeps its length
  // either way).
  applyDurationAutofit(c)
  return moved
}
