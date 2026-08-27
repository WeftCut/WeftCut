import type { Project, Uuid } from '../model'
import { requireTrack } from './helpers'
import { CommandFailure } from '../errors'

/** Remove a track; reserved tracks are not removable, non-empty ones need `force`. */
export function applyDeleteTrack(p: Project, id: Uuid, force: boolean): void {
  const { comp: c, track, trackIndex } = requireTrack(p, id)
  if (!track.removable) throw new CommandFailure({ error: 'TrackNotRemovable', track: id })
  if (!force && track.layers.length > 0) throw new CommandFailure({ error: 'TrackNotEmpty', track: id })
  c.tracks.splice(trackIndex, 1)
}

/** Name a track. Every lane is renameable — a reserved role is a naming
 *  FALLBACK, not a lock — so this gates on nothing but the id existing.
 *
 *  A blank name stores `null`, which is what restores the derived name
 *  (ADR 0042). This is deliberately NOT the layer rename's "an empty value
 *  abandons the edit": a lane's derived name is a meaningful default the user
 *  needs a route back to, and a layer has no equivalent. Trimming here rather
 *  than at each caller is what keeps a blank out of the project file, so the
 *  display layer never has to defend against one. */
export function applyRenameTrack(p: Project, id: Uuid, label: string | null): void {
  const { track } = requireTrack(p, id)
  const next = label?.trim()
  track.label = next ? next : null
}

/** Reposition a track within its composition. TrackNotFound →
 *  TrackPositionOutOfRange → remove+reinsert. The cur===new no-op (skip commit)
 *  is handled by the actor. */
export function applyMoveTrack(p: Project, id: Uuid, newPosition: number): void {
  const { comp: c, trackIndex: cur } = requireTrack(p, id)
  if (newPosition >= c.tracks.length) throw new CommandFailure({ error: 'TrackPositionOutOfRange', position: newPosition, len: c.tracks.length })
  const [t] = c.tracks.splice(cur, 1)
  c.tracks.splice(newPosition, 0, t)
}
