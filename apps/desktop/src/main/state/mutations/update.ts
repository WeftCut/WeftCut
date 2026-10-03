// src/main/state/mutations/update.ts
import type { Project, Uuid } from '../model'
import { checkLayerEditable, requireLayer, requireSameComposition } from './helpers'

/** LayerPatch. null/absent = "don't touch". */
export interface LayerPatch {
  label?: string | null
  t_start_us?: number | null
  t_end_us?: number | null
  enabled?: boolean | null
  locked?: boolean | null
}

/** Envelope-only patch. Only a lock-only patch bypasses content protection.
 *  Does NOT autofit: a t_end edit here never moves composition.duration_us. */
export function applyUpdateLayer(p: Project, id: Uuid, patch: LayerPatch): void {
  const lockOnly = Object.entries(patch).every(([key, value]) => key === 'locked' || value == null)
  const { layer } = lockOnly ? requireLayer(p, id) : checkLayerEditable(p, id)
  if (typeof patch.label === 'string') layer.label = patch.label
  if (typeof patch.t_start_us === 'number') layer.t_start_us = patch.t_start_us
  if (typeof patch.t_end_us === 'number') layer.t_end_us = patch.t_end_us
  if (typeof patch.enabled === 'boolean') layer.enabled = patch.enabled
  if (typeof patch.locked === 'boolean') layer.locked = patch.locked
}

/** Set `enabled` on exactly the layers named — the caller supplies a link's
 *  member set when the toggle should fan out; nothing is expanded here. A
 *  layer or track lock refuses the WHOLE set before any layer is written (the guard also
 *  throws LayerNotFound for an unknown id). The set is one composition's
 *  (CrossCompositionSet otherwise) — a selection never spans two. */
export function applySetLayersEnabled(p: Project, layerIds: readonly Uuid[], enabled: boolean): void {
  const ids = [...new Set(layerIds)]
  if (ids.length === 0) return
  requireSameComposition(p, ids)
  const located = ids.map((id) => checkLayerEditable(p, id))
  for (const { layer } of located) layer.enabled = enabled
}
