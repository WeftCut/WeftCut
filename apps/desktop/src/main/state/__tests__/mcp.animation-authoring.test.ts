import { describe, expect, it } from 'vitest'
import { createActor } from '../actor'
import { blankProject, rootComposition, type TextParams } from '../model'
import { seededGen } from '../ids'
import { parseProject, serializeProject } from '../serialize'
import { MCP_TOOL_DEFS, parseEffectPatch } from '../mcp-commands'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
function setup() {
  const idGen = seededGen()
  const actor = createActor({ initial: blankProject(idGen, 'Animation example'), idGen })
  const added = actor.command('add_text_layer', { content: 'Example', tStartUs: 1_000_000, durationUs: 3_000_000 })
  if (!added.ok) throw new Error('setup failed')
  const layer = added.value as string
  const call = (tool: string, args: object) => actor.mcpCall(tool, JSON.stringify({ layer_id: layer, ...args }))
  const params = () => rootComposition(actor.snapshot()).tracks.flatMap(t => t.layers).find(l => l.id === layer)!.params as TextParams
  return { actor, layer, call, params }
}

describe('MCP animation authoring owns identities', () => {
  it('authors from time and value, returns generated ids, and restores them through undo/redo', () => {
    const { actor, call, params } = setup()
    const before = actor.snapshot()
    const result = call('set_param_track', { param_key: 'opacity', track: { mode: 'Keyframed', value: [
      { t_us: 1_000_000, value: 0 }, { t_us: 2_000_000, value: 1 },
    ] } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const track = params().opacity
    expect(track.mode).toBe('Keyframed')
    if (track.mode !== 'Keyframed') throw new Error('missing animation')
    expect(track.value.map(k => [k.t_us, k.value])).toEqual([[0, 0], [1_000_000, 1]])
    expect(track.value.every(k => UUID.test(k.id))).toBe(true)
    expect(new Set(track.value.map(k => k.id)).size).toBe(2)
    expect(track.value.every(k => k.segment.kind === 'Linear')).toBe(true)
    expect(track.extrapolate).toEqual({ before: 'Hold', after: 'Hold' })
    expect(JSON.stringify(result)).toContain(track.value[0]!.id)
    const after = actor.snapshot()
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(after)
    expect(call('update_keyframe', { param_key: 'opacity', keyframe_id: track.value[0]!.id, easing: { preset: 'ease_in_out' } }).ok).toBe(true)
    expect(call('delete_keyframe', { param_key: 'opacity', keyframe_id: track.value[1]!.id }).ok).toBe(true)
  })

  it.each(['custom-key', '00000000-0000-0000-0000-000000000099'])('refuses caller-supplied id %s atomically', id => {
    const { actor, call } = setup()
    const before = actor.snapshot()
    const result = call('set_param_track', { param_key: 'opacity', track: { mode: 'Keyframed', value: [{ id, t_us: 1_000_000, value: 1 }] } })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toMatch(/generated.*omit.*id/i)
    expect(actor.snapshot()).toEqual(before)
  })

  it('generates spatial and temporal identities with layer-local position times', () => {
    const { call, params } = setup()
    const result = call('set_position', { position: { mode: 'Path', path: { nodes: [
      { point: { x: 100, y: 200 } }, { point: { x: 300, y: 400 } },
    ] }, progress: { mode: 'Keyframed', value: [{ t_us: 0, value: 0 }, { t_us: 1_000_000, value: 1 }] } } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const position = params().transform.position
    if (position.mode !== 'Path' || position.progress.mode !== 'Keyframed') throw new Error('missing path')
    expect(position.path.nodes.every(n => UUID.test(n.id))).toBe(true)
    expect(position.path.nodes.every(n => n.segment === 'Line' && n.tangent_mode === 'Corner')).toBe(true)
    expect(position.progress.value.every(k => UUID.test(k.id))).toBe(true)
    expect(position.progress.value.map(k => k.t_us)).toEqual([0, 1_000_000])
    expect(JSON.stringify(result)).toContain(position.path.nodes[0]!.id)
    expect(JSON.stringify(result)).toContain(position.progress.value[0]!.id)
  })

  it('refuses custom path ids and malformed times without changing the layer', () => {
    const { actor, call } = setup()
    const before = actor.snapshot()
    expect(call('set_position', { position: { mode: 'Path', path: { nodes: [{ id: 'custom', point: { x: 1, y: 2 } }] }, progress: { mode: 'Static', value: 0 } } }).ok).toBe(false)
    for (const t_us of [1.5, '1000000', null])
      expect(call('set_param_track', { param_key: 'opacity', track: { mode: 'Keyframed', value: [{ t_us, value: 1 }] } }).ok).toBe(false)
    expect(actor.snapshot()).toEqual(before)
  })

  it('keeps animated effect authoring on the keyframe tools', () => {
    expect(() => parseEffectPatch({ params: { strength: { mode: 'Keyframed', value: [{ t_us: 0, value: 1 }] } } })).toThrow(/set_keyframe or set_param_track/)
    expect(parseEffectPatch({ params: { strength: { mode: 'Static', value: 1 } } })).toEqual({ params: { strength: { mode: 'Static', value: 1 } } })
  })

  it('does not advertise stored ids as bulk authoring inputs', () => {
    for (const name of ['set_param_track', 'set_position']) {
      const schema = MCP_TOOL_DEFS.find(d => d.name === name)!.inputSchema
      expect(JSON.stringify(schema)).not.toContain('"id":')
    }
  })

  it('rejects malformed persisted keyframe ids when opening, before native export', () => {
    const { actor, call } = setup()
    expect(call('set_keyframe', { param_key: 'opacity', t_us: 1_000_000, value: 1 }).ok).toBe(true)
    const wire = structuredClone(serializeProject(actor.snapshot())) as ReturnType<typeof actor.snapshot>
    const layer = rootComposition(wire).tracks.flatMap(t => t.layers)[0]!
    const track = (layer.params as TextParams).opacity
    if (track.mode !== 'Keyframed') throw new Error('missing track')
    track.value[0]!.id = 'invalid-example'
    expect(() => parseProject(wire)).toThrow(/keyframe.*UUID/i)
  })
})
