import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentActivityService, activityDetails } from './activity'
import { createActor } from '../state/actor'
import { blankProject } from '../state/model'
import { seededGen } from '../state/ids'
import { AGENT_VIEW_EVENT } from '../../shared/agent-activity'

const stops: Array<() => void> = []
afterEach(() => { stops.splice(0).forEach(stop => stop()) })
function setup(capacity = 1000) {
  const ids = seededGen()
  const actor = createActor({ initial: blankProject(ids, 'test'), idGen: ids })
  const send = vi.fn()
  const service = new AgentActivityService(actor, send, capacity)
  service.start()
  stops.push(() => service.stop())
  const run = <T>(connection: string, fn: () => T | Promise<T>, tool = 'edit') => service.run(connection, connection, tool, {}, false, fn)
  const add = () => {
    const result = actor.mcpCall('add_track', JSON.stringify({ label: 'Test track' }))
    expect(result.ok).toBe(true)
    return actor.historyView(200).ops.at(-1)!.op_id
  }
  return { actor, service, send, run, add }
}

describe('agent work sessions', () => {
  it('starts once per connection and does not let another connection replace it', async () => {
    const { service, actor, send, run } = setup()
    const first = await run('one', () => service.begin('Cut interview'))
    const again = await run('one', () => service.begin('Retry'))
    expect(again.id).toBe(first.id)
    expect(actor.listCheckpoints()).toHaveLength(1)
    expect(send.mock.calls.filter(([event]) => event === AGENT_VIEW_EVENT)).toHaveLength(1)
    await expect(run('two', () => service.begin('Other job'))).rejects.toThrow('AgentSessionBusy')
    expect(service.snapshot().session?.id).toBe(first.id)
    expect(service.snapshot().activities.at(-1)?.session_id).toBeNull()
  })

  it('local end releases its lock, preserves records, and permits later operations', async () => {
    const { service, actor, run, add, send } = setup()
    const session = await run('one', () => { const s = service.begin('Edit'); service.lock(''); return s })
    expect(actor.historyStatus().lock_reason).toBe('')
    service.end('user')
    expect(service.snapshot().session).toBeNull()
    expect(actor.historyStatus().lock_reason).toBeUndefined()
    expect(service.snapshot().sessions[0]).toMatchObject({ id: session.id, end_reason: 'user' })
    await run('one', add)
    expect(service.snapshot().activities.at(-1)?.session_id).toBeNull()
    expect(send.mock.calls.filter(([event]) => event === AGENT_VIEW_EVENT)).toHaveLength(1)
  })

  it('does not release a different connection’s newer lock or end its work', async () => {
    const { service, actor, run } = setup()
    await run('one', () => { service.begin('Edit'); service.lock('one') })
    await run('two', () => service.lock('two'))
    await expect(run('two', () => service.end('agent'))).rejects.toThrow('OwnerMismatch')
    service.end('disconnected', 'two')
    expect(service.snapshot().session).not.toBeNull()
    service.end('user')
    expect(actor.historyStatus().lock_reason).toBe('two')
    service.unlock()
    expect(actor.historyStatus().lock_reason).toBeUndefined()
  })

  it('closes on explicit disconnect but retains the actual running task outcome', async () => {
    const { service, run, add } = setup()
    const session = await run('one', () => service.begin('Import'))
    let release!: () => void
    const pending = run('one', async () => { await new Promise<void>(r => { release = r }); add() })
    service.end('disconnected', 'one')
    expect(service.snapshot().sessions[0]?.end_reason).toBe('disconnected')
    expect(service.snapshot().activities.at(-1)?.state).toBe('running')
    release()
    await pending
    expect(service.snapshot().activities.at(-1)).toMatchObject({ state: 'done', session_id: session.id })
  })
})

describe('structured activity', () => {
  it('attributes overlapping async commits to exactly the request that created them', async () => {
    const { service, run, add } = setup()
    let release!: () => void
    const pending = run('slow', async () => { await new Promise<void>(r => { release = r }); return add() })
    const fastId = await run('fast', add)
    release()
    const slowId = await pending
    const [slow, fast] = service.snapshot().activities
    expect(slow?.history_ids).toEqual([slowId])
    expect(fast?.history_ids).toEqual([fastId])
    expect(slow?.id).not.toBe(fast?.id)
    expect(slow?.label_key).toBeTruthy()
  })

  it('retains failures and reads through checkpoint restore and follows undo/redo effects', async () => {
    const { service, actor, run, add } = setup()
    const cp = actor.checkpoint('Before')
    await run('one', add)
    await service.run('one', 'One', 'resources/read', {}, true, () => ({}))
    await expect(run('one', () => { throw new Error('Analysis failed') })).rejects.toThrow()
    actor.restoreCheckpoint(cp)
    service.checkpoint('restore', cp, 'Before')
    expect(service.snapshot().activities.map(a => a.state)).toEqual(['done', 'done', 'error', 'done'])
    expect(service.snapshot().activities[0]?.effect).toBe('reverted')
    expect(service.snapshot().activities[1]?.effect).toBeNull()
    expect(actor.command('project_undo', {}).ok).toBe(true)
    expect(service.snapshot().activities[0]?.effect).toBe('applied')
    expect(actor.command('project_redo', {}).ok).toBe(true)
    expect(service.snapshot().activities[0]?.effect).toBe('reverted')
  })

  it('caps completed activities without losing running operations', async () => {
    const { service, run } = setup(2)
    let release!: () => void
    const pending = run('slow', () => new Promise<void>(r => { release = r }))
    for (let i = 0; i < 5; i++) await run('one', () => ({}))
    expect(service.snapshot().activities).toHaveLength(3)
    expect(service.snapshot().activities[0]?.state).toBe('running')
    expect(service.snapshot().evicted).toBe(3)
    release(); await pending
    expect(service.snapshot().activities).toHaveLength(2)
    expect(service.snapshot().evicted).toBe(4)
  })

  it('isolates reopened projects and discards late activity results from the old instance', async () => {
    const { actor, service, run } = setup()
    let release!: () => void
    const pending = run('one', () => new Promise<void>(r => { release = r }))
    const previous = service.snapshot()
    actor.replaceState(blankProject(seededGen(), 'New project'))
    release(); await pending
    const next = service.snapshot()
    expect(next.workspace_id).not.toBe(previous.workspace_id)
    expect(next.revision).toBeGreaterThan(previous.revision)
    expect(next.activities).toEqual([])
    expect(previous.activities[0]?.state).toBe('running') // snapshots are immutable copies
  })

  it('marks tool-level errors as failures and redacts credentials', async () => {
    const { service, run } = setup()
    await run('one', () => ({ isError: true, content: [{ text: 'Owner mismatch' }] }))
    expect(service.snapshot().activities[0]).toMatchObject({ state: 'error', error: 'Owner mismatch' })
    expect(activityDetails({ token: 'secret', nested: { api_key: 'secret' } })).toEqual({ token: '[redacted]', nested: { api_key: '[redacted]' } })
    expect(activityDetails('Authorization: Bearer private-token; api_key=private-key')).not.toContain('private')
    const wide = Array.from({ length: 100 }, () => ({ values: Array.from({ length: 100 }, () => '字'.repeat(1000)) }))
    expect(Buffer.byteLength(JSON.stringify(activityDetails(wide)))).toBeLessThanOrEqual(4096)
  })

  it('associates restore with its real history ID and does not associate unrecorded preferences', async () => {
    const { actor, service, run, add } = setup()
    const cp = actor.checkpoint('Before')
    await run('one', add)
    await run('one', () => { actor.restoreCheckpoint(cp); service.checkpoint('restore', cp, 'Before') }, 'restore_checkpoint')
    const restored = service.snapshot().activities.at(-1)!
    expect(restored.history_ids).toEqual([actor.historyView(1).ops[0]!.op_id])
    await run('one', () => actor.command('project_undo', {}), 'undo')
    expect(service.snapshot().activities.find(a => a.id === restored.id)?.effect).toBe('reverted')
    expect(service.snapshot().activities.at(-1)?.history_ids).toEqual([])
  })

  it('names read targets and all objects from a multi-commit call', async () => {
    const { actor, service, run, add } = setup()
    await run('one', () => { add(); add() })
    const activity = service.snapshot().activities[0]!
    expect(activity.history_ids).toHaveLength(2)
    expect(activity.affected).toHaveLength(2)
    expect(activity.entity_labels).toHaveLength(2)
    const track = Object.values(actor.snapshot().compositions)[0]!.tracks[0]!
    await service.run('one', 'One', 'read_track', { track_id: track.id }, true, () => ({}))
    expect(service.snapshot().activities.at(-1)?.affected).toEqual([{ kind: 'Track', id: track.id }])
  })
})
