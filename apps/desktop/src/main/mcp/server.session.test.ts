// apps/desktop/src/main/mcp/server.session.test.ts
// The work session over the tool surface. It owns the history lock: begin
// locks by default, the owner's own reverts pass, anyone else's are refused
// naming the holder. A connection that went away cannot hold `AgentSessionBusy`
// over every later one until the app restarts: the refusal names the holder,
// its reason and its age, `read_project { view: 'session' }` / `project://session`
// show it, and `begin_agent_session { force: true }` takes it over in one call.
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
    // Typed: no argument fixes a busy session, and the holder rides as data.
    expect(busy.structuredContent).toMatchObject({ code: 'invalid_request', error: 'AgentSessionBusy', holder: { client: 'client-one', connection_id: 'one', reason: 'Rough cut' } })
    expect(text(busy)).toContain('client-one')
    expect(text(busy)).toContain('"Rough cut"')
    expect(text(busy)).toContain('begin_agent_session { force: true }')
    expect(busy.structuredContent?.options).toContainEqual({ action: 'take_over', tool: 'begin_agent_session', force: true })
    // The view, as a tool and as a resource, names the same holder.
    const view = await call('two', 'read_project', { view: 'session' }) as Res
    expect(view.structuredContent).toMatchObject({ active: { client: 'client-one', reason: 'Rough cut' } })
    const res = await handleReadResource(backend, () => ts, 'project://session') as { contents: Array<{ text: string }> }
    expect(JSON.parse(res.contents[0]!.text)).toMatchObject({ active: { client: 'client-one' } })
    expect(sessionView({ agent }).active).toMatchObject({ connection_id: 'one' })
  })

  it('begin locks by default and answers it; lock: false does not', async () => {
    const { call, ts } = host()
    const began = await call('one', 'begin_agent_session', { reason: 'Rough cut' }) as Res
    expect(JSON.parse(text(began))).toMatchObject({ reason: 'Rough cut', locked: true })
    expect(ts.actor.historyStatus().lock_reason).toBe('Rough cut')
    const again = await call('one', 'begin_agent_session', { reason: 'Rough cut', lock: false }) as Res
    expect(JSON.parse(text(again))).toMatchObject({ locked: false })
    expect(ts.actor.historyStatus().lock_reason).toBeUndefined()
    // A repeat without `lock` leaves it as it is.
    expect(JSON.parse(text(await call('one', 'begin_agent_session', { reason: 'Rough cut' }))).locked).toBe(false)
    await call('one', 'end_agent_session')
    const free = await call('one', 'begin_agent_session', { reason: 'Look only', lock: false }) as Res
    expect(JSON.parse(text(free))).toMatchObject({ locked: false })
    expect(ts.actor.historyStatus().lock_reason).toBeUndefined()
  })

  it('a plain end from another connection is refused naming the holder; begin { force } takes over in one call', async () => {
    const { agent, call, ts } = host()
    await call('one', 'begin_agent_session', { reason: 'Rough cut' })
    expect(ts.actor.historyStatus().lock_reason).toBe('Rough cut')

    const mismatch = await call('two', 'end_agent_session') as Res
    expect(mismatch.isError).toBe(true)
    expect(mismatch.structuredContent).toMatchObject({ code: 'invalid_request', error: 'AgentSessionOwnerMismatch', holder: { client: 'client-one' } })
    expect(text(mismatch)).toContain('client-one')
    expect(agent.snapshot().session?.connection_id).toBe('one')
    // No takeover through end: the flag is gone, and an unknown argument refuses.
    expect((await call('two', 'end_agent_session', { force: true }) as Res).isError).toBe(true)

    const forced = await call('two', 'begin_agent_session', { reason: 'Other work', force: true }) as Res
    expect(forced.isError).toBeFalsy()
    // The answer is the newcomer's session, and names whose work was closed.
    expect(JSON.parse(text(forced))).toMatchObject({ connection_id: 'two', reason: 'Other work', locked: true,
      taken_over: { client: 'client-one', reason: 'Rough cut', end_reason: 'forced' } })
    expect(agent.snapshot().session?.connection_id).toBe('two')
    // The stale lock went with its session; the newcomer holds its own.
    expect(agent.lockHolder()).toMatchObject({ connection_id: 'two', reason: 'Other work' })
  })

  it("HistoryLocked names the holder to another connection; the owner's own undo passes", async () => {
    const { call } = host()
    await call('one', 'begin_agent_session', { reason: 'Rough cut' })
    await call('one', 'add_track', { label: 'x' })
    await call('one', 'add_track', { label: 'y' })
    const other = await call('two', 'undo') as Res
    expect(other.isError).toBe(true)
    expect(other.structuredContent).toMatchObject({ code: 'invalid_request', error: 'HistoryLocked', reason: 'Rough cut', holder: { client: 'client-one', connection_id: 'one' } })
    expect(text(other)).toContain('client-one')
    expect(text(other)).toContain('ask the user')
    expect(JSON.stringify(other.structuredContent)).not.toContain('unlock')
    const owner = await call('one', 'undo') as Res
    expect(owner.isError).toBeFalsy()
    expect(JSON.parse(text(owner))).toMatchObject({ undone: { summary: expect.any(String), actor: { kind: 'Agent' } } })
  })

  it('a dropped connection releases the session and its lock', async () => {
    const { call, agent, ts } = host()
    await call('one', 'begin_agent_session', { reason: 'Rough cut' })
    agent.end('disconnected', 'one')
    expect(agent.snapshot().session).toBeNull()
    expect(ts.actor.historyStatus().lock_reason).toBeUndefined()
    expect((await call('two', 'begin_agent_session', { reason: 'Next' }) as Res).isError).toBeFalsy()
  })

  it('end with no session answers ended: null', async () => {
    const { call, agent } = host()
    const r = await call('two', 'end_agent_session') as Res
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(text(r))).toEqual({ ended: null })
    expect(agent.snapshot().session).toBeNull()
  })
})
