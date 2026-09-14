// apps/desktop/src/main/state/__tests__/mcp.docs-coverage.test.ts
// Coverage gate for the MCP design doc — the OTHER direction from
// mcp.skill-conformance.test.ts.
//
// That suite asks "is everything the prose names still real?", which catches a
// rename leaving a dead reference behind. This one asks the inverse: "is
// everything real also named?" — which catches a tool landing with no entry in
// `docs/mcp.md`. Nothing enforced that until now, and seven surfaces had drifted
// out of the doc across three unrelated subsystems, which is the shape of an
// unguarded surface rather than of a forgetful author.
//
// `docs/mcp.md` is the human-facing contract for the whole MCP surface: a tool
// absent from it is one nobody reviewing the design can see. The bar is
// membership, not depth — this gate cannot judge whether an entry is any good
// (that is what "Tool description quality" in the doc itself is for), only that
// one exists.
//
// Catalog source is the same fixture-plus-TS-tables union the bijection gate
// uses, so this stays REGEN-FREE (no napi addon at test time).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { MOTIF_TOOL_DEFS, MOTIF_RESOURCE_DEFS } from '../../mcp/motifToolDefs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const doc = readFileSync(path.join(repoRoot, 'docs/mcp.md'), 'utf8')

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string }>
  resources: Array<{ uri: string }>
  prompts: Array<{ name: string }>
}

const toolNames = [
  ...rust.tools.map((t) => t.name),
  ...MCP_TOOL_DEFS.map((d) => d.name),
  ...MOTIF_TOOL_DEFS.map((d) => d.name),
]
const resourceUris = [...rust.resources.map((r) => r.uri), ...MOTIF_RESOURCE_DEFS.map((r) => r.uri)]
const promptNames = rust.prompts.map((p) => p.name)

// Advertised surfaces deliberately left out of `docs/mcp.md`. Empty, and the bar
// for an entry is high: the doc is where a reader learns what the agent can
// reach, so "it is obvious" or "it is internal" are not reasons — an advertised
// tool is neither. A genuine entry would be a surface that is advertised only as
// a transitional shim and is documented as removed.
const UNDOCUMENTED: ReadonlySet<string> = new Set<string>()

/** The doc writes a tool as a backticked SIGNATURE — `` `detect_pauses { … }` ``
 *  — not as a bare backticked name, so membership is "a backtick followed by
 *  this name at a word boundary". The boundary is what keeps `ping` from being
 *  satisfied by the word "mapping", and the leading backtick is what keeps it
 *  from being satisfied by prose that merely says the word. */
function documented(name: string): boolean {
  return new RegExp('`' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(doc)
}

describe('docs/mcp.md ↔ MCP catalog (coverage gate)', () => {
  it('every advertised tool has an entry in docs/mcp.md', () => {
    const missing = toolNames.filter((n) => !UNDOCUMENTED.has(n) && !documented(n)).sort()
    // A hit here is a tool that ships with no design-doc entry. Write one in the
    // section it belongs to (its own tool description is the source of truth to
    // condense from) — do NOT reach for UNDOCUMENTED.
    expect(missing).toEqual([])
  })

  it('every advertised resource URI has an entry in docs/mcp.md', () => {
    expect(resourceUris.filter((u) => !UNDOCUMENTED.has(u) && !doc.includes(u)).sort()).toEqual([])
  })

  it('every advertised prompt has an entry in docs/mcp.md', () => {
    expect(promptNames.filter((n) => !UNDOCUMENTED.has(n) && !documented('/' + n)).sort()).toEqual([])
  })

  it('the extraction is alive: the doc still matches a healthy number of tools', () => {
    // Guards the gate itself. A regex regression, a mis-resolved repo root, or a
    // truncated read would make every membership test above pass vacuously.
    expect(toolNames.length).toBeGreaterThanOrEqual(80)
    expect(toolNames.filter(documented).length).toBeGreaterThanOrEqual(80)
  })

  it('UNDOCUMENTED carries no dead entries', () => {
    const advertised = new Set([...toolNames, ...resourceUris, ...promptNames])
    expect([...UNDOCUMENTED].filter((n) => !advertised.has(n))).toEqual([])
  })
})
