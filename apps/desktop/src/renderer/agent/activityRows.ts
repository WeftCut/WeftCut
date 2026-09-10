import type { AgentActivity } from '../../shared/agent-activity'

export type ActivityRow = { kind: 'activity'; id: string; activity: AgentActivity }
  | { kind: 'reads'; id: string; activities: AgentActivity[] }
export interface ActivitySection { id: string; sessionId: string | null; rows: ActivityRow[] }

function ordinaryRead(a: AgentActivity): boolean {
  return a.kind === 'read' && a.state === 'done' && (a.duration_ms ?? Infinity) < 250
}

/** Preserve chronology even when another connection interrupts a work session. */
export function buildActivitySections(activities: readonly AgentActivity[]): ActivitySection[] {
  const sections: ActivitySection[] = []
  for (const activity of activities) {
    let section = sections.at(-1)
    if (!section || section.sessionId !== activity.session_id) {
      section = { id: activity.id, sessionId: activity.session_id, rows: [] }
      sections.push(section)
    }
    const previous = section.rows.at(-1)
    const last = previous?.kind === 'reads' ? previous.activities.at(-1) : previous?.activity
    if (last && ordinaryRead(activity) && ordinaryRead(last) && last.connection_id === activity.connection_id) {
      if (previous!.kind === 'reads') previous!.activities.push(activity)
      else section.rows[section.rows.length - 1] = { kind: 'reads', id: last.id, activities: [last, activity] }
    } else section.rows.push({ kind: 'activity', id: activity.id, activity })
  }
  return sections
}
