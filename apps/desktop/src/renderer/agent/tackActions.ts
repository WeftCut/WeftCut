// The user's tack actions (ADR 0115, ADR 0185). Opening, replying, status and
// clearing go to main's TackStore; conversion is the one path into project
// content — an ordinary recorded marker. Locate is `locate.ts`, shared with
// changes.
import type { TackDeleteSelector, TackStatus, TackView, UserTackInput } from '../../shared/agent-activity'
import { agentTacksCreate, agentTacksDelete, agentTacksReply, agentTacksSetStatus } from '../ipc'
import { addMarkerIn } from '../ipc/compositionScoped'
import { tryMutate } from '../errors/tryMutate'
import { tackMarkerArgs } from './tackModel'

export const setTackStatus = (ids: readonly string[], status: TackStatus) =>
  tryMutate(() => agentTacksSetStatus(ids, status), 'agent_tacks_set_status')

/** The new tack's id, or null when it was refused (the refusal is already
 *  on the status bar). */
export async function createUserTack(input: UserTackInput): Promise<string | null> {
  let id: string | null = null
  const ok = await tryMutate(async () => { id = (await agentTacksCreate(input)).tack_id }, 'agent_tacks_create')
  return ok ? id : null
}

export const replyToTack = (id: string, body: string) =>
  tryMutate(() => agentTacksReply(id, body), 'agent_tacks_reply')

export const deleteTacks = (selector: TackDeleteSelector) =>
  tryMutate(() => agentTacksDelete(selector), 'agent_tacks_delete')

/** One recorded `add_marker` carrying the tack's place, label, body and (iff
 *  the clip it follows starts at its start) anchor; then the tack goes. Undoing the marker does not bring the
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
