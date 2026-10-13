// Renderer-side reading of review changes for the Changes tab (ADR 0115):
// grouping by composition, row order, and the words a row is made of. Pure —
// the store lives in `reviewStore.ts`, locate in `changeActions.ts`.
import { parseEntityKey, type Change, type EntityKind } from '../../shared/review'

/** Whose change a row lists: an unreviewed (agent-touched) one, or one only the
 *  user made — shown under "show my changes", never needing approval. */
export type ChangeSource = 'agent' | 'user'
export interface ChangeRow { change: Change; source: ChangeSource }
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
 *  composition's group, interleaved by time. */
export function groupChanges(unreviewed: readonly Change[], user: readonly Change[], rootId: string | null): ChangeGroup[] {
  const groups = new Map<string | null, ChangeGroup>()
  const add = (change: Change, source: ChangeSource) => {
    const key = change.composition_id
    let g = groups.get(key)
    if (!g) groups.set(key, g = { compositionId: key, rows: [] })
    g.rows.push({ change, source })
  }
  for (const c of unreviewed) add(c, 'agent')
  for (const c of user) add(c, 'user')
  const rank = (g: ChangeGroup) => (g.compositionId === null ? 2 : g.compositionId === rootId ? 0 : 1)
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b))
    .map(g => ({ ...g, rows: [...g.rows].sort(byTime) }))
}

/** The ids of every key of `kind` a change covers. */
export function keyIds(change: Change, kind: EntityKind): string[] {
  return change.keys.flatMap(k => { const p = parseEntityKey(k); return p.kind === kind ? [p.id] : [] })
}

/** A shift's translation as a signed number of seconds for display: `+2.4`,
 *  `−0.04` (a true minus sign), at most three decimals, trailing zeros dropped. */
export function formatShiftSeconds(deltaUs: number): string {
  const s = Math.abs(deltaUs) / 1_000_000
  const text = s.toFixed(3).replace(/\.?0+$/, '')
  return `${deltaUs < 0 ? '−' : '+'}${text}`
}
