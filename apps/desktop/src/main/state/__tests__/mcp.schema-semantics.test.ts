// apps/desktop/src/main/state/__tests__/mcp.schema-semantics.test.ts
// The schema carries the semantics: every property described, a `null` arm
// only where null means something, `update_layer_params.patch` one variant per
// kind, `param_key` an enum plus pattern, `trim_layer.edge` an enum. A
// vocabulary the schema leaves to prose is learned by failing calls, so these
// pin what the schema says against what the parsers accept and the two cannot
// drift apart.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MCP_TOOL_DEFS, LAYER_PARAMS_KEYS, LAYER_PARAM_KINDS, PARAM_KEYS, EFFECT_PARAM_KEY_PATTERN,
  parseLayerParamsPatch, McpArgError,
} from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { mediaItemTemplate } from '../mutations/media'

type Schema = Record<string, any>
const def = (name: string): Schema => {
  const d = MCP_TOOL_DEFS.find((t) => t.name === name)
  if (!d) throw new Error(`no TS tool ${name}`)
  return d.inputSchema as Schema
}

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string; description: string; input_schema?: unknown; inputSchema?: unknown }>
}
const merged = mergeMcpCatalog(
  rust.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? t.input_schema) as Record<string, unknown> })),
  [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS],
)

/** Every (path, property schema) pair under a tool schema, `oneOf` / `anyOf`
 *  variants and array items included. Paths name the field, not the variant,
 *  so `update_layer_params.patch.box_w` is one path however many kinds carry it. */
function properties(schema: unknown, path: string, out: Array<[string, Schema]> = []): Array<[string, Schema]> {
  if (schema === null || typeof schema !== 'object') return out
  const s = schema as Schema
  for (const [k, v] of Object.entries<Schema>((s.properties ?? {}) as Record<string, Schema>)) {
    out.push([`${path}.${k}`, v])
    properties(v, `${path}.${k}`, out)
  }
  if (s.items) properties(s.items, `${path}[]`, out)
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    out.push([`${path}.*`, s.additionalProperties as Schema])
    properties(s.additionalProperties, `${path}.*`, out)
  }
  for (const alt of ['oneOf', 'anyOf', 'allOf'] as const) for (const v of (s[alt] ?? []) as Schema[]) properties(v, path, out)
  return out
}

describe('update_layer_params advertises one variant per kind, from the table the parser refuses against', () => {
  const patch = def('update_layer_params').properties.patch as Schema
  const variants = patch.oneOf as Array<{ properties: Record<string, Schema>; required: string[]; additionalProperties: boolean }>

  it('has a variant for every kind, the enum on `kind` naming the same seven', () => {
    expect(variants.map((v) => v.properties.kind.const)).toEqual([...LAYER_PARAM_KINDS])
    expect(patch.properties.kind.enum).toEqual([...LAYER_PARAM_KINDS])
    expect(LAYER_PARAM_KINDS).toContain('Motif') // Motif's fields ride the same patch, so its kind is in the enum
  })

  it("each variant's fields are exactly that kind's key set — no more, no fewer", () => {
    for (const v of variants) {
      const kind = v.properties.kind.const as string
      const advertised = Object.keys(v.properties).filter((k) => k !== 'kind').sort()
      expect(advertised, kind).toEqual([...LAYER_PARAMS_KEYS[kind]].sort())
      expect(v.additionalProperties, `${kind} closes its set`).toBe(false)
      for (const [k, field] of Object.entries(v.properties)) expect(typeof field.description, `${kind}.${k} described`).toBe('string')
    }
  })

  it('every field a variant advertises is one the parser takes for that kind, and one it does not is refused', () => {
    for (const v of variants) {
      const kind = v.properties.kind.const as string
      for (const k of Object.keys(v.properties)) {
        if (k === 'kind') continue
        // The value type is the field's own business; the KEY must pass the gate.
        const probe: Record<string, unknown> = { kind, [k]: v.properties[k].type === 'boolean' ? true : v.properties[k].type === 'string' ? 'x' : v.properties[k].type === 'integer' ? 1 : k === 'props' ? {} : k === 'color' || k === 'outline_color' ? { r: 0, g: 0, b: 0, a: 255 } : k === 'shadow' ? null : 1 }
        if (k === 'font_weight') probe[k] = 700
        if (k === 'align') probe[k] = 'Left'
        if (k === 'valign') probe[k] = 'Top'
        if (k === 'blend_mode') probe[k] = 'Normal'
        if (k === 'role') probe[k] = 'music'
        expect(() => parseLayerParamsPatch(probe), `${kind}.${k}`).not.toThrow()
      }
    }
    // Text has no scale of its own (ADR 0049): the Text variant omits it and the parser refuses it.
    expect(Object.keys(variants.find((v) => v.properties.kind.const === 'Text')!.properties)).not.toContain('scale_x')
    expect(() => parseLayerParamsPatch({ kind: 'Text', scale_x: 2 })).toThrow(McpArgError)
  })

  it('the Text box pair and `shadow` keep their null arm: null MEANS back to auto / no shadow, not "omitted"', () => {
    const text = variants.find((v) => v.properties.kind.const === 'Text')!.properties
    expect(text.box_w.type).toEqual(['number', 'null'])
    expect(text.box_h.type).toEqual(['number', 'null'])
    expect(text.shadow.type).toContain('null')
    expect(text.content.type).toBe('string')
  })
})

describe('param_key is an enum plus the effect-param pattern, on every tool that takes one', () => {
  const takers = MCP_TOOL_DEFS.filter((d) => 'param_key' in ((d.inputSchema as Schema).properties ?? {}))

  it('every tool that takes it advertises the same schema', () => {
    expect(takers.map((d) => d.name).sort()).toEqual(['clear_keyframes', 'delete_keyframe', 'get_param_track', 'set_extrapolation', 'set_keyframe', 'set_param_track', 'smooth_keyframes', 'update_keyframe'].sort())
    const first = JSON.stringify((takers[0].inputSchema as Schema).properties.param_key)
    for (const d of takers) expect(JSON.stringify((d.inputSchema as Schema).properties.param_key), d.name).toBe(first)
  })

  it('the enum lists the animatable params and the pattern matches an effect param path, nothing else', () => {
    const schema = (takers[0].inputSchema as Schema).properties.param_key as Schema
    expect(schema.anyOf[0].enum).toEqual([...PARAM_KEYS])
    const re = new RegExp(schema.anyOf[1].pattern as string)
    expect(re.source).toBe(new RegExp(EFFECT_PARAM_KEY_PATTERN).source)
    expect(re.test('effects[00000000-0000-7000-8000-000000000001].params[strength]')).toBe(true)
    expect(re.test('effects[nope].params[strength]')).toBe(false)
    expect(re.test('opacity')).toBe(false)
    expect(schema.description).toContain('path_progress')
  })
})

describe('enums where the parser has one', () => {
  it('trim_layer.edge advertises in | out', () => {
    expect(def('trim_layer').properties.edge.enum).toEqual(['in', 'out'])
  })
  it('add_audio_layer.role and the params role share the mixing buses, with no null in the enum', () => {
    expect(def('add_audio_layer').properties.role.enum).toEqual(['dialogue', 'music', 'sfx', 'voiceover'])
  })
})

describe('null arms are advertised only where null means something omission does not', () => {
  // The whole list. Each entry is a field where `null` is a value of its own:
  // clear a name, unpin a duration, cut a marker loose, drop an override,
  // return a text-box axis to auto, fall back to a detector's defaults, remove
  // an effect param. Growing this list is a review decision.
  const KEEP_NULL = new Set([
    'rename_track.label', 'update_layer.patch.label', 'update_link.label', 'rename_composition.label',
    'update_marker.patch.label', 'update_marker.patch.note',
    'update_composition.patch.duration_us',
    'set_marker_anchor.layer_id',
    'set_project_settings.patch.proxy_override.value', 'set_project_settings.patch.shot_review', 'set_project_settings.patch.pause_review',
    'update_layer_params.patch.box_w', 'update_layer_params.patch.box_h', 'update_layer_params.patch.shadow',
    'update_effect.patch.params.*',
  ])
  it('across the whole advertised catalog, Rust tools included', () => {
    const nullable = new Set<string>()
    for (const t of merged) for (const [path, p] of properties(t.inputSchema, t.name)) {
      const types = Array.isArray(p.type) ? p.type : []
      const enums = Array.isArray(p.enum) ? p.enum : []
      if (types.includes('null') || enums.includes(null)) nullable.add(path)
    }
    expect([...nullable].sort()).toEqual([...KEEP_NULL].sort())
  })
})

describe('the undo description and the proxy override', () => {
  it('undo names each unrecorded surface once', () => {
    const d = MCP_TOOL_DEFS.find((t) => t.name === 'undo')!.description
    expect(d).not.toContain('`update_composition`, `update_composition`')
    expect(d).toContain('`set_project_settings`')
  })

  it('proxy_override for an id that names no media is MediaNotFound, and nothing is written', () => {
    const gen = seededGen()
    const p = blankProject(gen, 'settings')
    const MID = '00000000-0000-0000-0000-0000000000aa'
    p.media_pool[MID] = mediaItemTemplate(MID, 'Video', 4_000_000)
    const a = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    const bad = a.mcpCall('set_project_settings', JSON.stringify({ patch: { proxy_override: { media_id: '00000000-0000-7000-8000-00000000dead', value: true } } }))
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('expected refusal')
    expect(bad.error.message).toContain('not found')
    expect(a.snapshot().settings.proxy_overrides).toEqual({})
    const good = a.mcpCall('set_project_settings', JSON.stringify({ patch: { proxy_override: { media_id: MID, value: false } } }))
    expect(good.ok).toBe(true)
    expect(a.snapshot().settings.proxy_overrides).toEqual({ [MID]: false })
    // The schema says where it is read back.
    expect(def('set_project_settings').properties.patch.properties.proxy_override.description).toContain('settings.proxy_overrides')
  })
})
