import { describe, expect, it } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

function setup(lock: 'layer' | 'track' = 'layer') {
  const gen = seededGen()
  const actor = createActor({ initial: blankProject(gen, 'lock regression'), idGen: gen, clock: () => '<TS>' })
  const track = root(actor.snapshot()).tracks[0].id
  const add = (start: number) => {
    const result = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: start, t_end_us: start + 1_000_000 })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    return result.value as string
  }
  const first = add(0), second = add(1_000_000)
  const effectResult = actor.dispatch('add_effect', { layer: second, kind: 'blur' })
  if (!effectResult.ok) throw new Error(JSON.stringify(effectResult.error))
  const effect = effectResult.value as string
  expect(lock === 'layer'
    ? actor.dispatch('update_layer', { layer: second, patch: { locked: true } }).ok
    : actor.dispatch('update_track_flags', { track, patch: { locked: true } }).ok).toBe(true)
  return { actor, track, first, second, effect }
}

describe('locked layer editing boundary', () => {
  for (const lock of ['layer', 'track'] as const) {
    it.each(['label', 'visibility', 'params', 'keyframe', 'add effect', 'update effect', 'remove effect', 'delete', 'unlock and edit'])(`rejects %s on a ${lock} lock`, (operation) => {
      const { actor, first, second, effect } = setup(lock)
      const before = actor.snapshot(), history = actor.historyStatus()
      const commands: Record<string, [string, Record<string, unknown>]> = {
        label: ['update_layer', { layer: second, patch: { label: 'changed' } }],
        visibility: ['set_layers_enabled', { layers: [first, second], enabled: false }],
        params: ['update_layer_params', { layer: second, patch: { kind: 'Color', width: 640 } }],
        keyframe: ['update_layer_param_track', { layer: second, param_key: 'color', track: { mode: 'Static', value: { r: 0, g: 1, b: 0, a: 1 } } }],
        'add effect': ['add_effect', { layer: second, kind: 'blur' }],
        'update effect': ['update_effect', { layer: second, effect, patch: { enabled: false } }],
        'remove effect': ['remove_effect', { layer: second, effect }],
        delete: ['delete_layers', { layers: [first, second] }],
        'unlock and edit': ['update_layer', { layer: second, patch: { locked: false, label: 'changed' } }],
      }
      const [op, args] = commands[operation]
      const result = actor.dispatch(op, args)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.error).toBe(lock === 'track' ? 'TrackLocked' : 'LayerLocked')
      expect(actor.snapshot()).toEqual(before)
      expect(actor.historyStatus()).toEqual(history)
    })
  }

  it('allows lock controls on a locked track but requires both locks clear before editing', () => {
    const { actor, second, track } = setup('track')
    expect(actor.dispatch('update_layer', { layer: second, patch: { locked: true } }).ok).toBe(true)
    expect(actor.dispatch('update_layer', { layer: second, patch: { locked: false } }).ok).toBe(true)
    expect(actor.dispatch('update_layer_params', { layer: second, patch: { kind: 'Color', width: 640 } }).ok).toBe(false)
    expect(actor.dispatch('update_track_flags', { track, patch: { locked: false } }).ok).toBe(true)
    expect(actor.dispatch('update_layer_params', { layer: second, patch: { kind: 'Color', width: 640 } }).ok).toBe(true)
  })

  it('uses the same refusal for renderer, MCP and dry-run', () => {
    const { actor, second } = setup()
    const before = actor.snapshot()
    expect(actor.command('update_layer_params', { layerId: second, patch: { kind: 'Color', width: 640 } }).ok).toBe(false)
    const mcp = actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: second, patch: { kind: 'Color', width: 640 } }))
    expect(mcp.ok).toBe(false)
    if (!mcp.ok) expect(mcp.error.message).toContain('locked')
    expect(actor.dryRun([{ kind: 'DeleteLayers', ids: [second] }])).toEqual([{ ok: false, error: { error: 'LayerLocked', layer: second } }])
    expect(actor.snapshot()).toEqual(before)
  })

  it('blocks indirect link changes without losing any member', () => {
    const { actor, first, second } = setup()
    const before = actor.snapshot(), history = actor.historyStatus()
    const result = actor.dispatch('links_create', { layers: [first, second] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.error).toBe('LayerLocked')
    expect(actor.snapshot()).toEqual(before)
    expect(actor.historyStatus()).toEqual(history)
  })

  it('allows unlock and undo/redo without making the lock irreversible', () => {
    const { actor, second } = setup()
    expect(actor.dispatch('update_layer', { layer: second, patch: { locked: false } }).ok).toBe(true)
    expect(actor.dispatch('update_layer_params', { layer: second, patch: { kind: 'Color', width: 640 } }).ok).toBe(true)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(root(actor.snapshot()).tracks[0].layers[1].locked).toBe(true)
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(root(actor.snapshot()).tracks[0].layers[1].locked).toBe(false)
  })
  it('rejects a property edit after locking without changing state or history', () => {
    const { actor, second } = setup()
    const before = actor.snapshot(), history = actor.historyStatus()
    const result = actor.dispatch('update_layer_params', { layer: second, patch: { kind: 'Color', width: 640 } })
    expect(result.ok).toBe(false)
    expect(actor.snapshot()).toEqual(before)
    expect(actor.historyStatus()).toEqual(history)
  })

  it('rejects a mixed keyframe batch atomically', () => {
    const { actor, first, second } = setup()
    const before = actor.snapshot(), history = actor.historyStatus()
    const value = { mode: 'Static', value: { r: 1, g: 0, b: 0, a: 1 } }
    expect(actor.dispatch('update_param_tracks_multi', { entries: [[first, 'color', value], [second, 'color', value]] }).ok).toBe(false)
    expect(actor.snapshot()).toEqual(before)
    expect(actor.historyStatus()).toEqual(history)
  })
})
