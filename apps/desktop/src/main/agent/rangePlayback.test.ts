import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { recordPlayback, replay } from './rangePlayback'
import { createActor } from '../state/actor'
import { blankProject, rootComposition, type Layer, type Project } from '../state/model'
import { seededGen } from '../state/ids'
import { applyAddLayer } from '../state/mutations/add'
import { mediaItemTemplate, videoClipParams } from '../state/mutations/media'

const MEDIA = '00000000-0000-0000-0000-0000000000cc'
const S = 1_000_000
const key = (t_us: number, value: number) =>
  ({ id: `k${t_us}`, t_us, value, in: { x: 0, y: 0 }, out: { x: 1, y: 1 }, continuity: 'Smooth', segment: { kind: 'Linear' } })

/** One 8 s clip at [0, 8 s) whose opacity fades in over [5 s, 6 s) — keyframes
 *  stored from the layer's start, as the model keeps them — under an actor. */
function setup() {
  const ids = seededGen()
  const p = blankProject(ids, 'playback')
  p.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10 * S)
  const clip = applyAddLayer(p, ids, rootComposition(p).tracks[0]!.id, videoClipParams(MEDIA, 0, 8 * S), 0, 8 * S)
  ;(rootComposition(p).tracks[0]!.layers[0]!.params as unknown as { opacity: unknown }).opacity =
    { mode: 'Keyframed', value: [key(5 * S, 0), key(6 * S, 1)], extrapolate: { before: 'Hold', after: 'Hold' } }
  const actor = createActor({ initial: p, idGen: ids, clock: () => '<TS>' })
  const mcp = (name: string, args: Record<string, unknown>) => {
    const r = actor.mcpCall(name, JSON.stringify(args))
    if (!r.ok) throw new Error(r.error.message)
  }
  const edit = (fn: (l: Layer) => void) => produce(actor.snapshot(), (d: Project) => { fn(rootComposition(d).tracks[0]!.layers[0]!) })
  return { actor, clip, mcp, edit, root: () => actor.snapshot().root_id }
}

describe('replay', () => {
  it('plays the same, in place, against the project it was recorded on', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    expect(replay(s.actor.snapshot(), pb)).toEqual({
      composition_id: s.root(), t_us: 5 * S, end_t_us: 6 * S, same: true, follows: { layer_id: s.clip, t_us: 5 * S, src_us: 5 * S },
    })
  })

  it('plays the same after a head trim outside the range, though the trim moved every keyframe', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    s.mcp('trim_layer', { layer_id: s.clip, edge: 'in', new_t_us: S })
    expect(replay(s.actor.snapshot(), pb)).toMatchObject({ t_us: 5 * S, same: true })
  })

  it('plays differently when a keyframe inside the range changes', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    const next = s.edit((l) => { ((l.params as unknown as { opacity: { value: Array<{ value: number }> } }).opacity.value[1]!).value = 0.5 })
    expect(replay(next, pb)!.same).toBe(false)
  })

  it('ignores a layer’s label and lock, which play nothing, and reads its enabled flag and metadata, which do', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    expect(replay(s.edit((l) => { l.label = 'Interview'; l.locked = true }), pb)!.same).toBe(true)
    expect(replay(s.edit((l) => { l.enabled = false }), pb)!.same).toBe(false)
    expect(replay(s.edit((l) => { l.metadata = { caption_timing: [1] } }), pb)!.same).toBe(false)
  })

  it('moves with its content, and stays where it was recorded once that is gone', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    s.mcp('move_layer', { layer_id: s.clip, new_t_start_us: S, new_track_id: rootComposition(s.actor.snapshot()).tracks[0]!.id })
    expect(replay(s.actor.snapshot(), pb)).toMatchObject({ t_us: 6 * S, end_t_us: 7 * S, same: true, follows: { layer_id: s.clip, t_us: 6 * S } })
    s.mcp('delete_layers', { layer_ids: [s.clip] })
    expect(replay(s.actor.snapshot(), pb)).toEqual({ composition_id: s.root(), t_us: 5 * S, end_t_us: 6 * S, same: false, follows: null })
  })

  it('answers each project as it is, whichever it read before — as undo and redo swap them', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    const was = s.actor.snapshot()
    const off = s.edit((l) => { l.enabled = false })
    const renamed = s.edit((l) => { l.label = 'Interview' })
    for (const [p, same] of [[was, true], [off, false], [was, true], [renamed, true], [off, false]] as const)
      expect(replay(p, pb)!.same).toBe(same)
  })

  it('has no place once its composition is gone', () => {
    const s = setup()
    const pb = recordPlayback(s.actor.snapshot(), s.root(), 5 * S, 6 * S)
    const gone = produce(s.actor.snapshot(), (d: Project) => { delete d.compositions[d.root_id] })
    expect(replay(gone, pb)).toBeNull()
  })
})
