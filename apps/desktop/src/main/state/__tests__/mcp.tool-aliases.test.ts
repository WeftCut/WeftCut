// apps/desktop/src/main/state/__tests__/mcp.tool-aliases.test.ts
// Gate for the retired-tool-name table (`main/mcp/toolAliases.ts`).
//
// A rename on this surface is only safe because the old name keeps dispatching.
// Two things have to stay true for that to hold, and neither is visible at the
// call site: the retired name must NOT be advertised (or the catalog teaches two
// names for one tool, and an agent learns the one being retired), and its target
// MUST be (or the alias resolves to `unknown tool`, which is the exact failure
// the table exists to prevent — silently, since nothing else would notice).
//
// Catalog construction is mcp.tool-labels.test.ts': the Rust snapshot plus the
// TS-owned mutation and motif tables, which is what ListTools returns.
// REGEN-FREE — no napi addon at test time.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'
import { RETIRED_MCP_TOOL_NAMES, resolveMcpToolName, withCanonicalToolName } from '../../mcp/toolAliases'
import { routeMcpTool } from '../../mcp/mutationTools'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string }>
}
const advertised = new Set(mergeMcpCatalog(rust.tools, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]).map((t) => t.name))
const entries = Object.entries(RETIRED_MCP_TOOL_NAMES)

describe('retired MCP tool names', () => {
  it('are not advertised', () => {
    expect(entries.map(([old]) => old).filter((old) => advertised.has(old))).toEqual([])
  })

  it('each point at a tool that is', () => {
    expect(entries.filter(([, now]) => !advertised.has(now))).toEqual([])
  })

  it('resolve to their target, and leave a live name alone', () => {
    for (const [old, now] of entries) expect(resolveMcpToolName(old), old).toBe(now)
    expect(resolveMcpToolName('add_track')).toBe('add_track')
  })

  // Resolution happens before routing, so a retired name never reaches
  // routeMcpTool — but only because its target routes somewhere real. A target
  // that fell out of every table would route 'rust' and 404 in the addon.
  it('each resolve to a name the router serves in TS', () => {
    for (const [, now] of entries) expect(routeMcpTool(now), now).not.toBe('rust')
  })

  it("rewrite the request name without mutating the caller's object", () => {
    const req = { method: 'tools/call', params: { name: 'checkpoint', arguments: { label: 'x' } } }
    const out = withCanonicalToolName(req)
    expect(out.params.name).toBe('create_checkpoint')
    expect(out.params.arguments).toEqual({ label: 'x' })
    expect(req.params.name).toBe('checkpoint')
  })

  it('pass a live request through unchanged, object identity included', () => {
    const req = { method: 'tools/call', params: { name: 'add_track', arguments: {} } }
    expect(withCanonicalToolName(req)).toBe(req)
  })
})
