// apps/desktop/src/main/agent/tackIpc.ts
// The user's tack actions from the agent panel (ADR 0115): resolve, dismiss,
// reopen, and clear. Served from the TackStore beside the agent activity, as
// the MCP verbs are (`mcp/tackTools.ts`) — so a change rides the same activity
// delta, records no history, and ignores the history lock. Users never create
// or edit a tack's text; converting one into a marker is an ordinary recorded
// `add_marker` from the renderer followed by a delete here.
import { TACK_DELETE_CHANNEL, TACK_SET_STATUS_CHANNEL, TACK_STATUSES, type TackStatus } from '../../shared/agent-activity'
import { TackError, type TackStore } from './tacks'

export const TACK_IPC_CHANNELS: ReadonlySet<string> = new Set([TACK_SET_STATUS_CHANNEL, TACK_DELETE_CHANNEL])

const isStatus = (v: unknown): v is TackStatus => (TACK_STATUSES as readonly unknown[]).includes(v)

function ids(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string'))
    throw new TackError('InvalidArgument', `${field} must be a non-empty array of tack ids`, field)
  return v as string[]
}

/** Run one panel action. Every refusal is raised before the store changes. */
export function runTackIpc(store: TackStore, channel: string, args: Record<string, unknown>): unknown {
  if (channel === TACK_SET_STATUS_CHANNEL) {
    const tackIds = ids(args.tack_ids, 'tack_ids')
    if (!isStatus(args.status)) throw new TackError('InvalidArgument', `status must be one of ${TACK_STATUSES.join(', ')}`, 'status')
    const missing = tackIds.find((id) => !store.has(id))
    if (missing !== undefined) throw new TackError('TackNotFound', `tack ${missing} no longer exists; nothing was changed`, 'tack_ids')
    for (const id of new Set(tackIds)) store.update(id, { status: args.status })
    return null
  }
  if (channel === TACK_DELETE_CHANNEL) {
    const selectors = ['tack_ids', 'session_id', 'statuses'].filter((k) => k in args)
    if (selectors.length !== 1) throw new TackError('InvalidArgument', 'name exactly one of tack_ids, session_id or statuses')
    if ('tack_ids' in args) return { deleted_tack_ids: store.delete({ tack_ids: ids(args.tack_ids, 'tack_ids') }) }
    const all = store.views()
    if ('session_id' in args) {
      const session = args.session_id
      if (session !== null && typeof session !== 'string') throw new TackError('InvalidArgument', 'session_id must be a session id or null', 'session_id')
      if (typeof session === 'string') return { deleted_tack_ids: store.delete({ session_id: session }) }
      return { deleted_tack_ids: store.delete({ tack_ids: all.filter((t) => t.session_id === null).map((t) => t.id) }) }
    }
    const statuses = args.statuses
    if (!Array.isArray(statuses) || statuses.length === 0 || !statuses.every(isStatus))
      throw new TackError('InvalidArgument', `statuses must be a non-empty array of ${TACK_STATUSES.join(', ')}`, 'statuses')
    return { deleted_tack_ids: store.delete({ tack_ids: all.filter((t) => statuses.includes(t.status)).map((t) => t.id) }) }
  }
  throw new TackError('InvalidArgument', `unknown tack channel ${channel}`)
}
