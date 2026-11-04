// src/main/state/mutations/update.ts
import type { Project, Uuid } from '../model'
import { checkLayerEditable, requireLayer, requireSameComposition } from './helpers'
import { CommandFailure } from '../errors'

/** LayerPatch. Absent = "don't touch"; `label: null` clears the name.
 *  `enabled` is the renderer's inspector toggle (MCP writes the name through
 *  `rename_layer` and the flags through `set_layer_flags`). The times are not
 *  here: a move or a trim carries link siblings, the source window and the
 *  autofit, which an envelope write cannot (`move_layers`, `trim_layer`). */
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

/** `set_layer_flags`: `enabled` and/or `locked` on exactly the layers named, in
 *  one edit — nothing is expanded, as for `applySetLayersEnabled`. The lock is
 *  written after the visibility, so "hide and lock" is one call. A lock write,
 *  like a lock-only `applyUpdateLayer`, is not itself refused by a lock; an
 *  unlock beside a visibility change on a locked layer is, at the commit
 *  boundary (`assertLockedLayersUnchanged`: unlock and edit are two calls). */
export function applySetLayerFlags(p: Project, layerIds: readonly Uuid[], flags: { enabled: boolean | null; locked: boolean | null }): void {
  const ids = [...new Set(layerIds)]
  if (ids.length === 0) throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: 'name at least one layer' })
  requireSameComposition(p, ids)
  if (flags.enabled !== null) applySetLayersEnabled(p, ids, flags.enabled)
  if (flags.locked !== null) for (const id of ids) requireLayer(p, id).layer.locked = flags.locked
}
