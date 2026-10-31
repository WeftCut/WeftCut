// apps/desktop/src/main/state/__tests__/mcp.time-base-names.test.ts
// Constraint 2 of docs/mcp.md ("The time base is in the name"), as a gate.
// WeftCut has three clocks — the timeline, a media file's own time and a
// layer's local time — and an agent that reads one where it meant another
// tacks, splits or keys at the wrong instant without any refusal to warn it.
// So every time-valued name on the MCP surface says which clock it reads:
//
// - `t_*` timeline-absolute, `src_*` source-absolute, `local_*` layer-local;
// - a bare `*_us` / `*_s` is a duration, and only the names in DURATIONS are;
// - a few timeline names put a role word before the base (ROLE_QUALIFIED);
// - one unit spelling per kind: `_us` or `_s`, never `_ms` / `_sec`.
//
// It walks every input property of the merged catalog (TS, Motif, export and
// the Rust snapshot — oneOf / anyOf variants, array items and nested objects
// included) and every result key the tool, resource and prompt descriptions
// document. The exception lists are explicit, each with its reason, and an
// entry nothing on the surface uses any more fails, so they only shrink.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'
import { MOTIF_RESOURCE_DEFS, MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { EXPORT_TOOL_DEFS } from '../../mcp/exportTools'
import { HOST_RESOURCE_DEFS, HOST_RESOURCE_TEMPLATES } from '../../mcp/hostResources'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown>; input_schema?: Record<string, unknown> }>
  resources: Array<{ uri: string; description?: string }>
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string }> }>
}
const CATALOG = mergeMcpCatalog(
  rust.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? t.input_schema) as Record<string, unknown> })),
  [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS, ...EXPORT_TOOL_DEFS],
)

/** Bare `_us` / `_s` names: spans and offsets, which have no clock. */
const DURATIONS: ReadonlySet<string> = new Set([
  'duration_us', 'delta_us', 'pad_us', 'min_pause_us', 'bridge_us', 'min_shot_us',
  'fade_in_us', 'fade_out_us', 'extended_us', 'available_us', 'removed_us',
  'wait_s', 'retry_after_s',
])

/** Timeline names with a role word before `t_`: each carries its base, and
 *  the tools they belong to are being merged (spec ticket 09) — the merge, not
 *  a rename here, is what retires the movers' spellings. */
const ROLE_QUALIFIED: ReadonlyMap<string, string> = new Map([
  ['at_t_us', 'split_layer: the cut points'],
  ['new_t_us', 'trim_layer: where the edge lands'],
  ['new_t_start_us', 'move_layer: where the layer lands'],
  ['anchor_t_start_us', 'move_layers_to_composition: where the anchor layer lands'],
  ['from_t_us', 'shift_layers: the sweep origin'],
  ['end_t_us', 'markers and tacks: a region end, the stored marker field'],
])

/** Names stored in project files or export presets that this rule would
 *  rename; renaming them is a data migration, not a surface edit. */
const STORED_NAMES: ReadonlyMap<string, string> = new Map([
  ['profile_in_us', 'audio.denoise effect param key; add_effect calls it source time'],
  ['profile_out_us', 'audio.denoise effect param key; add_effect calls it source time'],
  ['keyframe_interval_sec', 'export setting (a duration), stored in presets and project export settings'],
])

const TIME_NAME = /^[a-z][a-z0-9_]*_(?:us|s)$/
const OTHER_UNIT = /^[a-z][a-z0-9_]*_(?:ms|sec|secs|seconds)$/
const BASE = /^(?:t|src|local)_/

type Schema = Record<string, unknown>
/** Every property name under a schema, with the path it was found at. */
function propertyNames(schema: unknown, path: string, out: Array<[string, string]>): void {
  if (schema === null || typeof schema !== 'object') return
  const s = schema as Schema
  for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
    out.push([k, `${path}.${k}`])
    propertyNames(v, `${path}.${k}`, out)
  }
  if (s.items) propertyNames(s.items, `${path}[]`, out)
  if (s.additionalProperties && typeof s.additionalProperties === 'object') propertyNames(s.additionalProperties, `${path}.*`, out)
  for (const alt of ['oneOf', 'anyOf', 'allOf'] as const) for (const v of (s[alt] ?? []) as unknown[]) propertyNames(v, path, out)
  for (const defs of [s.$defs, s.definitions]) for (const [k, v] of Object.entries((defs ?? {}) as Record<string, unknown>)) propertyNames(v, `${path}#${k}`, out)
}

/** The identifiers a description documents: snake_case names with a unit. */
const documented = (text: string): string[] =>
  [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:us|s|ms|sec|secs|seconds)\b/g) ?? [])]

const inputs: Array<[string, string]> = []
for (const t of CATALOG) propertyNames(t.inputSchema, t.name, inputs)

const docs: Array<[string, string]> = []
const note = (where: string, text: string | undefined): void => { for (const k of documented(text ?? '')) docs.push([k, where]) }
for (const t of CATALOG) note(t.name, t.description)
for (const r of [...rust.resources, ...HOST_RESOURCE_DEFS, ...MOTIF_RESOURCE_DEFS]) note(r.uri, r.description)
for (const r of HOST_RESOURCE_TEMPLATES) { note(r.uriTemplate, r.description); note(`${r.uriTemplate} (variables)`, r.uriTemplate.replace(/[{}]/g, ' ')) }
for (const p of rust.prompts) {
  note(`prompt ${p.name}`, p.description)
  for (const a of p.arguments ?? []) { note(`prompt ${p.name}`, a.name); note(`prompt ${p.name}.${a.name}`, a.description) }
}

/** Why a name may stand, or null when it breaks the rule. */
function allowed(name: string): string | null {
  const stored = STORED_NAMES.get(name)
  if (stored) return stored
  if (OTHER_UNIT.test(name)) return null
  if (!TIME_NAME.test(name)) return 'not a time'
  if (BASE.test(name)) return 'base'
  if (DURATIONS.has(name)) return 'duration'
  return ROLE_QUALIFIED.get(name) ?? null
}

describe('every time-valued name on the MCP surface says its time base', () => {
  it('walks a surface that holds the names this rule introduced', () => {
    const seen = new Set([...inputs, ...docs].map(([k]) => k))
    for (const k of ['src_start_us', 'src_keyframe_us', 'src_us', 'local_t_us', 'local_t_s', 't_start_us', 'duration_us']) expect(seen, k).toContain(k)
  })

  it('every input property ending in _us or _s starts with t_, src_ or local_, or is a listed exception', () => {
    const offenders = inputs.filter(([k]) => allowed(k) === null).map(([, path]) => path)
    expect(offenders, 'input properties without a time base').toEqual([])
  })

  it('every result key a description documents does too', () => {
    const offenders = docs.filter(([k]) => allowed(k) === null).map(([k, where]) => `${where}: ${k}`)
    expect([...new Set(offenders)], 'documented keys without a time base').toEqual([])
  })

  it('every exception is still on the surface, so the lists only shrink', () => {
    const seen = new Set([...inputs, ...docs].map(([k]) => k))
    const stale = [...DURATIONS, ...ROLE_QUALIFIED.keys(), ...STORED_NAMES.keys()].filter((k) => !seen.has(k))
    expect(stale, 'exceptions nothing uses').toEqual([])
  })

  it('a source-time answer for a layer documents the mapping that places it', () => {
    const description = (name: string) => CATALOG.find((t) => t.name === name)!.description ?? ''
    for (const name of ['analyze_clip', 'describe_clip']) {
      expect(description(name), name).toContain('mapping')
      expect(description(name), name).toContain('media_id')
    }
    for (const k of ['t_start_us', 'src_in_us', 'rate']) expect(description('extract_clip_audio')).toContain(`\`${k}\``)
    const tracks = HOST_RESOURCE_DEFS.find((r) => r.uri === 'project://tracks')!.description
    expect(tracks).toContain('media_id')
    expect(tracks).toContain('rate')
  })
})
