// apps/desktop/src/main/mcp/server.tacks.test.ts
// The tack surface over MCP (ADR 0115): three verbs and two reads served by the
// host's TackStore, never by the actor — so no history, no commit, and the
// history lock does not apply.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { handleCallTool, handleReadResource } from './server'
import { AgentActivityService } from '../agent/activity'
import { createActor } from '../state/actor'
import { seededGen } from '../state/ids'
import { blankProject, rootComposition } from '../state/model'
import { applyAddLayer } from '../state/mutations/add'
import { mediaItemTemplate, videoClipParams } from '../state/mutations/media'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const MEDIA = '00000000-0000-0000-0000-0000000000cc'
const MISSING = '00000000-0000-7000-8000-00000000dead'

function host(tackCapacity?: number) {
  const ids = seededGen()
  const p = blankProject(ids, 'tacks')
  p.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10_000_000)
  const clip = applyAddLayer(p, ids, rootComposition(p).tracks[0].id, videoClipParams(MEDIA, 2_000_000, 6_000_000), 1_000_000, 5_000_000)
  const actor = createActor({ initial: p, idGen: ids, clock: () => '<TS>' })
  const agent = new AgentActivityService(actor, vi.fn(), undefined, tackCapacity)
  agent.start()
  const ts = {
    actor, agent,
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    motifTool: () => [], handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
  const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => { throw new Error('rust must not be read') }, mcpCatalog: async () => RUST_CATALOG } as any
  const call = (name: string, args: Record<string, unknown> = {}, connection = 'one') =>
    agent.run(connection, `client-${connection}`, name, args, false, () => handleCallTool(backend, () => ts, name, args)) as Promise<Res>
  const read = async (uri: string) => JSON.parse(((await handleReadResource(backend, () => ts, uri)) as any).contents[0].text)
  return { actor, agent, clip, call, read, backend, ts, rootId: p.root_id }
}
type Res = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any> }

describe('create_tacks / update_tack / delete_tacks', () => {
  it('create a batch, read it back through the tool and the resource, update and delete it', async () => {
    const h = host()
    const created = await h.call('create_tacks', { tacks: [
      { label: 'Long pause', t_us: 2_000_000, end_t_us: 3_000_000, anchor_layer_id: h.clip, kind: 'issue' },
      { label: 'Music in?', body: 'Swell here or later', t_us: 4_000_000, kind: 'question' },
    ] })
    expect(created.isError).toBeFalsy()
    const ids = created.structuredContent!.tack_ids as string[]
    expect(ids).toHaveLength(2)
    expect(JSON.parse(created.content[0]!.text)).toEqual({ tack_ids: ids })

    const viaTool = JSON.parse((await h.call('read_project', { view: 'tacks' })).content[0]!.text)
    expect(viaTool).toEqual(await h.read('project://tacks'))
    expect(viaTool).toMatchObject([
      { id: ids[0], kind: 'issue', status: 'open', state: 'visible', t_us: 2_000_000, end_t_us: 3_000_000, client: 'client-one',
        range: { kind: 'anchored', layer_id: h.clip, src_us: 3_000_000, src_end_us: 4_000_000 } },
      { id: ids[1], kind: 'question', body: 'Swell here or later', range: { kind: 'free', composition_id: h.rootId, t_us: 4_000_000, end_t_us: null } },
    ])
    expect(await h.read(`project://tacks?composition=${h.rootId}`)).toHaveLength(2)

    const updated = await h.call('update_tack', { tack_id: ids[0], patch: { status: 'resolved' } })
    expect(updated.structuredContent).toMatchObject({ id: ids[0], status: 'resolved', label: 'Long pause', state: 'visible' })

    const deleted = await h.call('delete_tacks', { tack_ids: [ids[1]] })
    expect(deleted.structuredContent).toEqual({ deleted_tack_ids: [ids[1]] })
    expect((await h.read('project://tacks')).map((t: { id: string }) => t.id)).toEqual([ids[0]])
  })

  it('records nothing, commits nothing and answers while history is locked', async () => {
    const h = host()
    await h.call('set_history_lock', { locked: true, reason: 'cutting' })
    const before = h.actor.snapshot()
    const len = h.actor.historyStatus().len
    const created = await h.call('create_tacks', { tacks: [{ label: 'x', t_us: 0 }] })
    expect(created.isError).toBeFalsy()
    const id = created.structuredContent!.tack_ids[0]
    expect((await h.call('update_tack', { tack_id: id, patch: { kind: 'issue' } })).isError).toBeFalsy()
    expect((await h.call('delete_tacks', { tack_ids: [id] })).isError).toBeFalsy()
    expect(h.actor.snapshot()).toBe(before)
    expect(h.actor.historyStatus().len).toBe(len)
  })

  it('delete by work session removes exactly that session’s tacks', async () => {
    const h = host()
    const session = (await h.call('begin_agent_session', { reason: 'Pauses' })).structuredContent!
    const mine = (await h.call('create_tacks', { tacks: [{ label: 'a', t_us: 0 }, { label: 'b', t_us: 0 }] })).structuredContent!.tack_ids
    const other = (await h.call('create_tacks', { tacks: [{ label: 'c', t_us: 0 }] }, 'two')).structuredContent!.tack_ids
    const out = await h.call('delete_tacks', { session_id: session.id })
    expect([...out.structuredContent!.deleted_tack_ids].sort()).toEqual([...mine].sort())
    expect((await h.read('project://tacks')).map((t: { id: string }) => t.id)).toEqual(other)
  })
})

describe('refusals change nothing and name what to fix', () => {
  it('a batch with one bad entry creates none', async () => {
    const h = host()
    const out = await h.call('create_tacks', { tacks: [{ label: 'ok', t_us: 0 }, { label: 'off the clip', t_us: 8_000_000, anchor_layer_id: h.clip }] })
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params', error: 'InvalidArgument', field: 't_us' })
    expect(out.content[0]!.text).toContain('tacks[1].t_us')
    expect(await h.read('project://tacks')).toEqual([])
  })

  it('argument shape errors are invalid_params at the boundary', async () => {
    const h = host()
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['create_tacks', { tacks: [] }, /names nothing/],
      ['create_tacks', { tacks: [{ label: '  ', t_us: 0 }] }, /tacks\[0\]\.label must be non-empty/],
      ['create_tacks', { tacks: [{ label: 'x', t_us: 0, color: 'red' }] }, /unknown key 'color'/],
      ['create_tacks', { tacks: [{ label: 'x', t_us: 0.5 }] }, /must be an integer/],
      ['create_tacks', { tacks: [{ label: 'x', t_us: 0, kind: 'todo' }] }, /kind must be one of/],
      ['create_tacks', { tacks: [{ label: 'x'.repeat(201), t_us: 0 }] }, /at most 200/],
      ['update_tack', { tack_id: MISSING, patch: {} }, /at least one/],
      ['update_tack', { tack_id: MISSING, patch: { status: 'closed' } }, /status must be one of/],
      ['update_tack', { tack_id: MISSING, patch: { label: 'x' } }, /not found/],
      ['delete_tacks', {}, /exactly one of/],
      ['delete_tacks', { tack_ids: [MISSING], session_id: MISSING }, /exactly one of/],
      ['delete_tacks', { tack_ids: [MISSING] }, /not found/],
      ['read_project', { view: 'tacks', composition_id: MISSING }, /not found/],
    ]
    for (const [name, args, message] of cases) {
      const out = await h.call(name, args)
      expect(out.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(out.structuredContent?.code, name).toBe('invalid_params')
      expect(out.content[0]!.text).toMatch(message)
    }
  })

  it('TackLimit is invalid_request and keeps every existing tack', async () => {
    const h = host(2)
    await h.call('create_tacks', { tacks: [{ label: 'a', t_us: 0 }] })
    const out = await h.call('create_tacks', { tacks: [{ label: 'b', t_us: 0 }, { label: 'c', t_us: 0 }] })
    expect(out.structuredContent).toMatchObject({ code: 'invalid_request', error: 'TackLimit' })
    expect(out.content[0]!.text).toContain('delete_tacks')
    expect(await h.read('project://tacks')).toHaveLength(1)
  })

  it('the resource refuses an unknown query key or composition', async () => {
    const h = host()
    await expect(handleReadResource(h.backend, () => h.ts, 'project://tacks?track=x')).rejects.toThrow(/unknown query key/)
    await expect(handleReadResource(h.backend, () => h.ts, `project://tacks?composition=${MISSING}`)).rejects.toThrow(/not found/)
  })

  it('a bare actor checks the arguments and says the host serves tacks', () => {
    const h = host()
    const r = h.actor.mcpCall('create_tacks', JSON.stringify({ tacks: [{ label: 'x', t_us: 0 }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('served by the MCP host')
    const v = h.actor.mcpCall('read_project', JSON.stringify({ view: 'tacks' }))
    expect(v.ok).toBe(false)
  })
})
