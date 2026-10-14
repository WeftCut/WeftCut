// Renderer-side reading of review changes for the Changes tab (ADR 0115):
// grouping by composition, row order, and the words a row is made of. Pure —
// the store lives in `reviewStore.ts`, locate in `changeActions.ts`.
import type { AgentActivitySnapshot } from '../../shared/agent-activity'
import { parseEntityKey, type Change, type EntityKind } from '../../shared/review'

/** Whose change a row lists: an unreviewed (agent-touched) one, or one only the
 *  user made — shown under "show my changes", never needing approval. */
export type ChangeSource = 'agent' | 'user'
export interface ChangeRow {
  change: Change
  source: ChangeSource
  /** The carried changes folded under this one (`carried_by` its id): the
   *  content its edit moved along, worded as the row's sub-lines, never rows
   *  of their own. */
  carried: Change[]
  /** The riders it carried (`carried_by` its id, `carried_us` set): changes
   *  of their own, listed as rows, whose movement its sub-lines count. */
  riders: Change[]
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
  const ra = a.change.ranges[0], rb = b.change.ranges[0]
  if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1)
  return ra.t_start_us - rb.t_start_us || ra.t_end_us - rb.t_end_us
}

/** Changes grouped by the composition they are listed under: the root first,
 *  then the others in the order main lists them, whole-composition changes
 *  last; rows within a group in timeline order. User rows join their
 *  composition's group, interleaved by time.
 *
 *  A carried change whose carrier is in the same list folds under the
 *  carrier's row; one whose carrier is not (main demotes such orphans, so
 *  this is a guard) stays a row of its own. */
export function groupChanges(unreviewed: readonly Change[], user: readonly Change[], rootId: string | null): ChangeGroup[] {
  const groups = new Map<string | null, ChangeGroup>()
  const addList = (list: readonly Change[], source: ChangeSource) => {
    const rows = new Map(list.map(change => [change.id, { change, source, carried: [] as Change[], riders: [] as Change[] }]))
    for (const row of rows.values()) {
      const carrier = row.change.carried_by !== undefined ? rows.get(row.change.carried_by) : undefined
      if (carrier && carrier !== row && row.change.carried) { carrier.carried.push(row.change); continue }
      if (carrier && carrier !== row && row.change.carried_us !== undefined) carrier.riders.push(row.change)
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

/** What a carrier moved along, by amount: its carried changes (`delta_us`)
 *  and its riders (`carried_us`), clips and markers counted per amount, in
 *  the order first met — one sub-line each. */
export interface CarriedAlong { delta_us: number; clips: number; markers: number }
export function carriedAlong(row: Pick<ChangeRow, 'carried' | 'riders'>): CarriedAlong[] {
  const out = new Map<number, CarriedAlong>()
  const count = (c: Change, delta: number | undefined) => {
    if (delta === undefined) return
    let g = out.get(delta)
    if (!g) out.set(delta, g = { delta_us: delta, clips: 0, markers: 0 })
    g.clips += keyIds(c, 'Layer').length
    g.markers += keyIds(c, 'Marker').length
  }
  for (const c of row.carried) count(c, c.delta_us ?? c.details.find(d => d.type === 'shift')?.delta_us)
  for (const c of row.riders) count(c, c.carried_us)
  return [...out.values()]
}

/** The ids of every key of `kind` a change covers. */
export function keyIds(change: Change, kind: EntityKind): string[] {
  return change.keys.flatMap(k => { const p = parseEntityKey(k); return p.kind === kind ? [p.id] : [] })
}

/** An unsigned amount of seconds for a sentence that says the direction in
 *  words ("前移 2.0 秒"): at most three decimals, trailing zeros dropped but
 *  one kept — `4.0`, `1.25`, `0.04`. */
export function formatSeconds(us: number): string {
  const text = (Math.abs(us) / 1_000_000).toFixed(3).replace(/0+$/, '')
  return text.endsWith('.') ? `${text}0` : text
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
      const key = `${ref.kind}:${ref.id}`
      const seen = out.get(key)
      if (!seen || at >= seen.at) out.set(key, { at, reason })
    }
  }
  return out
}

/** The reason of the most recent work session that edited any entity the
 *  change covers, or null when no session's operation names one. */
export function sessionReason(change: Pick<Change, 'keys'>, index: SessionReasonIndex): string | null {
  let best: { at: number; reason: string } | undefined
  for (const k of change.keys) {
    const hit = index.get(k)
    if (hit && (!best || hit.at > best.at)) best = hit
  }
  return best?.reason ?? null
}
