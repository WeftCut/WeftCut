// What is expanded in the agent panel's Activity and Tacks tabs: the keys,
// each section's default, and how a new snapshot settles them.
//
// `expanded` holds only what differs from a default, so a section with no
// entry follows its default — which moves with the material (a group's open
// count, a session's end). Left alone, a section would open or close on its
// own under the user's eye. Every snapshot therefore settles the entries:
//
// - A default decides a section's state when the section appears. When a
//   later snapshot flips it, the state on screen is written down; nothing
//   opens or closes because a count or a state moved.
// - Except a tack group whose open count rises from none: new review
//   material opens its group.
// - A section that goes away forgets its state — a tack group with no tacks,
//   a closed section with no closed tacks, a tack row whose tack is gone or
//   moved between its group's open and closed lists — and starts from its
//   default when it comes back.
import type { AgentActivitySnapshot, AgentWorkSession, TackView } from '../../shared/agent-activity'
import { buildActivitySections, type ActivitySection } from './activityRows'

/** Expansion key of a tack row and of a tack group (work session, or `none`
 *  for tacks created outside one). Prefixed so activity eviction keeps them. */
export const tackRowKey = (id: string) => `tack-${id}`
export const tackGroupKey = (sessionId: string | null) => `tacks-session-${sessionId ?? 'none'}`
/** A tack group's "closed" section: its resolved and dismissed tacks. */
export const tackClosedKey = (sessionId: string | null) => `tacks-closed-${sessionId ?? 'none'}`
/** An Activity tab section of one work session's calls. */
export const sessionSectionKey = (section: Pick<ActivitySection, 'id'>) => `session-${section.id}`

/** A tack group opens while it has open tacks. */
export const tackGroupOpenByDefault = (openCount: number) => openCount > 0
/** A group's closed section opens when nothing in the group is open. */
export const tackClosedOpenByDefault = (openCount: number) => openCount === 0
/** A session's section opens while the session or one of its calls runs.
 *  (The errors filter opens every section on top of this.) */
export function sessionSectionOpenByDefault(section: ActivitySection, sessions: readonly AgentWorkSession[]): boolean {
  const work = sessions.find(s => s.id === section.sessionId)
  return work?.ended_at === null || section.rows.some(r => r.kind === 'activity' && r.activity.state === 'running')
}

type Snapshot = Pick<AgentActivitySnapshot, 'tacks' | 'sessions' | 'activities'>
interface TackCounts { open: number; closed: number }

function tackCounts(tacks: readonly TackView[]): Map<string | null, TackCounts> {
  const counts = new Map<string | null, TackCounts>()
  for (const t of tacks) {
    const c = counts.get(t.session_id) ?? { open: 0, closed: 0 }
    if (t.status === 'open') c.open += 1
    else c.closed += 1
    counts.set(t.session_id, c)
  }
  return counts
}

function sessionDefaults(s: Snapshot): Map<string, boolean> {
  const defaults = new Map<string, boolean>()
  for (const section of buildActivitySections(s.activities)) {
    if (section.sessionId !== null) defaults.set(sessionSectionKey(section), sessionSectionOpenByDefault(section, s.sessions))
  }
  return defaults
}

/** `expanded` settled for the move from `prev` to `next` (see the top of
 *  this file). Returns `expanded` itself when nothing changes. */
export function settleExpanded(prev: Snapshot, next: Snapshot, expanded: Record<string, boolean>): Record<string, boolean> {
  const out = { ...expanded }
  let changed = false
  const set = (key: string, value: boolean) => { if (out[key] !== value) { out[key] = value; changed = true } }
  const forget = (key: string) => { if (key in out) { delete out[key]; changed = true } }
  const hold = (key: string, value: boolean) => { if (!(key in out)) set(key, value) }

  const before = tackCounts(prev.tacks)
  const after = tackCounts(next.tacks)
  for (const [session, was] of before) {
    const now = after.get(session)
    const group = tackGroupKey(session), closed = tackClosedKey(session)
    if (!now) { forget(group); forget(closed); continue }
    if (was.open === 0 && now.open > 0) set(group, true)
    else if (tackGroupOpenByDefault(was.open) !== tackGroupOpenByDefault(now.open)) hold(group, tackGroupOpenByDefault(was.open))
    if (now.closed === 0) forget(closed)
    else if (was.closed > 0 && tackClosedOpenByDefault(was.open) !== tackClosedOpenByDefault(now.open)) hold(closed, tackClosedOpenByDefault(was.open))
  }
  const status = new Map(next.tacks.map(t => [t.id, t.status === 'open']))
  for (const t of prev.tacks) {
    const open = status.get(t.id)
    if (open === undefined || open !== (t.status === 'open')) forget(tackRowKey(t.id))
  }

  const wasOpen = sessionDefaults(prev)
  for (const [key, open] of sessionDefaults(next)) {
    const was = wasOpen.get(key)
    if (was !== undefined && was !== open) hold(key, was)
  }
  return changed ? out : expanded
}
