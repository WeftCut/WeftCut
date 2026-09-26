import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'hybrid' | 'motif'

/** MCP tools served by the native-compute → TS-write hybrid orchestrator.
 *  `auto_split_by_shot` and `remove_pauses` are the hybrids whose DEFS are
 *  TS-owned (MCP_TOOL_DEFS) rather than Rust-catalog-sourced — the other three
 *  carry Rust catalog defs — so they route 'hybrid' here (checked before
 *  MCP_TOOLS) yet advertise via the TS def set. Both shapes are the same: Rust
 *  computes (shot report / waveform peaks) and the TS actor writes, so the def
 *  has to merge into the catalog from the TS side. */
export const HYBRID_TOOLS: ReadonlySet<string> = new Set([
  'import_media', 'apply_subtitles', 'synthesize_speech', 'auto_split_by_shot',
  'remove_pauses',
])

/** Motif catalog-read + authoring + install + staleness tools, served in TS by
 *  runMotifTool. The five advertised members take their defs from TS
 *  MOTIF_TOOL_DEFS (mcpCatalog dedups by name); the two staleness tools are
 *  unadvertised. The Rust catalog carries no motif arms. */
export const MOTIF_TOOLS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif',
  'motif_staleness_report', 'acknowledge_motif_staleness',
])

/** The tools that answer while no project is open — default-deny: every tool
 *  NOT named here is refused with `NoProjectOpen` on the start screen, so a new
 *  tool cannot leak into a project the user cannot see. Pinned by
 *  `mcp.project-scope.test.ts`; widening it is an edit there too.
 *
 *  Liveness, the Motif LIBRARY (its store, not placed layers — `install_motif`
 *  rebinds nothing while no project is open), and the two ways INTO a project. */
export const APP_SCOPE_TOOLS: ReadonlySet<string> = new Set([
  'ping',
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'preview_motif_draft', 'install_motif', 'delete_motif',
  'open_project', 'create_project',
])

/** `read_project` views the host answers without the actor's project. */
const APP_SCOPE_VIEWS: ReadonlySet<string> = new Set(['session', 'effects'])

/** Resources the host answers without the actor's project. */
export const APP_SCOPE_RESOURCES: ReadonlySet<string> = new Set(['project://session', 'effects://catalog', 'motifs://current'])

/** Whether a tool call is served with no project open. */
export function servesWithoutProject(name: string, args: Record<string, unknown>): boolean {
  if (APP_SCOPE_TOOLS.has(name)) return true
  return name === 'read_project' && typeof args.view === 'string' && APP_SCOPE_VIEWS.has(args.view)
}

/** Where an MCP tool runs. motif → tsHost.motifTool (then shapeMotifMcpResult);
 *  hybrid → runHybrid; ts → tsHost.actor.mcpCall; rust → backend.
 *  motif-first so install_motif can never both hybrid and motif-route. */
export function routeMcpTool(name: string): McpRoute {
  if (MOTIF_TOOLS.has(name)) return 'motif'
  if (HYBRID_TOOLS.has(name)) return 'hybrid'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
