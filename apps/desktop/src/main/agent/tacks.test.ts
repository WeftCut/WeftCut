import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentActivityService } from './activity'
import { TackError, type TackInput } from './tacks'
import { createActor } from '../state/actor'
import { blankProject, rootComposition } from '../state/model'
import { seededGen } from '../state/ids'
import { applyAddLayer } from '../state/mutations/add'
import { mediaItemTemplate, videoClipParams } from '../state/mutations/media'
import { withGroup } from '../state/__tests__/fixtures/project'
import { AGENT_ACTIVITY_EVENT, type AgentActivityUpdate } from '../../shared/agent-activity'

const MEDIA = '00000000-0000-0000-0000-0000000000cc'
const stops: Array<() => void> = []
afterEach(() => { stops.splice(0).forEach(stop => stop()) })

/** A 10 s video item placed as source [2 s, 6 s) at timeline [1 s, 5 s) on the
 *  A roll of a 30 fps root, under a real actor and activity service. */
function setup(capacity?: number) {
  const ids = seededGen()
  const p = blankProject(ids, 'tacks')
  p.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10_000_000)
  const clip = applyAddLayer(p, ids, rootComposition(p).tracks[0].id, videoClipParams(MEDIA, 2_000_000, 6_000_000), 1_000_000, 5_000_000)
  const actor = createActor({ initial: p, idGen: ids, clock: () => '<TS>' })
  const send = vi.fn()
  const service = new AgentActivityService(actor, send, undefined, capacity)
  service.start()
  stops.push(() => service.stop())
  const run = <T>(connection: string, fn: () => T | Promise<T>) => service.run(connection, `client-${connection}`, 'create_tacks', {}, false, fn)
  const input = (patch: Partial<TackInput> = {}): TackInput =>
    ({ label: 'Check', body: '', kind: 'note', t_us: 2_000_000, end_t_us: null, anchor_layer_id: null, composition_id: null, ...patch })
  const create = (inputs: TackInput[], connection = 'one') => run(connection, () => service.tacks.create(inputs))
  const mcp = (name: string, args: Record<string, unknown>) => {
    const r = actor.mcpCall(name, JSON.stringify(args))
    if (!r.ok) throw new Error(r.error.message)
  }
  const view = (id: string) => service.tacks.views().find(t => t.id === id)!
  const updates = () => send.mock.calls.filter(([e]) => e === AGENT_ACTIVITY_EVENT).map(([, u]) => u as AgentActivityUpdate)
  return { actor, service, send, clip, run, input, create, mcp, view, updates, root: () => rootComposition(actor.snapshot()) }
}
const flush = () => new Promise<void>(r => queueMicrotask(r))

describe('tack records', () => {
  it('attribute each tack to the creating call, its connection and its work session', async () => {
    const s = setup()
    const session = await s.run('one', () => s.service.begin('Review pauses'))
    const [inSession] = await s.create([s.input({ label: '  Pause  ', kind: 'question', body: 'Keep it?' })])
    const [outside] = await s.create([s.input()], 'two')
    const activities = s.service.snapshot().activities.filter(a => a.tool === 'create_tacks')
    expect(s.view(inSession!)).toMatchObject({
      session_id: session.id, connection_id: 'one', client: 'client-one', activity_id: activities[1]!.id,
      kind: 'question', label: '  Pause  ', body: 'Keep it?', status: 'open',
      range: { kind: 'free', composition_id: s.root().id, t_us: 2_000_000, end_t_us: null },
      composition_id: s.root().id, t_us: 2_000_000, end_t_us: null, state: 'visible',
    })
    expect(s.view(outside!)).toMatchObject({ session_id: null, connection_id: 'two', activity_id: activities[2]!.id })
  })

  it('refuse a create outside an MCP call', () => {
    const s = setup()
    expect(() => s.service.tacks.create([s.input()])).toThrow(TackError)
    expect(s.service.tacks.size).toBe(0)
  })

  it('validate a batch whole: one bad entry creates none, and the refusal names it', async () => {
    const s = setup()
    const bad = [s.input(), s.input({ anchor_layer_id: s.clip, t_us: 6_000_000 }), s.input()]
    await expect(s.create(bad)).rejects.toThrow(/tacks\[1\]\.t_us 6000000 is outside layer/)
    for (const [entry, pattern] of [
      [s.input({ t_us: -1 }), /tacks\[1\]\.t_us/],
      [s.input({ end_t_us: 2_000_000 }), /tacks\[1\]\.end_t_us/],
      [s.input({ composition_id: '00000000-0000-7000-8000-00000000dead' }), /CompositionNotFound|not found/],
      [s.input({ anchor_layer_id: '00000000-0000-7000-8000-00000000dead' }), /layer .* not found/],
    ] as const) await expect(s.create([s.input(), entry])).rejects.toThrow(pattern)
    expect(s.service.tacks.size).toBe(0)
  })

  it('refuse past capacity with TackLimit and never evict', async () => {
    const s = setup(3)
    const first = await s.create([s.input(), s.input()])
    const refused = await s.create([s.input(), s.input()]).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(TackError)
    expect((refused as TackError).error).toBe('TackLimit')
    expect(s.service.tacks.views().map(t => t.id)).toEqual(first)
    await s.create([s.input()])
    expect(s.service.tacks.size).toBe(3)
  })

  it('update and delete by ids (all or none) or by work session', async () => {
    const s = setup()
    const session = await s.run('one', () => s.service.begin('Batch'))
    const ours = await s.create([s.input(), s.input()])
    const [theirs] = await s.create([s.input()], 'two')
    expect(s.service.tacks.update(ours[0]!, { status: 'resolved', label: 'Done' })).toMatchObject({ status: 'resolved', label: 'Done', kind: 'note' })
    expect(() => s.service.tacks.delete({ tack_ids: [theirs!, '00000000-0000-7000-8000-00000000dead'] })).toThrow(/not found/)
    expect(s.service.tacks.size).toBe(3)
    expect(s.service.tacks.delete({ session_id: session.id }).sort()).toEqual([...ours].sort())
    expect(s.service.tacks.views().map(t => t.id)).toEqual([theirs])
  })
})

describe('anchored placement', () => {
  it('converts timeline time to the clip’s source time at creation and follows a move', async () => {
    const s = setup()
    const [id] = await s.create([s.input({ anchor_layer_id: s.clip, t_us: 2_000_000, end_t_us: 3_000_000 })])
    expect(s.view(id!).range).toEqual({ kind: 'anchored', layer_id: s.clip, src_us: 3_000_000, src_end_us: 4_000_000 })
    expect(s.view(id!)).toMatchObject({ t_us: 2_000_000, end_t_us: 3_000_000, state: 'visible', composition_id: s.root().id })
    s.mcp('move_layer', { layer_id: s.clip, new_t_start_us: 3_000_000, new_track_id: s.root().tracks[0]!.id })
    expect(s.view(id!)).toMatchObject({ t_us: 4_000_000, end_t_us: 5_000_000, state: 'visible' })
  })

  it('stays on its frame through a head trim, hibernates past one and wakes on undo', async () => {
    const s = setup()
    const [id] = await s.create([s.input({ anchor_layer_id: s.clip, t_us: 2_000_000 })])
    s.mcp('trim_layer', { layer_id: s.clip, edge: 'in', new_t_us: 1_500_000 })
    expect(s.view(id!)).toMatchObject({ t_us: 2_000_000, state: 'visible' })
    s.mcp('trim_layer', { layer_id: s.clip, edge: 'in', new_t_us: 2_500_000 })
    expect(s.view(id!)).toMatchObject({ t_us: null, end_t_us: null, state: 'hibernating', composition_id: s.root().id })
    s.mcp('undo', {})
    expect(s.view(id!)).toMatchObject({ t_us: 2_000_000, state: 'visible' })
  })

  it('follows the piece of a split that keeps its frame and clips a region to its clip', async () => {
    const s = setup()
    const [early, late] = await s.create([
      s.input({ anchor_layer_id: s.clip, t_us: 2_000_000, end_t_us: 4_000_000 }),
      s.input({ anchor_layer_id: s.clip, t_us: 4_000_000 }),
    ])
    s.mcp('split_layer', { layer_id: s.clip, at_t_us: [3_000_000] })
    // The split keeps the left piece's id; the right piece no longer shows the
    // later frame under this id, exactly as an anchored marker hibernates.
    expect(s.view(early!)).toMatchObject({ t_us: 2_000_000, end_t_us: 3_000_000, state: 'visible' })
    expect(s.view(late!)).toMatchObject({ state: 'hibernating' })
  })

  it('goes stale when its clip is deleted, stays listed, and follows it into a Group', async () => {
    const s = setup()
    const [id] = await s.create([s.input({ anchor_layer_id: s.clip, t_us: 2_000_000 })])
    s.mcp('delete_layers', { layer_ids: [s.clip] })
    expect(s.view(id!)).toMatchObject({ state: 'stale', composition_id: null, t_us: null })
    expect(s.service.tacks.views()).toHaveLength(1)
    s.mcp('undo', {})
    expect(s.view(id!)).toMatchObject({ state: 'visible', t_us: 2_000_000 })
  })

  it('refuses a windowless layer and a composition the clip is not in', async () => {
    const ids = seededGen()
    const base = blankProject(ids, 'group')
    base.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10_000_000)
    let inner = ''
    const { p, groupId } = withGroup(base, ids, (g, view) => { inner = applyAddLayer(view, ids, g.tracks[0]!.id, videoClipParams(MEDIA, 0, 4_000_000), 0, 4_000_000) })
    const actor = createActor({ initial: p, idGen: ids, clock: () => '<TS>' })
    const service = new AgentActivityService(actor, vi.fn())
    service.start(); stops.push(() => service.stop())
    const create = (input: Partial<TackInput>) => service.run('c', 'c', 'create_tacks', {}, false, () => service.tacks.create([
      { label: 'x', body: '', kind: 'note', t_us: 1_000_000, end_t_us: null, anchor_layer_id: null, composition_id: null, ...input }]))
    await expect(create({ anchor_layer_id: inner, composition_id: p.root_id })).rejects.toMatchObject({ error: 'CrossCompositionSet' })
    const [id] = await create({ anchor_layer_id: inner })
    expect(service.tacks.views(groupId).map(t => t.id)).toEqual([id])
    expect(service.tacks.views(p.root_id)).toEqual([])
    expect(service.tacks.views()[0]).toMatchObject({ composition_id: groupId, t_us: 1_000_000 })
    const color = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: rootComposition(actor.snapshot()).tracks[0]!.id, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }))
    if (!color.ok) throw new Error(color.error.message)
    const colorId = (color.result.structuredContent as { layer_id: string }).layer_id
    await expect(create({ anchor_layer_id: colorId, t_us: 0 })).rejects.toMatchObject({ error: 'WrongLayerKind' })
  })
})

describe('independence from history', () => {
  it('records nothing, commits nothing and works while history is locked', async () => {
    const s = setup()
    const before = s.actor.snapshot()
    const len = s.actor.historyStatus().len
    const events = vi.fn()
    stops.push(s.actor.subscribe(events))
    s.actor.lockHistory('batch')
    const [id] = await s.create([s.input()])
    s.service.tacks.update(id!, { status: 'dismissed' })
    s.service.tacks.delete({ tack_ids: [id!] })
    expect(s.actor.snapshot()).toBe(before)
    expect(s.actor.historyStatus().len).toBe(len)
    expect(events).not.toHaveBeenCalled()
  })

  it('survives undo, redo and checkpoint restore untouched', async () => {
    const s = setup()
    const checkpoint = s.actor.checkpoint('before')
    s.mcp('add_track', { label: 'More' })
    const [id] = await s.create([s.input({ label: 'Keep me' })])
    s.mcp('undo', {}); s.mcp('redo', {})
    s.actor.restoreCheckpoint(checkpoint)
    expect(s.service.tacks.views().map(t => [t.id, t.label, t.status])).toEqual([[id, 'Keep me', 'open']])
  })
})

describe('project opening', () => {
  it('replacement clears tacks, and a call from the old opening cannot populate the new one', async () => {
    const s = setup()
    await s.create([s.input()])
    let release!: () => void
    const late = s.run('one', async () => { await new Promise<void>(r => { release = r }); return s.service.tacks.create([s.input()]) })
    s.actor.replaceState(blankProject(seededGen(), 'Next'))
    expect(s.service.tacks.views()).toEqual([])
    release()
    await expect(late).rejects.toMatchObject({ error: 'NoCurrentCall' })
    expect(s.service.snapshot().tacks).toEqual([])
  })
})

describe('delta publication', () => {
  it('publishes changed tacks and removed ids under the activity revision, and a reset', async () => {
    const s = setup()
    const [a, b] = await s.create([s.input({ anchor_layer_id: s.clip }), s.input()])
    await flush()
    expect(s.updates().flatMap(u => u.tacks.map(t => t.id)).sort()).toEqual([a, b].sort())
    expect(s.updates().flatMap(u => u.removed_tack_ids)).toEqual([])
    const created = s.updates().at(-1)!

    // An edit that moves only the anchored tack republishes only it.
    s.mcp('move_layer', { layer_id: s.clip, new_t_start_us: 2_000_000, new_track_id: s.root().tracks[0]!.id })
    await flush()
    const moved = s.updates().at(-1)!
    expect(moved.from_revision).toBe(created.revision)
    expect(moved.tacks).toEqual([expect.objectContaining({ id: a, t_us: 3_000_000 })])

    s.service.tacks.delete({ tack_ids: [b!] })
    await flush()
    expect(s.updates().at(-1)).toMatchObject({ tacks: [], removed_tack_ids: [b] })

    s.actor.replaceState(blankProject(seededGen(), 'Next'))
    await flush()
    expect(s.updates().at(-1)).toMatchObject({ reset: true, tacks: [], removed_tack_ids: [] })
    expect(s.service.snapshot().tacks).toEqual([])
  })
})
