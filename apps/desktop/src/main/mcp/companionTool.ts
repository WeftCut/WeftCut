// apps/desktop/src/main/mcp/companionTool.ts
//
// `open_companion`: the link to the companion page (`main/companion/`), for a
// desktop host's built-in browser beside the chat. The host answers it from the
// link it was started with; it carries no UI resource, so calling it draws
// nothing in the chat. Answers with or without a project open
// (`APP_SCOPE_TOOLS`): the page says which.
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import { mcpDef } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'
import { toolErrorResult } from './toolResult.js'

export const OPEN_COMPANION = 'open_companion'

/** `link` is null where no listener serves the page (a session built without
 *  one, as in tests). */
export function runOpenCompanion(link: string | null, args: Record<string, unknown>): ServerResult {
  mcpDef(OPEN_COMPANION).parseDedicated!(args)
  if (link === null) {
    return toolErrorResult({ code: 'invalid_request', message: 'This WeftCut session serves no companion page.', data: { error: 'CompanionUnavailable' } })
  }
  return toolRecord({ url: link }) as unknown as ServerResult
}
