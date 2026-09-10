import { describe, it, expect } from 'vitest'
import { routeMcpTool, HYBRID_TOOLS, MOTIF_TOOLS } from './mutationTools'
import { MCP_TOOLS, MCP_TOOL_DEFS } from '../state/mcp-commands'
import { mergeMcpCatalog } from './mcpCatalog'
import { MOTIF_TOOL_DEFS } from './motifToolDefs'

describe('routeMcpTool', () => {
  it('routes ported mutations + reads to ts', () => {
    for (const t of ['add_color_layer', 'set_keyframe', 'undo', 'get_param_track', 'list_checkpoints', 'dry_run'])
      expect(routeMcpTool(t), t).toBe('ts')
  })
  it('routes import_media + apply_subtitles + synthesize_speech to the native-compute → TS-write hybrid', () => {
    expect(routeMcpTool('import_media')).toBe('hybrid')
    expect(routeMcpTool('apply_subtitles')).toBe('hybrid')
    expect(routeMcpTool('synthesize_speech')).toBe('hybrid')
  })
  it('add_motif routes to ts (pure TS mutation)', () => {
    expect(routeMcpTool('add_motif')).toBe('ts')
  })
  it('routes the 5 MCP motif tools to the motif route', () => {
    for (const t of ['list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif'])
      expect(routeMcpTool(t), t).toBe('motif')
  })
  it('routes motif_staleness_report and acknowledge_motif_staleness to the motif route', () => {
    expect(routeMcpTool('motif_staleness_report')).toBe('motif')
    expect(routeMcpTool('acknowledge_motif_staleness')).toBe('motif')
  })
  it('preview_motif_draft stays rust (special-cased capture in server.ts)', () => {
    expect(routeMcpTool('preview_motif_draft')).toBe('rust')
  })
  it('routes the live rust-native tools to rust', () => {
    // Link reads come from the project://current summary resource (it includes
    // `links`), not an MCP tool.
    for (const t of ['ping', 'detect_pauses', 'transcribe_clip'])
      expect(routeMcpTool(t), t).toBe('rust')
  })
  it('routes the TS-owned hybrid defs to the hybrid orchestrator (Rust compute + TS writes)', () => {
    expect(routeMcpTool('auto_split_by_shot')).toBe('hybrid')
    expect(routeMcpTool('remove_pauses')).toBe('hybrid')
  })
  it('single-writer invariant: every TS-def tool routes to ts (or hybrid for a TS-owned hybrid), never rust', () => {
    // No TS-def tool may reach the Rust project writer. Almost all route 'ts';
    // the TS-owned hybrids route 'hybrid' (HYBRID_TOOLS is consulted first) —
    // their edits still write through the TS actor, so single-writer holds.
    for (const t of MCP_TOOLS) expect(routeMcpTool(t), t).toBe(HYBRID_TOOLS.has(t) ? 'hybrid' : 'ts')
  })
  it('the hybrid tools with a TS-owned def are auto_split_by_shot and remove_pauses (the rest are Rust-catalog-sourced)', () => {
    // import_media / apply_subtitles / synthesize_speech advertise via the Rust
    // catalog, so they are NOT in MCP_TOOLS. The two whose defs are TS-owned —
    // they must merge into the catalog from the TS side — are the only overlap.
    const TS_OWNED = new Set(['auto_split_by_shot', 'remove_pauses'])
    for (const t of HYBRID_TOOLS) {
      expect(MCP_TOOLS.has(t), t).toBe(TS_OWNED.has(t))
    }
  })
})

describe('merged ListTools is a clean catalog↔handler bijection', () => {
  // Simulate a Rust catalog that still advertises TS-executed names — the merge
  // must stay a duplicate-free union where every name routes to exactly one engine.
  const rust4a = [...MCP_TOOLS].map((n) => ({ name: n })).concat(
    [{ name: 'ping' }, { name: 'list_motifs' }, { name: 'get_motif_source' }, { name: 'preview_motif_draft' },
     { name: 'detect_pauses' }, { name: 'transcribe_clip' }, { name: 'import_media' }, { name: 'apply_subtitles' },
     { name: 'install_motif' }, { name: 'motif_staleness_report' }, { name: 'acknowledge_motif_staleness' }, { name: 'synthesize_speech' }],
  )
  const tsDefs = MCP_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  const motifDefs = MOTIF_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  const merged = mergeMcpCatalog(rust4a, [...tsDefs, ...motifDefs])

  it('no duplicate names', () => {
    const names = merged.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('no advertised-but-unhandled / handled-but-unadvertised', () => {
    const advertised = new Set(merged.map((t) => t.name))
    for (const n of MCP_TOOLS) expect(advertised.has(n)).toBe(true)   // every ts tool advertised
    for (const t of merged) {
      const r = routeMcpTool(t.name)
      if (r === 'ts') expect(MCP_TOOLS.has(t.name)).toBe(true)
      if (r === 'hybrid') expect(HYBRID_TOOLS.has(t.name)).toBe(true)
      if (r === 'motif') expect(MOTIF_TOOLS.has(t.name)).toBe(true)
    }
  })
})
