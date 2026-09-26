// apps/desktop/src/main/mcp/server.session.test.ts
// The work session's escape hatches over the tool surface, so a connection that
// went away cannot hold `AgentSessionBusy` over every later one until the app
// restarts: the refusal names the holder, its reason and its age, `read_project
// { view: 'session' }` / `project://session` show it, and `end_agent_session
// { force: true }` takes it over — lock included.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { handleCallTool, handleReadResource, sessionView } from './server'
import { AgentActivityService } from '../agent/activity'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { root } from '../state/__tests__/fixtures/project'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')

function host() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'session'), idGen, clock: () => '<TS>' })
  const agent = new AgentActivityService(actor, vi.fn())
  agent.start()
  const ts = {
    actor, agent,
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    hybridDeps: { actor, compute: {}, enqueueDerivatives: vi.fn(), enqueueWorkspaceCopy: vi.fn(), workspaceDir: () => null, readFile: () => '', snapshotComposition: () => root(actor.snapshot()) },
    motifTool: () => [], handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
  const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => '{"ok":true,"result":{}}', mcpCatalog: async () => RUST_CATALOG } as any
  /** A call as the activity service sees it: attributed to `connection`. */
  const call = (connection: string, name: string, args: Record<string, unknown> = {}) =>
    agent.run(connection, `client-${connection}`, name, args, false, () => handleCallTool(backend, () => ts, name, args))
  return { ts, agent, backend, call }
}
type Res = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }
const text = (r: unknown) => (r as Res).content[0]!.text

describe('the work session names its holder and can be taken over', () => {
  it('a second connection is refused with the holder named, and the session view shows it', async () => {
    const { agent, call, ts, backend } = host()
    const began = await call('one', 'begin_agent_session', { reason: 'Rough cut' }) as Res
    expect(began.isError).toBeFalsy()
    const busy = await call('two', 'begin_agent_session', { reason: 'Other work' }) as Res
    expect(busy.isError).toBe(true)
    expect(text(busy)).toContain('AgentSessionBusy')
    expect(text(busy)).toContain('client-one')
    expect(text(busy)).toContain('"Rough cut"')
    expect(text(busy)).toContain('end_agent_session { force: true }')
    // The view, as a tool and as a resource, names the same holder.
    const view = await call('two', 'read_project', { view: 'session' }) as Res
    expect(view.structuredContent).toMatchObject({ active: { client: 'client-one', reason: 'Rough cut' } })
    const res = await handleReadResource(backend, () => ts, 'project://session') as { contents: Array<{ text: string }> }
    expect(JSON.parse(res.contents[0]!.text)).toMatchObject({ active: { client: 'client-one' } })
    expect(sessionView({ agent }).active).toMatchObject({ connection_id: 'one' })
  })

  it('a plain end from another connection is refused naming the holder; force ends it and releases its lock', async () => {
    const { agent, call, ts } = host()
    await call('one', 'begin_agent_session', { reason: 'Rough cut' })
    await call('one', 'set_history_lock', { locked: true, reason: 'cutting' })
    expect(ts.actor.historyStatus().lock_reason).toBe('cutting')

    const mismatch = await call('two', 'end_agent_session') as Res
    expect(mismatch.isError).toBe(true)
    expect(text(mismatch)).toContain('AgentSessionOwnerMismatch')
    expect(text(mismatch)).toContain('client-one')
    expect(agent.snapshot().session?.connection_id).toBe('one')

    const forced = await call('two', 'end_agent_session', { force: true }) as Res
    expect(forced.isError).toBeFalsy()
    // The answer names whose work was closed, and how.
    expect(JSON.parse(text(forced))).toMatchObject({ ended: { client: 'client-one', reason: 'Rough cut', end_reason: 'forced' } })
    expect(agent.snapshot().session).toBeNull()
    expect(agent.snapshot().sessions.at(-1)?.end_reason).toBe('forced')
    // The lock went with it — a lock with no live owner blocks undo for nobody.
    expect(ts.actor.historyStatus().lock_reason).toBeUndefined()
    // And the newcomer can begin.
    const began = await call('two', 'begin_agent_session', { reason: 'Other work' }) as Res
    expect(began.isError).toBeFalsy()
    expect(agent.snapshot().session?.connection_id).toBe('two')
  })

  it('force on an idle project is a harmless no-op', async () => {
    const { call, agent } = host()
    const r = await call('two', 'end_agent_session', { force: true }) as Res
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(text(r))).toEqual({ ended: null })
    expect(agent.snapshot().session).toBeNull()
  })
})
