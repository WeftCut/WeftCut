import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { createActor, type ActorHandle } from '../state/actor'
import { blankProject, rootComposition as root, type Layer } from '../state/model'
import { seededGen } from '../state/ids'
import { applyAddLayer } from '../state/mutations/add'
import { audioParams, mediaItemTemplate, videoClipParams } from '../state/mutations/media'
import { recordPlayback, replay } from './rangePlayback'
import { resolveAnimated } from '../../renderer/render/animated'
import { fadeMultiplier } from '../../renderer/render/audio/envelope'
import { TackStore } from './tacks'

const S = 1_000_000
const MEDIA = '00000000-0000-0000-0000-0000000000cc'
const AGENT = { kind: 'Agent' as const, client: 'audit' }
function setup(two = false, animate = false, audio = false) {
  const gen = seededGen()
  const p = blankProject(gen, 'Synthetic review audit')
  p.media_pool[MEDIA] = mediaItemTemplate(MEDIA, audio ? 'Audio' : 'Video', 20 * S)
  const track = root(p).tracks[0]!.id
  const a = applyAddLayer(p, gen, track, (audio ? audioParams : videoClipParams)(MEDIA, 0, 8 * S), 0, 8 * S)
  const b = two ? applyAddLayer(p, gen, track, videoClipParams(MEDIA, 8 * S, 12 * S), 8 * S, 12 * S) : null
  if (animate) {
    const layer = root(p).tracks[0]!.layers[0]!
    if (layer.params.kind !== 'VideoClip') throw new Error('fixture')
    layer.params.opacity = {
      mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' },
      value: [
        { id: gen(), t_us: 0, value: 1 },
        { id: gen(), t_us: 3 * S, value: 1 },
        { id: gen(), t_us: 7 * S, value: 0 },
      ].map(k => ({ ...k, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' as const }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' as const }, continuity: 'Broken' as const, segment: { kind: 'Linear' as const } })),
    }
  }
  const actor = createActor({ initial: p, idGen: gen, clock: () => '<AUDIT>' })
  const mcp = (name: string, args: Record<string, unknown>) => {
    const r = actor.mcpCall(name, JSON.stringify(args), AGENT.client)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.result.structuredContent as Record<string, unknown>
  }
  const dispatch = (name: string, args: Record<string, unknown>) => {
    const r = actor.dispatch(name as Parameters<ActorHandle['dispatch']>[0], args, AGENT)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value
  }
  const record = (start: number, end: number) => recordPlayback(actor.snapshot(), actor.snapshot().root_id, start * S, end * S)
  const find = (id: string): Layer => Object.values(actor.snapshot().compositions).flatMap(c => c.tracks).flatMap(t => t.layers).find(l => l.id === id)!
  return { actor, a, b, track, mcp, dispatch, record, find }
}

describe('Tack range contract — adversarial cases', () => {
  it('reads role gain even when every composition keeps its identity, but ignores unrelated buses', () => {
    const s = setup(false, false, true)
    const pb = s.record(1, 2)
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(true) // warm the replay cache
    s.dispatch('set_role_gain', { role: 'dialogue', gain_db: -12 })
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(true) // fixture is music
    const compositions = s.actor.snapshot().compositions
    s.dispatch('set_role_gain', { role: 'music', gain_db: -12 })
    expect(s.actor.snapshot().compositions).toBe(compositions)
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(false)
    s.mcp('undo', {})
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(true)
  })

  it('a held segment ignores the next key value but a linear segment reads its boundary key outside the range', () => {
    const s = setup(false, true)
    const p = produce(s.actor.snapshot(), d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[0]!.segment = { kind: 'Hold' }
    })
    const pb = recordPlayback(p, p.root_id, S, 2 * S)
    const changed = produce(p, d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[1]!.value = 0.5
    })
    expect(replay(changed, pb)!.same).toBe(true)
    const linear = produce(changed, d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[0]!.segment = { kind: 'Linear' }
    })
    expect(replay(linear, pb)!.same).toBe(false)
  })

  it('includes transitions only where their half-open overlap plays', () => {
    const s = setup(true)
    s.mcp('add_transition', { from_layer_id: s.a, to_layer_id: s.b, duration_us: S })
    const before = s.actor.snapshot()
    const transition = root(before).transitions[0]!.id
    const early = recordPlayback(before, before.root_id, S, 7 * S)
    const inside = recordPlayback(before, before.root_id, 7 * S, 7.5 * S)
    const endPoint = recordPlayback(before, before.root_id, 8 * S, null)
    const changed = produce(before, d => { root(d).transitions.find(t => t.id === transition)!.kind = { kind: 'Wipe', direction: 'left' } })
    expect(replay(changed, early)!.same).toBe(true)
    expect(replay(changed, inside)!.same).toBe(false)
    expect(replay(changed, endPoint)!.same).toBe(true)
  })

  it('handles visual fades too, and leaves a range before either fade current', () => {
    const s = setup()
    s.mcp('update_layer_params', { layer_id: s.a, patch: { kind: 'VideoClip', fade_out_us: 4 * S } })
    const inside = s.record(5, 6), outside = s.record(1, 2)
    s.mcp('trim_layer', { layer_id: s.a, edge: 'out', new_t_us: 7 * S })
    expect(replay(s.actor.snapshot(), inside)!.same).toBe(false)
    expect(replay(s.actor.snapshot(), outside)!.same).toBe(true)
    s.mcp('undo', {})
    expect(replay(s.actor.snapshot(), inside)!.same).toBe(true)
  })
  it('an animation edit after the reviewed segment must not outdate it', () => {
    const s = setup(false, true)
    const pb = s.record(1, 2)
    const before = s.actor.snapshot()
    const next = produce(before, d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[2]!.value = 0.5 // Only the segment [3, 7] changes; [1, 2] stays constant 1.
    })
    const was = root(before).tracks[0]!.layers[0]!.params
    const now = root(next).tracks[0]!.layers[0]!.params
    if (was.kind !== 'VideoClip' || now.kind !== 'VideoClip') throw new Error('fixture')
    for (let frame = 30; frame < 60; frame++) {
      const t = Math.round(frame * S / 30)
      expect(resolveAnimated(was.opacity, t, 1)).toBe(1)
      expect(resolveAnimated(now.opacity, t, 1)).toBe(1)
    }
    expect(replay(before, pb)!.same).toBe(true)
    expect(replay(next, pb)!.same).toBe(true)
  })

  it('a transition at [7, 8) must not outdate a tack at [1, 2)', () => {
    const s = setup(true)
    const pb = s.record(1, 2)
    s.mcp('add_transition', { from_layer_id: s.a, to_layer_id: s.b, duration_us: S })
    expect(s.find(s.b!).t_start_us).toBe(7 * S)
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(true)
  })

  it('an end trim changing the audible fade inside the range must outdate it', () => {
    const s = setup(false, false, true)
    s.mcp('update_layer_params', { layer_id: s.a, patch: { kind: 'Audio', fade_out_us: 4 * S } })
    const store = new TackStore({
      project: () => s.actor.snapshot(), changed: () => {},
      caller: () => ({ session_id: null, connection_id: 'audit', client: 'audit', activity_id: 'audit' }),
    })
    const [id] = store.create([{ label: 'Check the music fade', body: '', kind: 'question', t_us: 5 * S, end_t_us: 6 * S, composition_id: null }])
    expect(store.views()[0]!.outdated).toBe(false)
    const before = s.find(s.a)
    s.mcp('trim_layer', { layer_id: s.a, edge: 'out', new_t_us: 7 * S })
    const after = s.find(s.a)
    if (before.params.kind !== 'Audio' || after.params.kind !== 'Audio') throw new Error('fixture')
    expect(fadeMultiplier(5.5 * S, before.t_end_us - before.t_start_us, 0, before.params.fade_out_us)).toBe(0.625)
    expect(fadeMultiplier(5.5 * S, after.t_end_us - after.t_start_us, 0, after.params.fade_out_us)).toBe(0.375)
    expect(store.views().find(t => t.id === id)!.outdated).toBe(true)
  })

  it('control: an end trim without fades outside the range preserves current status', () => {
    const s = setup(false, false, true)
    const pb = s.record(5, 6)
    s.mcp('trim_layer', { layer_id: s.a, edge: 'out', new_t_us: 7 * S })
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(true)
  })

  it('control: splitting after a static reviewed range retains its content identity', () => {
    const s = setup()
    const pb = s.record(1, 2)
    s.mcp('split_layer', { layer_id: s.a, at_t_us: [3 * S] })
    expect(replay(s.actor.snapshot(), pb)!.same).toBe(true)
  })

  it('a newly created range covering a sample-aligned audio start must be current at its requested place', () => {
    const s = setup(false, false, true)
    s.mcp('move_layer', { layer_id: s.a, new_t_start_us: 1_010_000, new_track_id: s.track })
    expect(s.find(s.a).t_start_us).toBe(1_010_000) // Audio's sample lattice, not a video frame boundary.
    const store = new TackStore({
      project: () => s.actor.snapshot(), changed: () => {},
      caller: () => ({ session_id: null, connection_id: 'audit', client: 'audit', activity_id: 'audit' }),
    })
    store.create([{ label: 'Check the music entrance', body: '', kind: 'question', t_us: 500_000, end_t_us: 2 * S, composition_id: null }])
    expect(store.views()[0]).toMatchObject({ t_us: 500_000, end_t_us: 2 * S, outdated: false })
    s.mcp('move_layer', { layer_id: s.a, new_t_start_us: 1_020_000, new_track_id: s.track })
    expect(store.views()[0]).toMatchObject({ t_us: 510_000, end_t_us: 2_010_000, outdated: false })
    s.mcp('undo', {})
    expect(store.views()[0]).toMatchObject({ t_us: 500_000, end_t_us: 2 * S, outdated: false })
  })

  it('keys cached comparisons by covered duration and retains looping dependencies', () => {
    const s = setup(false, true)
    const before = s.actor.snapshot()
    const short = s.record(1, 2), long = s.record(1, 6)
    const changed = produce(before, d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[2]!.value = 0.5
    })
    expect(replay(changed, short)!.same).toBe(true)
    expect(replay(changed, long)!.same).toBe(false)
    const loop = produce(before, d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[1]!.t_us = S
      params.opacity.value[2]!.t_us = 2 * S
      params.opacity.extrapolate.after = 'Loop'
    })
    const loopRange = recordPlayback(loop, loop.root_id, 3.2 * S, 3.8 * S)
    const loopChanged = produce(loop, d => {
      const params = root(d).tracks[0]!.layers[0]!.params
      if (params.kind !== 'VideoClip' || params.opacity.mode !== 'Keyframed') throw new Error('fixture')
      params.opacity.value[2]!.value = 0.5
    })
    expect(replay(loopChanged, loopRange)!.same).toBe(false)
  })

  it('control: retiming changes playback and undo restores current status', () => {
    const s = setup()
    const pb = s.record(1, 2)
    s.mcp('retime_layers', { layer_ids: [s.a], target: { kind: 'Rate', value: { num: 2, den: 1 } } })
    expect(replay(s.actor.snapshot(), pb)).toMatchObject({ t_us: 500_000, end_t_us: 1_500_000, same: false })
    s.mcp('undo', {})
    expect(replay(s.actor.snapshot(), pb)).toMatchObject({ t_us: S, end_t_us: 2 * S, same: true })
  })
})
