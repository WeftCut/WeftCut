// apps/desktop/src/main/mcp/server.tacks.test.ts
// The tack surface over MCP (ADR 0115, ADR 0117): three verbs and two reads served by the
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
      { label: 'Long pause', t_us: 2_000_000, end_t_us: 3_000_000, kind: 'issue' },
      { label: 'Music in?', body: 'Swell here or later', t_us: 4_000_000, kind: 'question' },
    ] })
    expect(created.isError).toBeFalsy()
    const ids = created.structuredContent!.tack_ids as string[]
    expect(ids).toHaveLength(2)
    expect(JSON.parse(created.content[0]!.text)).toEqual({ tack_ids: ids })

    const viaTool = JSON.parse((await h.call('read_project', { view: 'tacks' })).content[0]!.text)
    expect(viaTool).toEqual(await h.read('project://tacks'))
    expect(viaTool).toMatchObject([
      { id: ids[0], kind: 'issue', status: 'open', t_us: 2_000_000, end_t_us: 3_000_000, outdated: false, client: 'client-one',
        range: { composition_id: h.rootId, t_us: 2_000_000, end_t_us: 3_000_000 },
        follows: { layer_id: h.clip, src_us: 3_000_000, t_us: 2_000_000 } },
      { id: ids[1], kind: 'question', body: 'Swell here or later', outdated: false,
        range: { composition_id: h.rootId, t_us: 4_000_000, end_t_us: null } },
    ])
    expect(await h.read(`project://tacks?composition=${h.rootId}`)).toHaveLength(2)

    const updated = await h.call('update_tack', { tack_id: ids[0], patch: { status: 'resolved' } })
    expect(updated.structuredContent).toMatchObject({ id: ids[0], status: 'resolved', label: 'Long pause', t_us: 2_000_000 })

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
    const out = await h.call('create_tacks', { tacks: [{ label: 'ok', t_us: 0 }, { label: 'backwards', t_us: 3_000_000, end_t_us: 2_000_000 }] })
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params', error: 'InvalidArgument', field: 'end_t_us' })
    expect(out.content[0]!.text).toContain('tacks[1].end_t_us')
    expect(await h.read('project://tacks')).toEqual([])
  })

  it('argument shape errors are invalid_params at the boundary', async () => {
    const h = host()
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['create_tacks', { tacks: [] }, /names nothing/],
      ['create_tacks', { tacks: [{ label: '  ', t_us: 0 }] }, /tacks\[0\]\.label must be non-empty/],
      ['create_tacks', { tacks: [{ label: 'x', t_us: 0, color: 'red' }] }, /unknown key 'color'/],
      ['create_tacks', { tacks: [{ label: 'x', t_us: 0, anchor_layer_id: MISSING }] }, /unknown key 'anchor_layer_id'/],
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

describe('harness feedback', () => {
  it('create_tacks hints at times in the text and at tacks that cover nothing', async () => {
    const h = host()
    const out = await h.call('create_tacks', { tacks: [
      { label: 'Breath before the answer', t_us: 2_000_000, end_t_us: 3_000_000 },
      { label: 'Pause at 0:12', t_us: 2_000_000 },
      { label: 'Breath', body: '大约4秒的停顿', t_us: 2_500_000 },
      { label: 'Music in?', t_us: 7_000_000, end_t_us: 8_000_000 },
    ] })
    expect(out.structuredContent).not.toHaveProperty('follows')
    const hints = out.structuredContent!.hints as string[]
    expect(hints).toHaveLength(3)
    expect(hints[0]).toMatch(/^tacks\[1\] mentions a time \("0:12"\).*describe the content/)
    expect(hints[1]).toMatch(/^tacks\[2\] mentions a time \("4秒"\)/)
    expect(hints[2]).toMatch(/^tacks\[3\] covers no clip/)
    const clean = await h.call('create_tacks', { tacks: [{ label: 'Two shots of the same take', body: 'Keep the 4K one?', t_us: 2_900_000 }] })
    expect(clean.structuredContent).not.toHaveProperty('hints')
  })

  it('create_tacks hints when a tack sits where one of the same client’s open tacks does', async () => {
    const h = host()
    const first = await h.call('create_tacks', { tacks: [
      { label: 'Breath before the answer', t_us: 2_000_000, end_t_us: 3_000_000 },
      { label: 'Same breath', t_us: 2_100_000, end_t_us: 2_900_000 },
      { label: 'A point inside it', t_us: 2_100_000 },
    ] })
    const [a] = first.structuredContent!.tack_ids as string[]
    // The second matches the first within the batch; a point never matches a range.
    expect(first.structuredContent!.hints).toEqual([expect.stringMatching(new RegExp(`^tacks\\[1\\] sits where open tack ${a} \\("Breath before the answer"\\)`))])
    // Across calls, against the caller's open tacks only.
    const again = await h.call('create_tacks', { tacks: [{ label: 'Again', t_us: 2_000_000, end_t_us: 3_000_000 }] })
    expect(again.structuredContent!.hints).toEqual([expect.stringMatching(/^tacks\[0\] sits where open tack/)])
    await h.call('update_tack', { tack_id: a, patch: { status: 'resolved' } })
    const apart = await h.call('create_tacks', { tacks: [{ label: 'Later', t_us: 2_400_000, end_t_us: 3_000_000 }] })
    expect(apart.structuredContent).not.toHaveProperty('hints')
  })

  it('a committing call reports the caller’s own changed open tacks, and nothing otherwise', async () => {
    const h = host()
    const track = h.ts.actor.snapshot().compositions[h.rootId].tracks[0].id
    const [mine] = (await h.call('create_tacks', { tacks: [{ label: 'mine', t_us: 2_000_000 }] })).structuredContent!.tack_ids
    const [theirs] = (await h.call('create_tacks', { tacks: [{ label: 'theirs', t_us: 3_000_000 }] }, 'two')).structuredContent!.tack_ids

    const moved = await h.call('move_layer', { layer_id: h.clip, new_t_start_us: 2_000_000, new_track_id: track })
    expect(moved.structuredContent!.affected_tacks).toEqual([{ tack_id: mine, label: 'mine', change: 'moved' }])
    expect(JSON.parse(moved.content[0]!.text).affected_tacks).toEqual(moved.structuredContent!.affected_tacks)

    // Connection two's trim takes the frame under its own tack; only two hears about it.
    const trimmed = await h.call('trim_layer', { layer_id: h.clip, edge: 'out', new_t_us: 4_000_000 }, 'two')
    expect(trimmed.structuredContent!.affected_tacks).toEqual([{ tack_id: theirs, label: 'theirs', change: 'outdated' }])

    // A call that changes none of the caller's tacks, a read, and a refusal carry no field.
    const added = await h.call('add_track', { label: 'More' })
    expect(added.structuredContent).not.toHaveProperty('affected_tacks')
    expect(JSON.parse(added.content[0]!.text)).not.toHaveProperty('affected_tacks')
    const read = await h.agent.run('one', 'client-one', 'read_project', { view: 'tacks' }, true, () => handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'tacks' })) as Res
    expect(read.content).toHaveLength(1)
    const refused = await h.call('trim_layer', { layer_id: h.clip, edge: 'out', new_t_us: 99_000_000 })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).not.toContain('affected_tacks')
  })

  it('end_agent_session lists the client’s open outdated tacks', async () => {
    const h = host()
    await h.call('begin_agent_session', { reason: 'Pauses' })
    const [gone, resolved, fine] = (await h.call('create_tacks', { tacks: [
      { label: 'on the clip', t_us: 2_000_000 },
      { label: 'resolved one', t_us: 3_000_000 },
      { label: 'over a gap', t_us: 7_000_000 },
    ] })).structuredContent!.tack_ids
    await h.call('update_tack', { tack_id: resolved, patch: { status: 'resolved' } })
    const deleted = await h.call('delete_layers', { layer_ids: [h.clip] })
    expect(deleted.structuredContent!.affected_tacks).toEqual([{ tack_id: gone, label: 'on the clip', change: 'outdated' }])
    const ended = await h.call('end_agent_session', {})
    expect(ended.structuredContent!.tacks_to_review).toEqual([{ tack_id: gone, label: 'on the clip' }])
    expect(fine).toBeDefined()

    // A later session still hears about an earlier one's outdated tack — that
    // is usually what outdated it — until it is resolved; another client never does.
    await h.call('begin_agent_session', { reason: 'Again' })
    expect((await h.call('end_agent_session', {})).structuredContent!.tacks_to_review).toEqual([{ tack_id: gone, label: 'on the clip' }])
    await h.call('begin_agent_session', { reason: 'Theirs' }, 'two')
    expect((await h.call('end_agent_session', {}, 'two')).structuredContent).not.toHaveProperty('tacks_to_review')
    await h.call('update_tack', { tack_id: gone, patch: { status: 'resolved' } })
    await h.call('begin_agent_session', { reason: 'Done' })
    expect((await h.call('end_agent_session', {})).structuredContent).not.toHaveProperty('tacks_to_review')
  })
})
