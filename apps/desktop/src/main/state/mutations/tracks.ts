import type { Project, Uuid } from '../model'
import { rootComposition } from './helpers'
import { CommandFailure } from '../errors'

/** Remove a track; reserved tracks are not removable, non-empty ones need `force`. */
export function applyDeleteTrack(p: Project, id: Uuid, force: boolean): void {
  const c = rootComposition(p)
  const idx = c.tracks.findIndex((t) => t.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  if (!c.tracks[idx].removable) throw new CommandFailure({ error: 'TrackNotRemovable', track: id })
  if (!force && c.tracks[idx].layers.length > 0) throw new CommandFailure({ error: 'TrackNotEmpty', track: id })
  c.tracks.splice(idx, 1)
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
  const c = rootComposition(p)
  const t = c.tracks.find((x) => x.id === id)
  if (!t) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  const next = label?.trim()
  t.label = next ? next : null
}

/** Reposition a track. TrackNotFound → TrackPositionOutOfRange →
 *  remove+reinsert. The cur===new no-op (skip commit) is handled by the actor. */
export function applyMoveTrack(p: Project, id: Uuid, newPosition: number): void {
  const c = rootComposition(p)
  const cur = c.tracks.findIndex((t) => t.id === id)
  if (cur < 0) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  if (newPosition >= c.tracks.length) throw new CommandFailure({ error: 'TrackPositionOutOfRange', position: newPosition, len: c.tracks.length })
  const [t] = c.tracks.splice(cur, 1)
  c.tracks.splice(newPosition, 0, t)
}
