import type { Project, Uuid } from '../model'
import { applyDurationAutofit, checkTrackLock, dropLayerFromLinks, pruneEmptiedTrack } from './helpers'

/** Remove the layer, drop from links (auto-dissolve <2), prune the emptied
 *  track, autofit — all in the layer's own composition. Returns the pruned
 *  track id. */
export function applyDeleteLayer(p: Project, id: Uuid): Uuid | null {
  const { comp: c, track, layerIndex } = checkTrackLock(p, id) // throws LayerNotFound / TrackLocked
  track.layers.splice(layerIndex, 1)
  dropLayerFromLinks(c, id)
  const pruned = pruneEmptiedTrack(c, track.id)
  applyDurationAutofit(c)
  return pruned
}
