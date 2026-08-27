import type { Project, Uuid } from '../model'
import { applyDurationAutofit, checkTrackLock, dropLayerFromLinks, pruneEmptiedTrack, rootComposition } from './helpers'
import { CommandFailure } from '../errors'

/** Remove the layer, drop from links (auto-dissolve <2), prune the emptied
 *  track, autofit. Returns the pruned track id. */
export function applyDeleteLayer(p: Project, id: Uuid): Uuid | null {
  const c = rootComposition(p)
  checkTrackLock(p, id) // throws LayerNotFound / TrackLocked
  let sourceTrack: Uuid | null = null
  for (const track of c.tracks) {
    const idx = track.layers.findIndex((l) => l.id === id)
    if (idx >= 0) { track.layers.splice(idx, 1); sourceTrack = track.id; break }
  }
  if (sourceTrack === null) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  dropLayerFromLinks(c, id)
  const pruned = pruneEmptiedTrack(c, sourceTrack)
  applyDurationAutofit(c)
  return pruned
}
