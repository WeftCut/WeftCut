import type { Project, Uuid } from '../model'
import { applyDurationAutofit, dropLayerFromLinks, requireTrack } from './helpers'
import { CommandFailure } from '../errors'

/** Remove a track and its contents; A/B roll stay, non-empty lanes need `force`.
 *  Role is the protection boundary, including legacy audio/caption lanes whose
 *  stored `removable` flag predates the explicit deletion surface. */
export function applyDeleteTrack(p: Project, id: Uuid, force: boolean): void {
  const { comp: c, track, trackIndex } = requireTrack(p, id)
  if (track.role === 'ARoll' || track.role === 'BRoll') throw new CommandFailure({ error: 'TrackNotRemovable', track: id })
  if (!force && track.layers.length > 0) throw new CommandFailure({ error: 'TrackNotEmpty', track: id })
  for (const layer of track.layers) dropLayerFromLinks(c, layer.id)
  c.tracks.splice(trackIndex, 1)
  applyDurationAutofit(c)
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
  const { comp: c, track, trackIndex: cur } = requireTrack(p, id)
  // `splice` counts a negative index from the end, which would place the
  // track and report success; the range is 0..len-1 and nothing else.
  if (!Number.isInteger(newPosition) || newPosition < 0 || newPosition >= c.tracks.length) throw new CommandFailure({ error: 'TrackPositionOutOfRange', position: newPosition, len: c.tracks.length })
  if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: id })
  const locked = track.layers.find((layer) => layer.locked)
  if (locked) throw new CommandFailure({ error: 'InvalidArgument', field: 'track', detail: `layer ${locked.id} is locked` })
  const [t] = c.tracks.splice(cur, 1)
  c.tracks.splice(newPosition, 0, t)
}
