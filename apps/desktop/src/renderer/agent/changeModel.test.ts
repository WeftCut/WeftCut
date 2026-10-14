import { describe, expect, it } from 'vitest'
import type { AgentActivity, AgentWorkSession } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { formatSeconds, groupChanges, sessionReason, sessionReasonIndex } from './changeModel'

const change = (patch: Partial<Change> & { id: string }): Change => ({
  class: 'modified', kind: 'Layer', keys: [patch.id as Change['keys'][number]], aspects: [], details: [],
  composition_id: 'root', composition_ids: ['root'], ranges: [], ...patch,
})

describe('formatSeconds', () => {
  it('is unsigned, keeps one decimal, at most three', () => {
    expect([4 * 1e6, -4 * 1e6, 1_250_000, 40_000, 1_234_567, 0].map(formatSeconds)).toEqual(['4.0', '4.0', '1.25', '0.04', '1.235', '0.0'])
  })
})

describe('groupChanges folding', () => {
  it('folds a carried change under its carrier in the same list only', () => {
    const carrier = change({ id: 'Layer:cut', class: 'removed' })
    const carried = change({ id: 'Shift:root:-5', keys: ['Layer:a'], delta_us: -5, carried: true, carried_by: 'Layer:cut' })
    const orphan = change({ id: 'Shift:root:-7', keys: ['Layer:b'], delta_us: -7, carried: true, carried_by: 'Layer:mine' })
    const mine = change({ id: 'Layer:mine' })
    const [g] = groupChanges([carrier, carried, orphan], [mine], 'root')
    expect(g!.rows.map(r => [r.change.id, r.carried.map(c => c.id)])).toEqual([
      ['Layer:cut', ['Shift:root:-5']], ['Shift:root:-7', []], ['Layer:mine', []],
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
  it('is the most recent session whose operation touched any of the keys', () => {
    expect(sessionReason({ keys: ['Layer:x'] }, index)).toBe('Tighten the intro')
    expect(sessionReason({ keys: ['Marker:m'] }, index)).toBe('Tighten the intro')
    expect(sessionReason({ keys: ['Layer:x', 'Layer:y'] }, index)).toBe('Fix the outro')
  })
  it('is null when no session operation names the change', () => {
    expect(sessionReason({ keys: ['Layer:z'] }, index)).toBeNull()
    expect(sessionReason({ keys: ['Layer:x'] }, sessionReasonIndex(null))).toBeNull()
  })
})
