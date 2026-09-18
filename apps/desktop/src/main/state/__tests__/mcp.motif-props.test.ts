// apps/desktop/src/main/state/__tests__/mcp.motif-props.test.ts
// A placed Motif's props through the declared `kind: "Motif"` arm: known props
// merge, an unknown one is refused against the manifest, nothing is stored on
// a refusal.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type MotifParams } from '../model'
import { MotifCatalog } from '../../../shared/motifs/catalog'
import { root } from './fixtures/project'

function placed() {
  const idGen = seededGen()
  const catalog = new MotifCatalog()
  const actor = createActor({ initial: blankProject(idGen, 'motif'), idGen, motifCatalog: catalog, clock: () => '<TS>' })
  const r = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const layerId = r.value as string
  const schema = catalog.get('countdown')!.props_schema as Record<string, { type: string; default: unknown }>
  const params = () => root(actor.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)!.params as MotifParams
  return { actor, layerId, schema, params }
}
const patch = (actor: ReturnType<typeof placed>['actor'], layerId: string, props: Record<string, unknown>) =>
  actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: layerId, patch: { kind: 'Motif', props } }))

describe('update_layer_params { kind: Motif, props }', () => {
  it('merges a known prop, field-wise, leaving the others', () => {
    const { actor, layerId, schema, params } = placed()
    const [key, spec] = Object.entries(schema).find(([, s]) => s.type === 'number' || s.type === 'string')!
    const value = spec.type === 'number' ? (spec.default as number) + 1 : `${String(spec.default)}!`
    const before = { ...params().props }
    const r = patch(actor, layerId, { [key]: value })
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    expect(params().props[key]).toBe(value)
    for (const k of Object.keys(before)) if (k !== key) expect(params().props[k]).toEqual(before[k])
  })

  it('refuses a prop the manifest does not declare, naming props_schema, and stores nothing', () => {
    const { actor, layerId, params } = placed()
    const before = { ...params().props }
    const r = patch(actor, layerId, { nope: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('nope')
    expect(r.error.message).toContain('props_schema')
    expect(params().props).toEqual(before)
  })

  it('a rebind starts the props over, from the NEW manifest', () => {
    // The old motif's props are not the new one's: keeping them would leave a
    // layer naming `lower-third` while carrying countdown's keys, which no
    // render reads and no validate catches.
    const { actor, layerId, params } = placed()
    const r = actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: layerId, patch: { kind: 'Motif', motif_id: 'lower-third' } }))
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    expect(params().motif_id).toBe('lower-third')
    expect(Object.keys(params().props)).not.toContain('seconds')
  })

  it('a prop the NEW motif does not declare is refused on a rebind, and nothing is stored', () => {
    const { actor, layerId, params } = placed()
    const before = { ...params().props }
    const r = actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: layerId, patch: { kind: 'Motif', motif_id: 'lower-third', props: { seconds: 3 } } }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.message).toContain('props_schema')
    expect(params().motif_id).toBe('countdown')
    expect(params().props).toEqual(before)
  })

  it('props that shorten the content pull the layer in, and the record says so', () => {
    // The clamp is not a grid landing, so it is the one adjustment an agent
    // cannot infer: `adjusted` names the field, what it was and what it is.
    const { actor, layerId } = placed()
    const r = actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: layerId, patch: { kind: 'Motif', props: { seconds: 1 } } }))
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    const rec = JSON.parse(r.result.content[0].text) as { t_end_us: number; adjusted: Array<{ field: string; requested: number; applied: number; reason: string }> }
    expect(rec.t_end_us).toBe(1_000_000)
    expect(rec.adjusted).toContainEqual({ field: 't_end_us', requested: 5_000_000, applied: 1_000_000, reason: 'content' })
  })

  it('the Motif variant of the advertised schema carries props', () => {
    const { actor, layerId } = placed()
    // A wrong type is refused too — the manifest, not the storage, decides.
    const [key] = Object.entries(placed().schema).find(([, s]) => s.type === 'number')!
    const r = patch(actor, layerId, { [key]: 'not a number' })
    expect(r.ok).toBe(false)
  })
})
