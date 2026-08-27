// src/main/state/mutations/composition.ts
import type { Project, Uuid } from '../model'
import { applyDurationAutofit, scopeComposition } from './helpers'

/** Unpin, then refit duration to the layer high-water mark — of ONE composition,
 *  the named one or the root. Inverse of an explicit set_composition{duration_us},
 *  and unrecorded like it: the actor runs this over every stored snapshot, each
 *  refitting to its own high-water mark. */
export function applyFitComposition(p: Project, compositionId?: Uuid | null): void {
  const c = scopeComposition(p, compositionId)
  c.duration_pinned = false
  applyDurationAutofit(c)
}
