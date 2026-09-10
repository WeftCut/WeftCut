// Every tool the MCP host advertises has an `agent_panel.tools.<name>` label.
//
// The Agent panel names an activity by its history label once the mutation has
// COMMITTED (`main/agent/activity.ts` copies `label_key` off the history entry).
// A refused, failed, dry-run or still-running call has no history entry, so the
// panel falls back to `agent_panel.tools.<tool>` — and without that key it
// prints the tool name itself with the underscores swapped for spaces
// (`renderer/agent/AgentPanel.tsx`). An identifier is not copy, so the fallback
// has to resolve for every advertised tool. Key parity between locales is
// compile-time (`Resources`), so en-US alone is checked here. Same catalog
// construction as mcp.catalog-bijection.test.ts: the Rust snapshot plus the
// TS-owned mutation and motif tables, which is exactly what ListTools returns.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import en from '../../../renderer/i18n/locales/en-US'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string }>
}
const merged = mergeMcpCatalog(rust.tools, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS])
const labels: Record<string, string> = en.agent_panel.tools

describe('agent_panel.tools labels', () => {
  it('cover every advertised tool', () => {
    const missing = merged.map((t) => t.name).filter((name) => !labels[name])
    expect(missing).toEqual([])
  })

  it('are copy, not identifiers', () => {
    for (const [name, label] of Object.entries(labels)) {
      expect(label, name).not.toMatch(/_/)
      expect(label, name).not.toBe(name)
    }
  })
})
