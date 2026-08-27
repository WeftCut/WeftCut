// apps/desktop/src/main/state/mutations/restack.ts
import type { Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { applyAddTrack } from './add'
import { pruneEmptiedTrack, requireLayer } from './helpers'

export type RestackPosition = 'above' | 'below'

/** Anchored z-reorder of one visual layer (ADR 0044 decision 2/3). Z is track
 *  order, so the op moves tracks, not indices within one: `position` puts the
 *  mover's track directly above/below the track the ANCHOR layer sits on,
 *  resolved here at apply time — anchors are layers because an index drifts
 *  between a caller's read and its write. Both live in one composition: an
 *  anchor in another is a destination there, and refused (CrossCompositionMove).
 *
 *  Smart degradation, owned by the model (not composed by callers): a mover
 *  that is its track's sole occupant carries the track itself — id, label,
 *  lock and height survive; a mover sharing its track (an off-screen
 *  neighbour, a co-resident audio layer) splits onto a fresh track at the
 *  target position, and the source it left runs through the ONE prune
 *  predicate. A role-stamped source always takes the split path — the
 *  reserved skeleton never moves, and the predicate declines it anyway.
 *
 *  Times are untouched, so no re-snap and no `applyDurationAutofit` — the
 *  same reasoning as `applyMoveLayersToNewTrack`: nothing is retimed, so the
 *  high-water mark cannot move. Link membership is untouched for the same
 *  reason as there: no invariant ties a link to a track.
 *
 *  Returns the id of the track the mover ends up on (the moved track, or the
 *  freshly minted one), or null when the mover's track is ALREADY directly at
 *  the requested side of the anchor's — the caller's commit no-op guard then
 *  records nothing and burns no op id (the move_track contract). The fresh
 *  track's id is minted only after every check, so a refusal burns no id. */
export function applyRestackLayer(p: Project, idGen: IdGen, layerId: Uuid, anchorId: Uuid, position: RestackPosition): Uuid | null {
  if (position !== 'above' && position !== 'below')
    throw new CommandFailure({ error: 'InvalidArgument', field: 'position', detail: `expected 'above' | 'below', got ${String(position)}` })
  const mover = requireLayer(p, layerId)
  const anchor = requireLayer(p, anchorId)
  if (layerId === anchorId)
    throw new CommandFailure({ error: 'InvalidArgument', field: 'anchor', detail: 'anchor must be a layer other than the one being restacked' })
  if (mover.comp !== anchor.comp)
    throw new CommandFailure({ error: 'CrossCompositionMove', layer: layerId, from: mover.comp.id, to: anchor.comp.id })
  // Audio composites by role, not by stacking (ADR 0023): z is meaningless for
  // it, so it neither moves nor anchors.
  if (mover.layer.params.kind === 'Audio')
    throw new CommandFailure({ error: 'WrongLayerKind', layer: layerId, expected: 'visual' })
  if (anchor.layer.params.kind === 'Audio')
    throw new CommandFailure({ error: 'WrongLayerKind', layer: anchorId, expected: 'visual' })

  const c = mover.comp
  const mi = mover.trackIndex
  const ai = anchor.trackIndex
  // Already directly at the requested side of the anchor's track — in z terms
  // the layer already sits where the caller asked, whichever branch would have
  // carried it there, so nothing happens (and a shared track is not split
  // gratuitously). Validation stays ABOVE this line: an invalid no-op call
  // must refuse, not silently succeed.
  if (mi === (position === 'above' ? ai + 1 : ai - 1)) return null

  const src = c.tracks[mi]
  if (src.layers.length === 1 && src.role === null) {
    // Sole occupant on an ordinary track: the track IS the layer's z, so the
    // track moves whole and its identity — id, label, lock, height — survives.
    c.tracks.splice(mi, 1)
    const anchorIdx = ai > mi ? ai - 1 : ai // the removal shifted tracks above mi down by one
    c.tracks.splice(position === 'above' ? anchorIdx + 1 : anchorIdx, 0, src)
    return src.id
  }
  // Split path: the mover leaves alone. `label: null` lets the fresh track
  // derive its name from position (ADR 0042); the source is re-found by ID
  // because the insertion just shifted indices.
  const srcTrackId = src.id
  const destTrackId = applyAddTrack(p, idGen, null, position === 'above' ? ai + 1 : ai, c.id)
  const dest = c.tracks.find((t) => t.id === destTrackId)! // just inserted
  const from = c.tracks.find((t) => t.id === srcTrackId)!
  const li = from.layers.findIndex((l) => l.id === layerId)
  dest.layers.push(from.layers.splice(li, 1)[0]) // dest is empty, so push keeps t-sort trivially
  // Cleanup rides in the SAME mutation (one undo restores layer + new track +
  // pruned source together). The predicate declines the reserved skeleton and
  // locked tracks on its own — one rule, one home.
  pruneEmptiedTrack(c, srcTrackId)
  return destTrackId
}
