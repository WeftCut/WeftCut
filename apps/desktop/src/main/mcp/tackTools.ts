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
import type { TackFollows, TackView } from '../../shared/agent-activity.js'

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
    if (name === 'create_tacks') {
      const inputs = p.tacks as TackInput[]
      const ids = store.create(inputs)
      const views = store.viewsOf(new Set(ids))
      const follows = ids.map((id) => views.find((v) => v.id === id)!.follows)
      const hints = createTackHints(inputs, follows)
      return toolRecord({ tack_ids: ids, follows, ...(hints.length ? { hints } : {}) }) as unknown as ServerResult
    }
    if (name === 'update_tack') return toolRecord(store.update(p.tack_id as string, p.patch as TackPatch)) as unknown as ServerResult
    const selector = typeof p.session_id === 'string' ? { session_id: p.session_id } : { tack_ids: p.tack_ids as string[] }
    return toolRecord({ deleted_tack_ids: store.delete(selector) }) as unknown as ServerResult
  } catch (e) {
    if (e instanceof TackError) return tackErrorResult(e)
    if (e instanceof McpArgError) return toolErrorResult(e.toJson())
    throw e
  }
}

// A clock reading in prose: `12:34`, `1:02.5`, `00:01:02:03`, `4s`, `4.5 s`,
// `250 ms`, `3 min`, `2 seconds`, `4秒`, `250毫秒`, `3分钟`.
const TIME_REFERENCE = new RegExp([
  String.raw`\b\d{1,2}:\d{2}(?::\d{2})?(?:[:;.,]\d{1,3})?\b`,
  String.raw`\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|mins?|minutes?)\b`,
  String.raw`\d+(?:\.\d+)?\s?(?:毫秒|秒|分钟)`,
].join('|'), 'i')

/** Soft advice on a created batch — never a refusal. A label or body that
 *  names a time goes stale as soon as an edit moves the material, while the
 *  panel always shows where the tack is now; and a tack with no clip under
 *  either end follows nothing. */
export function createTackHints(inputs: readonly Pick<TackInput, 'label' | 'body' | 'anchor_layer_id'>[], follows: readonly TackFollows[]): string[] {
  const hints: string[] = []
  inputs.forEach((input, i) => {
    const time = TIME_REFERENCE.exec(input.label) ?? TIME_REFERENCE.exec(input.body)
    if (time) hints.push(`tacks[${i}] mentions a time ("${time[0]}"): the panel shows each tack's live place, which follows later edits, so describe the content (what is said or shown) instead — update_tack can rewrite it.`)
    const f = follows[i]!
    if (input.anchor_layer_id === null && f.start === null && f.end === null)
      hints.push(`tacks[${i}] has no clip under either end, so it follows nothing and keeps its timeline time through later edits.`)
  })
  return hints
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
