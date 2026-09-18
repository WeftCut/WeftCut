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

  it('the Motif variant of the advertised schema carries props', () => {
    const { actor, layerId } = placed()
    // A wrong type is refused too — the manifest, not the storage, decides.
    const [key] = Object.entries(placed().schema).find(([, s]) => s.type === 'number')!
    const r = patch(actor, layerId, { [key]: 'not a number' })
    expect(r.ok).toBe(false)
  })
})
