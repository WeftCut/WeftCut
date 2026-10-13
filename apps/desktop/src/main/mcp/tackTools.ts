// apps/desktop/src/main/mcp/tackTools.ts
// The tack verbs and reads (ADR 0115), served by the host from the TackStore
// that sits beside the agent activity service — never through the actor, so
// they record no history, advance no actor revision and ignore the history
// lock. The defs live in MCP_TOOL_DEFS (`mcp-commands.ts`) with the other
// host-served dedicated tools; each arm reads its args through that parser.
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import { mcpDef, McpArgError } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'
import { toolErrorResult } from './toolResult.js'
import { TackError, type TackInput, type TackPatch, type TackStore } from '../agent/tacks.js'
import type { TackView } from '../../shared/agent-activity.js'

export const TACK_TOOLS: ReadonlySet<string> = new Set(['create_tacks', 'update_tack', 'delete_tacks'])

/** A refusal an argument could fix is `invalid_params`; the limit and a call
 *  from a replaced project opening are not. */
function tackErrorResult(e: TackError): ServerResult {
  const code = e.error === 'TackLimit' || e.error === 'NoCurrentCall' ? 'invalid_request' : 'invalid_params'
  return toolErrorResult({ code, message: e.message, data: { error: e.error, ...(e.field ? { field: e.field } : {}) } })
}

export function runTackTool(store: TackStore, name: string, args: Record<string, unknown>): ServerResult {
  try {
    const p = mcpDef(name).parseDedicated!(args)
    if (name === 'create_tacks') return toolRecord({ tack_ids: store.create(p.tacks as TackInput[]) }) as unknown as ServerResult
    if (name === 'update_tack') return toolRecord(store.update(p.tack_id as string, p.patch as TackPatch)) as unknown as ServerResult
    const selector = typeof p.session_id === 'string' ? { session_id: p.session_id } : { tack_ids: p.tack_ids as string[] }
    return toolRecord({ deleted_tack_ids: store.delete(selector) }) as unknown as ServerResult
  } catch (e) {
    if (e instanceof TackError) return tackErrorResult(e)
    if (e instanceof McpArgError) return toolErrorResult(e.toJson())
    throw e
  }
}

/** `read_project { view: "tacks", composition_id? }`: the same records the
 *  resource serves, as text. */
export function readTacksView(store: TackStore, compositionId: string | null): ServerResult {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(store.views(compositionId)) }] } as unknown as ServerResult
  } catch (e) {
    if (e instanceof TackError) return tackErrorResult(e)
    throw e
  }
}

const TACKS_URI = 'project://tacks'

/** The not-found the other `project://` reads throw (`resource-views.ts`). */
function resourceNotFound(message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = -32601
  throw e
}

/** Whether `uri` names the tacks resource (with or without its query). */
export function isTacksUri(uri: string): boolean {
  return uri === TACKS_URI || uri.startsWith(`${TACKS_URI}?`)
}

/** `project://tacks{?composition}`: every tack of this project opening, or
 *  those placed in one composition. `?composition=` is the one query key, and
 *  an unknown composition is not-found, as on the other scoped reads. */
export function readTacksResource(store: TackStore, uri: string): ServerResult {
  const q = uri.indexOf('?')
  const query = q === -1 ? null : new URLSearchParams(uri.slice(q + 1))
  if (query) for (const k of query.keys()) {
    if (k !== 'composition') resourceNotFound(`unknown query key '${k}' on ${TACKS_URI} — the one query is ?composition=<id>`)
  }
  let tacks: TackView[]
  try { tacks = store.views(query?.get('composition') ?? null) }
  catch (e) {
    if (e instanceof TackError) resourceNotFound(e.message)
    throw e
  }
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tacks, null, 2) }] } as unknown as ServerResult
}
