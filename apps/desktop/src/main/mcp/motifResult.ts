import { toolJson, type ToolResultJson } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'

/** A catalog row as an agent reads it (`list_motifs`, `motifs://current`):
 *  no HTML, and one revision field. `content_hash` is the same value as
 *  `revision`; the renderer's own catalog keeps it for its frame caches. */
export function agentMotifRow(row: Record<string, unknown>): Record<string, unknown> {
  const { html: _html, content_hash: _hash, ...rest } = row
  return rest
}

export function shapeMotifMcpResult(name: string, raw: unknown, _args: Record<string, unknown> = {}): ToolResultJson {
  if (name === 'list_motifs') return toolJson((raw as Array<Record<string, unknown>>).map(agentMotifRow))
  return toolRecord(raw as Record<string, unknown>)
}
