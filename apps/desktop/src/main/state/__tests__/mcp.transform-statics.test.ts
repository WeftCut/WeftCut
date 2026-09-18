// apps/desktop/src/main/state/__tests__/mcp.transform-statics.test.ts
// Static rotation and pivot through update_layer_params — one patch, not a
// set_keyframe followed by clear_keyframes.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { root } from './fixtures/project'

const VIDEO = '00000000-0000-0000-0000-0000000000a2'

function actorWithPool() {
  const gen = seededGen()
  const p: Project = blankProject(gen, 'statics')
  p.media_pool[VIDEO] = mediaItemTemplate(VIDEO, 'Video', 10_000_000)
  return createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
}
const call = (a: ActorHandle, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const addedId = (r: ReturnType<ActorHandle['mcpCall']>): string => { if (!r.ok) throw new Error(r.error.message); return (JSON.parse(r.result.content[0].text) as { layer_id: string }).layer_id }
const layerOf = (a: ActorHandle, id: string): Layer => { for (const t of root(a.snapshot()).tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l } throw new Error(id) }
type Visual = { transform: { rotation_deg: { mode: string; value?: number }; anchor_x: { mode: string; value?: number }; anchor_y: { mode: string; value?: number } } }

describe('static rotation and pivot', () => {
  it('a VideoClip takes rotation_deg and the anchor pair as Static values, quantised', () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_video_layer', { track_id: root(a.snapshot()).tracks[0].id, media_id: VIDEO, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }))
    const r = call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'VideoClip', rotation_deg: 15.04, anchor_x: 0, anchor_y: 1.00004 } })
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    const t = (layerOf(a, id).params as unknown as Visual).transform
    expect(t.rotation_deg).toEqual({ mode: 'Static', value: 15 })
    expect(t.anchor_x).toEqual({ mode: 'Static', value: 0 })
    expect(t.anchor_y).toEqual({ mode: 'Static', value: 1 })
  })

  it('a Text layer takes them too (ADR 0049 withholds only scale from Text)', () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_text_layer', { track_id: root(a.snapshot()).tracks[1].id, content: 'Tilt', t_start_us: 0, t_end_us: 1_000_000 }))
    expect(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', rotation_deg: -90 } }).ok).toBe(true)
    expect((layerOf(a, id).params as unknown as Visual).transform.rotation_deg).toEqual({ mode: 'Static', value: -90 })
    const scale = call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', scale_x: 2 } })
    expect(!scale.ok && scale.error.message).toContain('not a Text param')
  })

  it('a keyframed rotation collapses to the Static value, like x and y do', () => {
    const a = actorWithPool()
    const id = addedId(call(a, 'add_video_layer', { track_id: root(a.snapshot()).tracks[0].id, media_id: VIDEO, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }))
    expect(call(a, 'set_keyframe', { layer_id: id, param_key: 'rotation_deg', t_us: 0, value: 0 }).ok).toBe(true)
    expect(call(a, 'set_keyframe', { layer_id: id, param_key: 'rotation_deg', t_us: 1_000_000, value: 90 }).ok).toBe(true)
    expect((layerOf(a, id).params as unknown as Visual).transform.rotation_deg.mode).toBe('Keyframed')
    expect(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'VideoClip', rotation_deg: 45 } }).ok).toBe(true)
    expect((layerOf(a, id).params as unknown as Visual).transform.rotation_deg).toEqual({ mode: 'Static', value: 45 })
  })

  it('a Color layer has no transform and is refused naming its set; a non-finite value is refused', () => {
    const a = actorWithPool()
    const c = addedId(call(a, 'add_color_layer', { track_id: root(a.snapshot()).tracks[0].id, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }))
    const r = call(a, 'update_layer_params', { layer_id: c, patch: { kind: 'Color', rotation_deg: 10 } })
    expect(!r.ok && r.error.message).toContain('not a Color param')
    const v = addedId(call(a, 'add_video_layer', { track_id: root(a.snapshot()).tracks[1].id, media_id: VIDEO, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }))
    const bad = call(a, 'update_layer_params', { layer_id: v, patch: { kind: 'VideoClip', anchor_x: 'left' } })
    expect(bad.ok).toBe(false)
  })
})
