import { describe, expect, it, vi } from 'vitest'
import { createTsActorHost } from '../state/ts-actor-host'
import { rootComposition } from '../state/model'
import { AGENT_ACTIVITY_EVENT, type AgentActivityUpdate } from '../../shared/agent-activity'

// The panel's tack actions, end to end through the host's channel routing:
// the same TackStore and delta the MCP verbs use, and never a history entry.
function makeHost() {
  const send = vi.fn()
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  const host = createTsActorHost({
    send, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: () => '',
    statPath: () => ({ kind: 'file' as const, readable: true }),
    workspaceDir: () => null as string | null,
  } as any)
  host.start()
  const create = async (labels: string[], session = false) => host.agent.run('conn', 'Client', 'create_tacks', {}, false, () => {
    if (session) host.agent.begin('Review')
    return host.agent.tacks.create(labels.map((label) => ({ label, body: '', kind: 'note' as const, t_us: 0, end_t_us: null, anchor_layer_id: null, composition_id: null })))
  })
  const statuses = () => Object.fromEntries(host.agent.tacks.views().map((t) => [t.label, t.status]))
  return { host, send, create, statuses }
}
const flush = () => new Promise<void>((r) => queueMicrotask(r))

describe('panel tack actions', () => {
  it('resolve, dismiss and reopen through the activity delta without recording history', async () => {
    const { host, send, create, statuses } = makeHost()
    const [a, b] = await create(['A', 'B'])
    const before = host.actor.historyStatus()
    await flush(); send.mockClear()
    await host.handleInvoke('agent_tacks_set_status', { tack_ids: [a], status: 'resolved' })
    await host.handleInvoke('agent_tacks_set_status', { tack_ids: [b], status: 'dismissed' })
    expect(statuses()).toEqual({ A: 'resolved', B: 'dismissed' })
    await host.handleInvoke('agent_tacks_set_status', { tack_ids: [a], status: 'open' })
    expect(statuses()).toEqual({ A: 'open', B: 'dismissed' })
    await flush()
    const updates = send.mock.calls.filter(([e]) => e === AGENT_ACTIVITY_EVENT).map(([, u]) => u as AgentActivityUpdate)
    expect(updates.flatMap((u) => u.tacks.map((t) => t.id))).toEqual(expect.arrayContaining([a, b]))
    expect(host.actor.historyStatus()).toEqual(before)
    host.stop()
  })

  it('refuses an unknown id or status before changing anything', async () => {
    const { host, create, statuses } = makeHost()
    const [a] = await create(['A'])
    await expect(host.handleInvoke('agent_tacks_set_status', { tack_ids: [a, 'gone'], status: 'resolved' })).rejects.toThrow(/no longer exists/)
    await expect(host.handleInvoke('agent_tacks_set_status', { tack_ids: [a], status: 'done' })).rejects.toThrow(/status/)
    await expect(host.handleInvoke('agent_tacks_delete', { tack_ids: [a], statuses: ['open'] })).rejects.toThrow(/exactly one/)
    expect(statuses()).toEqual({ A: 'open' })
    host.stop()
  })

  it('clears by ids, by work session (null: outside one) and by status', async () => {
    const { host, create, statuses } = makeHost()
    const [inSession] = await create(['S'], true)
    const [outside, closed] = await (async () => { host.agent.end('user'); return create(['O', 'C']) })()
    await host.handleInvoke('agent_tacks_set_status', { tack_ids: [closed], status: 'dismissed' })
    expect(await host.handleInvoke('agent_tacks_delete', { statuses: ['resolved', 'dismissed'] })).toEqual({ deleted_tack_ids: [closed] })
    const session = host.agent.tacks.views().find((t) => t.id === inSession)!.session_id
    expect(session).not.toBeNull()
    expect(await host.handleInvoke('agent_tacks_delete', { session_id: null })).toEqual({ deleted_tack_ids: [outside] })
    expect(statuses()).toEqual({ S: 'open' })
    expect(await host.handleInvoke('agent_tacks_delete', { session_id: session })).toEqual({ deleted_tack_ids: [inSession] })
    expect(statuses()).toEqual({})
    host.stop()
  })

  it('the convert path: add_marker carries label, note and anchor as one recorded, undoable entry', async () => {
    const { host } = makeHost()
    const before = host.actor.historyStatus().len
    await host.handleInvoke('add_marker', { tUs: 0, endTUs: null, label: 'Pause', note: 'Keep it?', compositionId: null, anchor: null })
    const [marker] = rootComposition(host.actor.snapshot()).markers
    expect(marker).toMatchObject({ label: 'Pause', note: 'Keep it?', anchor: null })
    expect(host.actor.historyStatus().len).toBe(before + 1)
    await host.handleInvoke('project_undo', {})
    expect(rootComposition(host.actor.snapshot()).markers).toEqual([])
    host.stop()
  })
})
