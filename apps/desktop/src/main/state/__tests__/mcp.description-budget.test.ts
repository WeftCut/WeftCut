// apps/desktop/src/main/state/__tests__/mcp.description-budget.test.ts
// The context budget of the advertised MCP catalog — the one number an agent
// pays on every session before it has done anything.
//
// `tools/list` is read whole into the model's context by every MCP client, so
// each description and every nested schema `description` is a standing cost,
// paid per session, per client, by every agent that connects. Left unguarded
// the catalog grew to ~127 KB (~32K tokens) with descriptions that restated
// docs/mcp.md and one another; this suite is what stops it growing back.
//
// The bar is a budget, not a style: a description says what the tool does,
// when to pick it over its siblings, the non-obvious argument semantics and
// the return shape. The long form — mechanics, rationale, every refusal's
// story — lives in docs/mcp.md (human) and in the error messages themselves
// (agent, at the moment it matters). See "Tool description quality" there.
//
// Same catalog construction as mcp.catalog-bijection.test.ts: the Rust
// snapshot plus the TS-owned tables, exactly what ListTools returns.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string; description: string; input_schema?: unknown; inputSchema?: unknown }>
}
const merged = mergeMcpCatalog(
  rust.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? t.input_schema) as Record<string, unknown> })),
  [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS],
)

/** Per-tool description ceiling, in characters. */
const DESCRIPTION_CAP = 700
/** Tools whose contract genuinely does not fit the default — a two-target
 *  geometry, a ripple's refusal list, an engine-selection rule. Adding a name
 *  here is a review decision, not a way past the gate: the list is capped too. */
const COMPLEX_CAP = 1100
const COMPLEX: ReadonlySet<string> = new Set([
  'add_effect', 'add_transition', 'update_transition', 'update_composition', 'update_layer_params',
  'delete_layers', 'ripple_delete_gap', 'move_layers_to_composition', 'create_group',
  'remove_pauses', 'detect_pauses', 'analyze_clip', 'extract_clip_audio', 'transcribe_clip', 'describe_clip',
  'get_param_track',
  // Three tools' contracts in one (ADR 0074).
  'update_keyframe',
])
/** A nested schema `description` is a hint on one field, not a second essay. */
const PROPERTY_DESCRIPTION_CAP = 260
/** The whole catalog, compact JSON, as the wire carries it. The first pass
 *  under this gate landed at ~92 KB (from ~127 KB) without touching the tool set;
 *  lowering it further is the merge / on-demand-toolset work, not more trimming. */
const CATALOG_BYTE_BUDGET = 94_000

function compact(v: unknown): string { return JSON.stringify(v) }

describe('MCP catalog context budget', () => {
  it('keeps every tool description under its cap', () => {
    const over = merged
      .map((t) => ({ name: t.name, len: (t.description ?? '').length, cap: COMPLEX.has(t.name) ? COMPLEX_CAP : DESCRIPTION_CAP }))
      .filter((r) => r.len > r.cap)
    expect(over, 'descriptions over budget (name, length, cap)').toEqual([])
  })

  it('keeps the complex allowlist small and honest', () => {
    expect(COMPLEX.size).toBeLessThanOrEqual(17)
    const names = new Set(merged.map((t) => t.name))
    for (const n of COMPLEX) expect(names.has(n), `${n} is allowlisted but not advertised`).toBe(true)
  })

  it('keeps every nested property description short', () => {
    const over: string[] = []
    const walk = (s: unknown, path: string): void => {
      if (s === null || typeof s !== 'object') return
      if (Array.isArray(s)) { s.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
      const o = s as Record<string, unknown>
      if (path.includes('.') && typeof o.description === 'string' && o.description.length > PROPERTY_DESCRIPTION_CAP) {
        over.push(`${path} (${o.description.length})`)
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'description' && k !== 'enum') walk(v, `${path}.${k}`)
    }
    for (const t of merged) walk(t.inputSchema, t.name)
    expect(over).toEqual([])
  })

  it('advertises no schema envelope an agent never reads', () => {
    const noisy: string[] = []
    const walk = (s: unknown, path: string): void => {
      if (s === null || typeof s !== 'object') return
      if (Array.isArray(s)) { s.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
      const o = s as Record<string, unknown>
      for (const k of ['$schema', 'title', 'format']) if (k in o) noisy.push(`${path}.${k}`)
      if ('default' in o && o.default === null) noisy.push(`${path}.default`)
      for (const [k, v] of Object.entries(o)) if (k !== 'properties') walk(v, `${path}.${k}`)
      // `properties` values are schemas; their KEYS may legitimately be named `format` etc.
      const props = o.properties as Record<string, unknown> | undefined
      if (props) for (const [k, v] of Object.entries(props)) walk(v, `${path}.${k}`)
    }
    for (const t of merged) walk(t.inputSchema, t.name)
    expect(noisy).toEqual([])
  })

  it('fits the whole catalog in the byte budget', () => {
    const bytes = merged.reduce((n, t) => n + compact({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length, 0)
    expect(bytes, `catalog is ${bytes} bytes (~${Math.round(bytes / 4)} tokens)`).toBeLessThanOrEqual(CATALOG_BYTE_BUDGET)
  })
})
