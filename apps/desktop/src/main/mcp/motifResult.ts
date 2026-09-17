// apps/desktop/src/main/mcp/motifResult.ts
// Shape a runMotifTool raw value into the MCP ToolResult for the motif tools.
// TS owns this contract; the result shape per tool is:
//   list_motifs            → json(payload with `html` removed)
//   get_motif_source       → json({manifest, html})
//   write_motif_draft      → record({ draft_id })
//   install_motif          → record({ motif_id })
//   delete_motif           → record({ motif_id })
//   motif_staleness_report → json(array)
//   acknowledge_motif_staleness → text(count)
import { toolJson, toolText, type ToolResultJson } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'

export function shapeMotifMcpResult(name: string, raw: unknown, args: Record<string, unknown> = {}): ToolResultJson {
  switch (name) {
    case 'list_motifs': {
      const stripped = (raw as Array<Record<string, unknown>>).map((e) => {
        const { html: _html, ...rest } = e
        return rest
      })
      return toolJson(stripped)
    }
    case 'get_motif_source':
      return toolJson(raw)
    case 'write_motif_draft':
      return toolRecord({ draft_id: raw as string })
    case 'install_motif':
      return toolRecord({ motif_id: raw as string })
    case 'delete_motif':
      return toolRecord({ motif_id: String(args.id ?? '') })
    case 'motif_staleness_report':
      return toolJson(raw)
    case 'acknowledge_motif_staleness':
      return toolText(String(raw as number))
    default:
      throw new Error(`shapeMotifMcpResult: unhandled tool ${name}`)
  }
}
