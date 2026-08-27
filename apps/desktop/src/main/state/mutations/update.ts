// src/main/state/mutations/update.ts
import type { Project, Uuid } from '../model'
import { checkTrackLock, locateLayer, rootComposition } from './helpers'

/** LayerPatch. null/absent = "don't touch". */
export interface LayerPatch {
  label?: string | null
  t_start_us?: number | null
  t_end_us?: number | null
  enabled?: boolean | null
  locked?: boolean | null
}

/** Envelope-only patch. check_track_lock FIRST (rejects
 *  edits on a locked track / missing layer), then apply only the provided fields.
 *  Does NOT autofit: a t_end edit here never moves composition.duration_us. */
export function applyUpdateLayer(p: Project, id: Uuid, patch: LayerPatch): void {
  const c = rootComposition(p)
  checkTrackLock(p, id) // throws LayerNotFound (missing) or TrackLocked (locked track)
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = c.tracks[loc[0]].layers[loc[1]]
  if (typeof patch.label === 'string') layer.label = patch.label
  if (typeof patch.t_start_us === 'number') layer.t_start_us = patch.t_start_us
  if (typeof patch.t_end_us === 'number') layer.t_end_us = patch.t_end_us
  if (typeof patch.enabled === 'boolean') layer.enabled = patch.enabled
  if (typeof patch.locked === 'boolean') layer.locked = patch.locked
}

/** Set `enabled` on exactly the layers named — the caller supplies a link's
 *  member set when the toggle should fan out; nothing is expanded here. A
 *  layer's own `locked` does not block it: the eye is visibility, not content,
 *  the same reasoning the track-flag path applies. A locked track does, and it
 *  refuses the WHOLE set before any layer is written (`checkTrackLock` also
 *  throws LayerNotFound for an unknown id). */
export function applySetLayersEnabled(p: Project, layerIds: readonly Uuid[], enabled: boolean): void {
  const c = rootComposition(p)
  const ids = [...new Set(layerIds)]
  for (const id of ids) checkTrackLock(p, id)
  for (const id of ids) {
    const loc = locateLayer(p, id)! // verified by checkTrackLock
    c.tracks[loc[0]].layers[loc[1]].enabled = enabled
  }
}
