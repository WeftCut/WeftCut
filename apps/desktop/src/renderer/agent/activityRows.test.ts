import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../shared/agent-activity'
import { buildActivitySections } from './activityRows'

function a(id: string, patch: Partial<AgentActivity> = {}): AgentActivity {
  return { id, session_id: null, connection_id: 'c', client: 'Client', tool: 'read', kind: 'read', started_at: '', ended_at: '',
    state: 'done', duration_ms: 10, message: 'read', affected: [], entity_labels: [], history_ids: [], effect: null, args: {}, error: null, ...patch }
}
describe('activity grouping', () => {
  it('collapses only ordinary consecutive reads from the same client', () => {
    const sections = buildActivitySections([a('1'), a('2'), a('3', { duration_ms: 800 }), a('4', { state: 'error' }), a('5', { connection_id: 'other' }), a('6')])
    expect(sections[0]?.rows.map(r => r.kind)).toEqual(['reads', 'activity', 'activity', 'activity', 'activity'])
  })
  it('keeps interleaved connection work in chronological order', () => {
    const sections = buildActivitySections([a('1', { session_id: 'work' }), a('2'), a('3', { session_id: 'work' })])
    expect(sections.map(s => s.sessionId)).toEqual(['work', null, 'work'])
    expect(sections.map(s => s.id)).toEqual(['1', '2', '3'])
  })
})
