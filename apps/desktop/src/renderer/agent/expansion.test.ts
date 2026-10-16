import { describe, expect, it } from 'vitest'
import type { AgentActivity, AgentWorkSession, TackStatus, TackView } from '../../shared/agent-activity'
import { settleExpanded, tackClosedKey, tackGroupKey, tackRowKey } from './expansion'

const tack = (id: string, status: TackStatus = 'open', session_id: string | null = 'w'): TackView => ({
  id, session_id, status, connection_id: 'c', client: 'Client', activity_id: 'a', kind: 'note', label: id, body: '',
  range: { composition_id: 'root', t_us: 0, end_t_us: null }, created_at: '', composition_id: 'root', t_us: 0, end_t_us: null,
  outdated: false, follows: null,
})
const snap = (tacks: TackView[], sessions: AgentWorkSession[] = [], activities: AgentActivity[] = []) => ({ tacks, sessions, activities })
const group = tackGroupKey('w'), closed = tackClosedKey('w')

describe('settleExpanded — tacks', () => {
  it('forgets a closed section once nothing in it is left, so it comes back collapsed', () => {
    const shown = { [group]: true, [closed]: true }
    const reopened = settleExpanded(snap([tack('a'), tack('b', 'resolved')]), snap([tack('a'), tack('b')]), shown)
    expect(reopened).toEqual({ [group]: true })
    // Resolving one again: the section returns from its default — collapsed, the group has open tacks.
    expect(settleExpanded(snap([tack('a'), tack('b')]), snap([tack('a'), tack('b', 'resolved')]), reopened)[closed]).toBeUndefined()
  })

  it('keeps the group open and its closed section as it was when the last open tack is resolved', () => {
    const next = settleExpanded(snap([tack('a'), tack('b', 'resolved')]), snap([tack('a', 'resolved'), tack('b', 'resolved')]), {})
    expect(next).toEqual({ [group]: true, [closed]: false })
  })

  it('keeps the closed section open when one tack of an all-closed group is reopened', () => {
    const next = settleExpanded(snap([tack('a', 'resolved'), tack('b', 'dismissed')]), snap([tack('a'), tack('b', 'dismissed')]), { [group]: true })
    expect(next).toEqual({ [group]: true, [closed]: true })
  })

  it('opens a group the user folded when it gets an open tack again', () => {
    const next = settleExpanded(snap([tack('a', 'resolved')]), snap([tack('a', 'resolved'), tack('b')]), { [group]: false })
    expect(next[group]).toBe(true)
  })

  it('leaves a choice the user made alone while the defaults move under it', () => {
    const next = settleExpanded(snap([tack('a'), tack('b', 'resolved')]), snap([tack('a', 'resolved'), tack('b', 'resolved')]), { [group]: false, [closed]: true })
    expect(next).toEqual({ [group]: false, [closed]: true })
  })

  it('forgets a cleared group, and a row whose tack went or changed lists', () => {
    const expanded = { [group]: false, [closed]: true, [tackRowKey('a')]: true, [tackRowKey('b')]: true, [tackRowKey('c')]: true, [tackGroupKey(null)]: true }
    const next = settleExpanded(
      snap([tack('a'), tack('b'), tack('c', 'resolved'), tack('x', 'open', null)]),
      snap([tack('a'), tack('b', 'resolved'), tack('x', 'open', null)]),
      expanded)
    expect(next).toEqual({ [group]: false, [closed]: true, [tackRowKey('a')]: true, [tackGroupKey(null)]: true })
    expect(settleExpanded(snap([tack('a')]), snap([]), { [group]: true, [closed]: true })).toEqual({})
  })

  it('returns the same record when nothing moves', () => {
    const expanded = { [group]: true }
    expect(settleExpanded(snap([tack('a')]), snap([tack('a'), tack('b')]), expanded)).toBe(expanded)
  })
})

describe('settleExpanded — activity sessions', () => {
  const work = (ended: boolean): AgentWorkSession => ({ id: 'w', connection_id: 'c', client: 'Client', reason: 'Pass', started_at: '', ended_at: ended ? 'later' : null, end_reason: ended ? 'agent' : null, checkpoint_id: 'cp' })
  const call = (id: string, state: AgentActivity['state'] = 'done') => ({ id, session_id: 'w', state }) as AgentActivity

  it('keeps a session open on screen when it ends', () => {
    const next = settleExpanded(snap([], [work(false)], [call('a1')]), snap([], [work(true)], [call('a1')]), {})
    expect(next).toEqual({ 'session-a1': true })
  })

  it('leaves a section whose default holds alone, and a folded one folded', () => {
    expect(settleExpanded(snap([], [work(false)], [call('a1')]), snap([], [work(false)], [call('a1'), call('a2')]), {})).toEqual({})
    expect(settleExpanded(snap([], [work(false)], [call('a1')]), snap([], [work(true)], [call('a1')]), { 'session-a1': false })).toEqual({ 'session-a1': false })
  })
})
