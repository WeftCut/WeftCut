import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_ARG_PARSERS, MCP_TOOL_DEFS } from '../mcp-commands'
import { PRODUCTION_OPS } from '../commands'
import { positionProblem, type PathPosition } from '../../../shared/position'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, rootComposition, type TextParams } from '../model'

const doc = readFileSync('../../docs/mcp.md', 'utf8')
const editDocs = doc.split('### Edit tools')[1]!.split('\n### ')[0]!
const positionDocs = editDocs.split('Position and motion paths:')[1]!.split('\nEffects (')[0]!

describe('documented MCP position contract', () => {
  it.each(['set_position', 'translate_path'])('%s is documented and registered for production', name => {
    expect(PRODUCTION_OPS.has(name)).toBe(true)
    expect(MCP_TOOL_DEFS.find(d => d.name === name)?.exec).toBe('table')
    expect(positionDocs).toContain('`' + name + ' {')
  })

  it('documents active-mode parameters, time bases and progress restrictions', () => {
    const params = editDocs.split('Valid `param_key`:')[1]!.split('\nLinks (')[0]!
    for (const term of ['CompositionRef', 'XY mode only', 'Path mode only', 'path_progress', 'rejected'])
      expect(params).toContain(term)
    for (const term of ['layer-local microseconds', 'timeline-absolute', 'not percentages', '4096', '128', 'Offset', 'Continue'])
      expect(positionDocs).toContain(term)
  })

  it('keeps the runtime descriptions agents discover aligned with the document', () => {
    const tool = (name: string) => MCP_TOOL_DEFS.find(d => d.name === name)!
    expect(JSON.stringify(tool('set_keyframe').inputSchema)).toContain('path_progress')
    expect(tool('get_param_track').description).toContain('path_progress in Path mode')
    expect(tool('update_layer_params').description).toContain('Path mode rejects independent x/y writes')
    expect(tool('set_extrapolation').description).toContain('For path_progress, only Hold / Loop / PingPong')
  })

  it('accepts the documentation JSON through the public position parser', () => {
    const example = JSON.parse(/```json\s*([\s\S]*?)```/.exec(positionDocs)![1]!)
    const parsed = MCP_ARG_PARSERS.set_position!(example)
    expect(parsed).toEqual({ op: 'set_position', args: { layer: example.layer_id, position: example.position } })
    expect(positionProblem(parsed.args.position)).toBeNull()
  })

  it('uses the documented example and follow-up tools through the real MCP dispatcher', () => {
    const gen = seededGen(), project = blankProject(gen, 'MCP position docs'), comp = rootComposition(project)
    const actor = createActor({ initial: project, idGen: gen })
    const add = actor.command('add_text_layer', { content: 'Path', tStartUs: 1_000_000, durationUs: 2_000_000 })
    expect(add.ok, JSON.stringify(add)).toBe(true)
    if (!add.ok) throw new Error('Could not create test layer')
    const layerId = add.value as string
    const example = JSON.parse(/```json\s*([\s\S]*?)```/.exec(positionDocs)![1]!)
    example.layer_id = layerId
    expect(actor.mcpCall('set_position', JSON.stringify(example)).ok).toBe(true)
    const call = (name: string, args: object) => actor.mcpCall(name, JSON.stringify({ layer_id: layerId, ...args }))
    expect(call('set_keyframe', { param_key: 'path_progress', t_us: 1_000_000, value: 0 }).ok).toBe(true)
    expect(call('set_keyframe', { param_key: 'path_progress', t_us: 2_000_000, value: 1 }).ok).toBe(true)
    expect(call('set_keyframe', { param_key: 'x', t_us: 1_000_000, value: 10 }).ok).toBe(false)
    expect(call('set_extrapolation', { param_key: 'path_progress', after: 'Continue' }).ok).toBe(false)
    expect(call('translate_path', { dx: 20, dy: -10 }).ok).toBe(true)
    const layer = actor.snapshot().compositions[comp.id]!.tracks.flatMap(t => t.layers).find(l => l.id === layerId)!
    const position = (layer.params as TextParams).transform.position as PathPosition
    expect(position.path.nodes[0]!.point).toEqual({ x: 120, y: 190 })
    expect(position.progress.mode).toBe('Keyframed')
    if (position.progress.mode === 'Keyframed')
      expect(position.progress.value.map(k => [k.t_us, k.value])).toEqual([[0, 0], [1_000_000, 1]])
  })
})
