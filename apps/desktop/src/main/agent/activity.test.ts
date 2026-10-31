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
    await expect(run('two', () => service.begin('Other job'))).rejects.toMatchObject({ variant: 'AgentSessionBusy', code: 'invalid_request', holder: { connection_id: 'one' } })
    expect(service.snapshot().session?.id).toBe(first.id)
    expect(service.snapshot().activities.at(-1)?.session_id).toBeNull()
  })

  it('local end releases its lock, preserves records, and permits later operations', async () => {
    const { service, actor, run, add, send } = setup()
    const session = await run('one', () => service.begin('Edit'))
    expect(actor.historyStatus().lock_reason).toBe('Edit')
    service.end('user')
    expect(service.snapshot().session).toBeNull()
    expect(actor.historyStatus().lock_reason).toBeUndefined()
    expect(service.snapshot().sessions[0]).toMatchObject({ id: session.id, end_reason: 'user' })
    await run('one', add)
    expect(service.snapshot().activities.at(-1)?.session_id).toBeNull()
    expect(send.mock.calls.filter(([event]) => event === AGENT_VIEW_EVENT)).toHaveLength(1)
  })

  it('locks history by default, and not with lock: false', async () => {
    const { service, actor, run } = setup()
    await run('one', () => service.begin('Cut'))
    expect(service.lockHolder()).toMatchObject({ connection_id: 'one', reason: 'Cut' })
    service.end('user')
    await run('one', () => service.begin('Look', { lock: false }))
    expect(actor.historyStatus().lock_reason).toBeUndefined()
    expect(service.lockHolder()).toBeNull()
    // A repeat on the same connection changes the lock only when `lock` is passed.
    await run('one', () => service.begin('Look'))
    expect(actor.historyStatus().lock_reason).toBeUndefined()
    await run('one', () => service.begin('Look', { lock: true }))
    expect(actor.historyStatus().lock_reason).toBe('Look')
  })

  it("the owner's undo works under its own lock; another connection's and the user's are refused", async () => {
    const { service, actor, run, add } = setup()
    await run('one', () => service.begin('Cut'))
    await run('one', add)
    await run('one', add)
    const undo = () => actor.mcpCall('undo', '{}', 'client')
    const own = await run('one', undo)
    expect(own.ok).toBe(true)
    const other = await run('two', undo)
    expect(other).toMatchObject({ ok: false, error: { code: 'invalid_request', data: { error: 'HistoryLocked', reason: 'Cut' } } })
    expect(actor.command('project_undo', {})).toMatchObject({ ok: false, error: { error: 'HistoryLocked' } })
    // The owner's restore of its own Pre-agent checkpoint, too.
    const cp = service.snapshot().session!.checkpoint_id
    expect((await run('one', () => actor.mcpCall('restore_checkpoint', JSON.stringify({ checkpoint_id: cp }), 'client'))).ok).toBe(true)
  })

  it('a dropped connection releases its session and its lock', async () => {
    const { service, actor, run } = setup()
    await run('one', () => service.begin('Edit'))
    service.end('disconnected', 'two')
    expect(actor.historyStatus().lock_reason).toBe('Edit')
    service.end('disconnected', 'one')
    expect(service.snapshot().session).toBeNull()
    expect(actor.historyStatus().lock_reason).toBeUndefined()
  })

  it('force takes another connection’s session over in one call', async () => {
    const { service, actor, run } = setup()
    const stale = await run('one', () => service.begin('Old'))
    await expect(run('two', () => service.end('agent'))).rejects.toMatchObject({ variant: 'AgentSessionOwnerMismatch', code: 'invalid_request' })
    const mine = await run('two', () => service.begin('New', { force: true }))
    expect(mine.connection_id).toBe('two')
    expect(service.snapshot().sessions.find((s) => s.id === stale.id)).toMatchObject({ end_reason: 'forced' })
    expect(service.lockHolder()).toMatchObject({ connection_id: 'two', reason: 'New' })
    expect(actor.listCheckpoints().map((c) => c.label)).toEqual(['Pre-agent: Old', 'Pre-agent: New'])
  })

  it("the user's Unlock opens history while the session runs on", async () => {
    const { service, actor, run } = setup()
    await run('one', () => service.begin('Edit'))
    service.unlock()
    expect(actor.historyStatus().lock_reason).toBeUndefined()
    expect(service.snapshot().session).not.toBeNull()
    expect(service.lockHolder()).toBeNull()
    // The user's action wins over a repeat begin that does not pass `lock`…
    await run('one', () => service.begin('Edit'))
    expect(actor.historyStatus().lock_reason).toBeUndefined()
    // …while an explicit `lock: true` (visible in the panel) locks again.
    await run('one', () => service.begin('Edit', { lock: true }))
    expect(actor.historyStatus().lock_reason).toBe('Edit')
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

  it('a cancelled clip-compute job ends as cancelled, not as a failure', async () => {
    const { service, run } = setup()
    await run('one', () => ({ isError: true, content: [{ type: 'text', text: 'Cancelled' }], structuredContent: { code: 'cancelled', message: 'Cancelled' } }))
    expect(service.snapshot().activities[0]).toMatchObject({ state: 'cancelled', error: null })
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

// ADR 0121: a long clip-compute call keeps its row on the job's live phase, and
// a connection that closes under it flags the row instead of ending it — the
// row ends when the call does, whenever the job finishes.
describe('long calls', () => {
  it('carries the job and phase onto the running row, and leaves ended rows alone', async () => {
    const { service, run } = setup()
    let release!: () => void
    let id = ''
    const call = run('one', () => {
      id = service.currentCall()!.activity_id
      return new Promise<void>(resolve => { release = resolve })
    }, 'transcribe_clip')
    service.setCompute(id, { job_id: 'job-1', phase: { kind: 'loading_model' }, phase_since: 't1' })
    expect(service.snapshot().activities.at(-1)).toMatchObject({ state: 'running', compute: { job_id: 'job-1', phase: { kind: 'loading_model' } } })
    release()
    await call
    service.setCompute(id, { job_id: 'job-1', phase: { kind: 'inferring' }, phase_since: 't2' })
    expect(service.snapshot().activities.at(-1)).toMatchObject({ state: 'done', compute: { phase: { kind: 'loading_model' } } })
  })

  it('flags the running calls of a closed connection, which then end with their work', async () => {
    const { service, run } = setup()
    let release!: () => void
    const call = run('one', () => new Promise<void>(resolve => { release = resolve }), 'describe_clip')
    const other = run('two', () => new Promise<void>(() => {}), 'describe_clip')
    void other
    service.end('disconnected', 'one')
    const rows = service.snapshot().activities
    expect(rows.find(a => a.connection_id === 'one')).toMatchObject({ state: 'running', caller_disconnected: true })
    expect(rows.find(a => a.connection_id === 'two')?.caller_disconnected).toBeUndefined()
    release()
    await call
    expect(service.snapshot().activities.find(a => a.connection_id === 'one')).toMatchObject({ state: 'done', caller_disconnected: true })
  })
})
