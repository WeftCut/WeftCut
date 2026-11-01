import { describe, expect, it, vi } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'
import { root } from './fixtures/project'

function fixture(linked = false) {
  const actor = freshActor()
  const add = (track: string) => {
    const result = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 10_000_000 })
    if (!result.ok) throw new Error('fixture failed')
    return result.value as string
  }
  const layer = add(aRollId(actor))
  const sibling = linked ? add(bRollId(actor)) : null
  if (sibling) expect(actor.dispatch('links_create', { layers: [layer, sibling] }).ok).toBe(true)
  const changed = vi.fn()
  actor.subscribe(changed)
  const split = (args: Record<string, unknown>) => actor.mcpCall('split_layer', JSON.stringify({ layer_id: layer, ...args }))
  return { actor, layer, sibling, changed, split }
}

describe('MCP split_layer batch', () => {
  it('splits 100 cuts with one notification and history entry; undo/redo restores the whole batch', () => {
    const { actor, layer, changed, split } = fixture()
    const before = actor.snapshot()
    const historyBefore = actor.historyStatus().len
    const cuts = Array.from({ length: 100 }, (_, i) => Math.round((i + 1) * 2_000_000 / 30))
    const result = split({ t_cut_us: cuts })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const response = JSON.parse(result.result.content[0].text)
    expect(response.t_cut_us).toEqual(cuts)
    expect(response.layer_ids).toHaveLength(101)
    expect(response.layer_ids[0]).toBe(layer)
    expect(root(actor.snapshot()).tracks[0].layers.map((l) => l.id)).toEqual(response.layer_ids)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(actor.historyStatus().len).toBe(historyBefore + 1)
    const after = actor.snapshot()
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(after)
  })

  it('sorts and deduplicates cuts after snapping, keeping each resulting pair in a separate link', () => {
    const { actor, layer, sibling, split } = fixture(true)
    const result = split({ t_cut_us: [4_000_001, 2_000_000, 4_000_000, 2_000_001] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const response = JSON.parse(result.result.content[0].text)
    expect(response.t_cut_us).toEqual([2_000_000, 4_000_000])
    expect(response.layer_ids).toHaveLength(3)
    const c = root(actor.snapshot())
    expect(c.links).toHaveLength(3)
    expect(c.links[0].members).toEqual([layer, sibling].sort())
    for (const link of c.links) {
      const members = c.tracks.flatMap((t) => t.layers).filter((l) => link.members.includes(l.id))
      expect(members).toHaveLength(2)
      expect(members[0].t_start_us).toBe(members[1].t_start_us)
      expect(members[0].t_end_us).toBe(members[1].t_end_us)
    }
  })

  // The partner's new ids ride the answer, so the next step (a ripple delete
  // of one shot and its audio) needs no read of the tracks (audit T12).
  it('answers each link partner the split cut, with its segments in timeline order', () => {
    const { actor, sibling, split } = fixture(true)
    const result = split({ t_cut_us: [2_000_000, 4_000_000] })
    if (!result.ok) throw new Error(result.error.message)
    const response = JSON.parse(result.result.content[0].text) as { siblings: Array<{ layer_id: string; segments: string[] }> }
    const lane = root(actor.snapshot()).tracks[1].layers.map((l) => l.id)
    expect(response.siblings).toEqual([{ layer_id: sibling, segments: lane }])
    expect(lane).toHaveLength(3)
    expect(lane[0]).toBe(sibling)
  })

  it('honors escape_link for the whole batch', () => {
    const { actor, layer, sibling, split } = fixture(true)
    expect(split({ t_cut_us: [2_000_000, 4_000_000], escape_link: true }).ok).toBe(true)
    const c = root(actor.snapshot())
    expect(c.tracks[0].layers).toHaveLength(3)
    expect(c.tracks[1].layers).toHaveLength(1)
    expect(c.links).toHaveLength(1)
    expect(c.links[0].members).toEqual([layer, sibling].sort())
    const r = split({ t_cut_us: [1_000_000], escape_link: true })
    if (!r.ok) throw new Error(r.error.message)
    expect(JSON.parse(r.result.content[0].text).siblings).toEqual([])
  })

  it.each([
    {},
    { t_cut_us: 2_000_000 },
    { t_cut_us: null },
    { t_cut_us: [2_000_000, 4_000_000.5] },
    { t_cut_us: [] },
    { t_cut_us: '2000000' },
    { t_cut_us: [2_000_000, '4000000'] },
    { t_cut_us: [2_000_000, 0] },
    { t_cut_us: [2_000_000, 10_000_000] },
    { t_cut_us: [2_000_000, 9_999_999] },
    { t_cut_us: [2_000_000, 12_000_000] },
    { t_cut_us: [2_000_000], escape_link: 'true' },
  ])('rejects invalid cuts atomically: %j', (args) => {
    const { actor, changed, split } = fixture()
    const before = actor.snapshot()
    const history = actor.historyStatus()
    expect(split(args).ok).toBe(false)
    expect(actor.snapshot()).toEqual(before)
    expect(actor.historyStatus()).toEqual(history)
    expect(changed).not.toHaveBeenCalled()
  })

  it('uses the same array input and response for a single cut', () => {
    const { layer, split } = fixture()
    const result = split({ t_cut_us: [2_000_000] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.parse(result.result.content[0].text)).toEqual({ layer_ids: [layer, expect.any(String)], t_cut_us: [2_000_000], siblings: [] })
  })

  it('rolls back earlier cuts when a later cut reaches a locked linked member', () => {
    const { actor, sibling, changed, split } = fixture(true)
    expect(actor.dispatch('trim_layer', { layer: sibling, edge: 'in', new_t_us: 4_000_000, escape_link: true }).ok).toBe(true)
    expect(actor.dispatch('update_track_flags', { track: bRollId(actor), patch: { locked: true } }).ok).toBe(true)
    changed.mockClear()
    const before = actor.snapshot()
    const history = actor.historyStatus()
    const result = split({ t_cut_us: [2_000_000, 6_000_000] })
    expect(result.ok).toBe(false)
    expect(actor.snapshot()).toEqual(before)
    expect(actor.historyStatus()).toEqual(history)
    expect(changed).not.toHaveBeenCalled()
  })
})
