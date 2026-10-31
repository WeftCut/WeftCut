// src/main/state/mutations/update.ts
import type { Project, Uuid } from '../model'
import { checkLayerEditable, requireLayer, requireSameComposition } from './helpers'

/** LayerPatch. Absent = "don't touch"; `label: null` clears the name.
 *  `enabled` is the renderer's inspector toggle (MCP writes it through
 *  `set_layers_enabled`). The times are not here: a move or a trim carries
 *  link siblings, the source window and the autofit, which an envelope write
 *  cannot (`move_layer`, `trim_layer`). */
export interface LayerPatch {
  label?: string | null
  enabled?: boolean
  locked?: boolean
}

/** Envelope-only patch. Only a lock-only patch bypasses content protection. */
export function applyUpdateLayer(p: Project, id: Uuid, patch: LayerPatch): void {
  const lockOnly = Object.entries(patch).every(([key, value]) => key === 'locked' || value === undefined)
  const { layer } = lockOnly ? requireLayer(p, id) : checkLayerEditable(p, id)
  if (patch.label !== undefined) layer.label = patch.label
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
