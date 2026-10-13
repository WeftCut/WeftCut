// The user's tack actions (ADR 0115). Status and clearing go to main's
// TackStore; conversion is the one path into project content — an ordinary
// recorded marker — and locate is editor navigation (ADR 0065).
import type { TackDeleteSelector, TackStatus, TackView } from '../../shared/agent-activity'
import { agentTacksDelete, agentTacksSetStatus } from '../ipc'
import { addMarkerIn } from '../ipc/compositionScoped'
import { tryMutate } from '../errors/tryMutate'
import { openComposition, useCompositionAnchorStore } from '../state/compositionAnchorStore'
import { revealLayerWithoutSeek, jumpToTimeUs } from '../state/navigation'
import { focusedRootUs } from '../state/playheadProjection'
import { tackMarkerArgs } from './tackModel'

export const setTackStatus = (ids: readonly string[], status: TackStatus) =>
  tryMutate(() => agentTacksSetStatus(ids, status), 'agent_tacks_set_status')

export const deleteTacks = (selector: TackDeleteSelector) =>
  tryMutate(() => agentTacksDelete(selector), 'agent_tacks_delete')

/** One recorded `add_marker` carrying the tack's place, label, body and (iff
 *  anchored) anchor; then the tack goes. Undoing the marker does not bring the
 *  tack back — the tack was review material, the marker is the user's content.
 *  A failed add leaves the tack where it was. True when the marker exists. */
export async function convertTackToMarker(t: TackView): Promise<boolean> {
  const args = tackMarkerArgs(t)
  if (args === null) return false
  if (!await tryMutate(() => addMarkerIn(args), 'add_marker')) return false
  // The marker exists either way; a tack an agent removed meanwhile is gone
  // already, which is the outcome this delete was for.
  try { await agentTacksDelete({ tack_ids: [t.id] }) } catch { /* already gone */ }
  return true
}

/** Seek to a tack and, for an anchored one, reveal and select its clip —
 *  entering the composition it sits in first. Editor only (ADR 0065): agent
 *  view is for watching the preview. False when the tack has no place. */
export function locateTack(t: TackView): boolean {
  if (t.state !== 'visible' || t.composition_id === null || t.t_us === null) return false
  if (t.range.kind === 'anchored') {
    if (!revealLayerWithoutSeek(t.range.layer_id)) return false
  } else if (useCompositionAnchorStore.getState().focusedId !== t.composition_id && !openComposition(t.composition_id, null)) {
    return false
  }
  // The composition holding the tack is focused now, so its own clock projects
  // into the film's through the anchor that open gave it.
  jumpToTimeUs(focusedRootUs(t.t_us))
  return true
}
