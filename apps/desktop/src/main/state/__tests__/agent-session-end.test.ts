import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

function makeDeps(overrides: { send?: (event: string, payload: unknown) => void } = {}) {
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  return {
    send: () => {}, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: () => '',
    statPath: () => ({ kind: 'file' as const, readable: true }),
    workspaceDir: () => null as string | null,
    ...overrides,
  }
}

describe('host agent lifecycle', () => {
  it('manual entry requests a view without a session, checkpoint, or unlock', async () => {
    const send = vi.fn()
    const host = createTsActorHost(makeDeps({ send }))
    host.start()
    host.actor.lockHistory('Keep locked')
    await host.handleInvoke('agent_session_begin', {})
    expect(host.actor.listCheckpoints()).toEqual([])
    expect(host.agent.snapshot().session).toBeNull()
    expect(host.actor.historyStatus().lock_reason).toBe('Keep locked')
    expect(send).toHaveBeenCalledWith('agent_view:enter', expect.any(Object))
    host.stop()
  })

  it('local end releases only the active work session lock and keeps the view', async () => {
    const send = vi.fn()
    const host = createTsActorHost(makeDeps({ send }))
    host.start()
    await host.agent.run('connection', 'Client', 'begin_agent_session', {}, false, () => {
      host.agent.begin('Edit')
      host.agent.lock('')
    })
    send.mockClear()
    await host.handleInvoke('agent_session_end', {})
    expect(host.agent.snapshot().session).toBeNull()
    expect(host.actor.historyStatus().lock_reason).toBeUndefined()
    expect(send.mock.calls.some(([name]) => name === 'agent_view:enter')).toBe(false)
    host.stop()
  })

  it('ending no session does not silently unlock unrelated history', async () => {
    const host = createTsActorHost(makeDeps())
    host.start()
    host.actor.lockHistory('Other work')
    await host.handleInvoke('agent_session_end', {})
    expect(host.actor.historyStatus().lock_reason).toBe('Other work')
    await host.handleInvoke('agent_unlock_history', {})
    expect(host.actor.historyStatus().lock_reason).toBeUndefined()
    host.stop()
  })
})
