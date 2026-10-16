import { describe, expect, it } from 'vitest'
import type { AgentActivity, AgentWorkSession } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { groupChanges, sessionReason, sessionReasonIndex } from './changeModel'

const change = (patch: Partial<Change> & Pick<Change, 'id'>): Change => ({
  class: 'modified', details: [],
  composition_id: 'root', ranges: [], ...patch,
})

describe('groupChanges', () => {
  it('keeps every entity as an independent row, in its composition and source', () => {
    const removed = change({ id: 'Layer:gone', class: 'removed' })
    const moved = change({ id: 'Layer:moved' })
    const mine = change({ id: 'Layer:mine' })
    const [group] = groupChanges([removed, moved], [mine], 'root')
    expect(group!.rows.map(r => [r.change.id, r.source])).toEqual([
      ['Layer:gone', 'agent'], ['Layer:moved', 'agent'], ['Layer:mine', 'user'],
    ])
  })
})

describe('sessionReason', () => {
  const session = (id: string, reason: string) => ({ id, reason }) as AgentWorkSession
  const activity = (id: string, patch: Partial<AgentActivity>) =>
    ({ id, session_id: 's1', kind: 'operation', started_at: '2026-10-14T10:00:00Z', affected: [], ...patch }) as AgentActivity
  const snapshot = {
    sessions: [session('s1', 'Tighten the intro'), session('s2', 'Fix the outro'), session('s3', '  ')],
    activities: [
      activity('a1', { affected: [{ kind: 'Layer', id: 'x' }, { kind: 'Marker', id: 'm' }] }),
      activity('a2', { session_id: 's2', started_at: '2026-10-14T11:00:00Z', affected: [{ kind: 'Layer', id: 'y' }] }),
      // A read names nothing it changed; a session without a reason has none to give.
      activity('a3', { session_id: 's2', kind: 'read', started_at: '2026-10-14T12:00:00Z', affected: [{ kind: 'Layer', id: 'x' }] }),
      activity('a4', { session_id: 's3', started_at: '2026-10-14T12:00:00Z', affected: [{ kind: 'Layer', id: 'x' }] }),
      activity('a5', { session_id: null, started_at: '2026-10-14T12:00:00Z', affected: [{ kind: 'Layer', id: 'x' }] }),
    ],
  }
  const index = sessionReasonIndex(snapshot)
  it('is the most recent session whose operation touched the change’s entity', () => {
    expect(sessionReason({ id: 'Layer:x' }, index)).toBe('Tighten the intro')
    expect(sessionReason({ id: 'Marker:m' }, index)).toBe('Tighten the intro')
    expect(sessionReason({ id: 'Layer:y' }, index)).toBe('Fix the outro')
  })
  it('is null when no session operation names the change', () => {
    expect(sessionReason({ id: 'Layer:z' }, index)).toBeNull()
    expect(sessionReason({ id: 'Layer:x' }, sessionReasonIndex(null))).toBeNull()
  })
})
