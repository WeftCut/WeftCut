import { isDeepStrictEqual } from 'node:util'
import { layerEditLock } from '../../shared/layerLocks'
import { CommandFailure } from './errors'
import type { Project } from './model'

/** Check indirect edits at the commit/dry-run boundary, before recording or
 * emitting. Lock-only changes are allowed; unlock plus content edits is not. */
export function assertLockedLayersUnchanged(before: Project, after: Project): void {
  for (const comp of Object.values(before.compositions)) {
    const nextComp = after.compositions[comp.id]
    if (comp === nextComp) continue
    const nextTracks = new Map(nextComp?.tracks.map(track => [track.id, track]))
    for (const track of comp.tracks) {
      const nextTrack = nextTracks.get(track.id)
      if (track === nextTrack && comp.transitions === nextComp?.transitions && comp.links === nextComp?.links) continue
      if (!track.locked && !track.layers.some(layer => layer.locked)) continue
      const nextLayers = new Map(nextTrack?.layers.map(layer => [layer.id, layer]))
      const oldIds = new Set(track.layers.map(layer => layer.id))
      if (track.locked && (!nextTrack || nextTrack.layers.some(l => !oldIds.has(l.id)))) {
        throw new CommandFailure({ error: 'TrackLocked', track: track.id })
      }
      for (const layer of track.layers) {
        const lock = layerEditLock(layer, track)
        if (!lock) continue
        const next = nextLayers.get(layer.id)
        const contentUnchanged = next !== undefined && (layer === next ||
          isDeepStrictEqual(layer, { ...next, locked: layer.locked }))
        const transitionsUnchanged = nextComp !== undefined && (comp.transitions === nextComp.transitions ||
          isDeepStrictEqual(comp.transitions.filter(t => t.from_layer === layer.id || t.to_layer === layer.id),
            nextComp.transitions.filter(t => t.from_layer === layer.id || t.to_layer === layer.id)))
        const linksUnchanged = nextComp !== undefined && (comp.links === nextComp.links ||
          isDeepStrictEqual(comp.links.filter(l => l.members.includes(layer.id)),
            nextComp.links.filter(l => l.members.includes(layer.id))))
        if (contentUnchanged && transitionsUnchanged && linksUnchanged) continue
        throw new CommandFailure(lock === 'track'
          ? { error: 'TrackLocked', track: track.id }
          : { error: 'LayerLocked', layer: layer.id })
      }
    }
  }
}
