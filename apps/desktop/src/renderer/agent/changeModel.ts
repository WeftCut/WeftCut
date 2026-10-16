// Renderer-side reading of review changes for the Changes tab (ADR 0115):
// grouping by composition, row order, and the words a row is made of. Pure —
// the store lives in `reviewStore.ts`, locate in `changeActions.ts`.
import type { AgentActivitySnapshot } from '../../shared/agent-activity'
import { entityKey, parseEntityKey, type Change, type EntityKind } from '../../shared/review'

/** Whose change a row lists: an unreviewed (agent-touched) one, or one only the
 *  user made — shown under "show my changes", never needing approval. */
export type ChangeSource = 'agent' | 'user'
export interface ChangeRow {
  change: Change
  source: ChangeSource
}
export interface ChangeGroup {
  /** The composition the rows are listed under; null for changes of whole
   *  compositions (a Group added, removed or renamed). */
  compositionId: string | null
  rows: ChangeRow[]
}

/** Timed rows by footprint start (then end); listed-only ones after, in the
 *  input order (`sort` is stable). */
function byTime(a: ChangeRow, b: ChangeRow): number {
  const ra = a.change.ranges[0] ?? a.change.before_ranges?.[0], rb = b.change.ranges[0] ?? b.change.before_ranges?.[0]
  if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1)
  return ra.t_start_us - rb.t_start_us || ra.t_end_us - rb.t_end_us
}

/** Changes grouped by the composition they are listed under: the root first,
 *  then the others in the order main lists them, whole-composition changes
 *  last; rows within a group in timeline order. User rows join their
 *  composition's group, interleaved by time.
 */
export function groupChanges(unreviewed: readonly Change[], user: readonly Change[], rootId: string | null): ChangeGroup[] {
  const groups = new Map<string | null, ChangeGroup>()
  const addList = (list: readonly Change[], source: ChangeSource) => {
    for (const change of list) {
      const row: ChangeRow = { change, source }
      const key = row.change.composition_id
      let g = groups.get(key)
      if (!g) groups.set(key, g = { compositionId: key, rows: [] })
      g.rows.push(row)
    }
  }
  addList(unreviewed, 'agent')
  addList(user, 'user')
  const rank = (g: ChangeGroup) => (g.compositionId === null ? 2 : g.compositionId === rootId ? 0 : 1)
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b))
    .map(g => ({ ...g, rows: [...g.rows].sort(byTime) }))
}

/** The id of the entity a change describes when it is of `kind`, else null. */
export function entityIdOf(change: Pick<Change, 'id'>, kind: EntityKind): string | null {
  const p = parseEntityKey(change.id)
  return p.kind === kind ? p.id : null
}

/** Entity key → the reason of the work session that last edited it: the most
 *  recent `operation` activity (by start) of a session naming it in
 *  `affected`. Built once per activity snapshot; read with `sessionReason`. */
export type SessionReasonIndex = ReadonlyMap<string, { at: number; reason: string }>
export function sessionReasonIndex(snapshot: Pick<AgentActivitySnapshot, 'activities' | 'sessions'> | null): SessionReasonIndex {
  const out = new Map<string, { at: number; reason: string }>()
  if (!snapshot) return out
  const reasons = new Map(snapshot.sessions.map(s => [s.id, s.reason.trim()]))
  for (const a of snapshot.activities) {
    if (a.kind !== 'operation' || a.session_id === null) continue
    const reason = reasons.get(a.session_id)
    if (!reason) continue
    // A tie goes to the later one in the list (`>=`): activities are listed in
    // the order they started.
    const at = Date.parse(a.started_at) || 0
    for (const ref of a.affected) {
      if (ref.kind === 'Media') continue // media is no review entity
      const key = entityKey(ref.kind, ref.id)
      const seen = out.get(key)
      if (!seen || at >= seen.at) out.set(key, { at, reason })
    }
  }
  return out
}

/** The reason of the most recent work session that edited the change's
 *  entity, or null when no session's operation names it. */
export function sessionReason(change: Pick<Change, 'id'>, index: SessionReasonIndex): string | null {
  return index.get(change.id)?.reason ?? null
}
