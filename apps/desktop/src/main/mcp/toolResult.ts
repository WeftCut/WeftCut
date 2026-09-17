// apps/desktop/src/main/mcp/toolResult.ts
//
// The ONE shape a tool refusal takes on the wire. MCP reserves JSON-RPC errors
// for a malformed request and an unknown tool; everything that goes wrong
// INSIDE a tool — a bad argument, a stale id, a blocked edit, a compute
// failure — is a `CallToolResult { isError: true }`, because that is the
// channel a model reads. A JSON-RPC error's `data` is visible to no client,
// and several count a protocol error as a server fault (health / retry logic),
// so a refusal travelling as one is both invisible and misclassified.
//
// `structuredContent` mirrors the text for clients that forward it: the
// envelope code, the message, and whatever `data` the mapper attached
// (`error`, ids, `options[]`). The text stays complete on its own — the rule
// in docs/mcp.md § Error model still holds, only the carrier changed.
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import { mapCommandError, McpArgError, type McpErrorCode, type McpToolErrorJson } from '../state/mcp-commands.js'
import type { CommandError } from '../state/errors.js'

export interface ToolErrorResult {
  isError: true
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
}

/** An unknown tool NAME is the one refusal that stays a JSON-RPC error: the
 *  request itself is malformed, there is no tool to answer it. `-32602` is the
 *  code the MCP spec's own example uses for it. */
export class UnknownToolError extends Error {
  readonly code = -32602
  constructor(readonly tool: string) {
    super(`Unknown tool: ${tool}`)
    this.name = 'UnknownToolError'
  }
}

export function toolErrorResult(err: McpToolErrorJson): ServerResult {
  const data = err.data !== null && typeof err.data === 'object' && !Array.isArray(err.data)
    ? (err.data as Record<string, unknown>)
    : err.data === undefined ? {} : { data: err.data }
  const out: ToolErrorResult = {
    isError: true,
    content: [{ type: 'text', text: err.message }],
    structuredContent: { code: err.code, message: err.message, ...data },
  }
  return out as unknown as ServerResult
}

export function isToolError(v: unknown): v is ToolErrorResult {
  return v !== null && typeof v === 'object' && (v as { isError?: unknown }).isError === true
}

/** The text a client shows for an error result — every text block joined. */
export function toolErrorText(r: ToolErrorResult): string {
  return r.content.map((c) => c.text).join('\n')
}

/** The envelope code an error result was minted from, when it carries one. */
export function toolErrorCode(r: ToolErrorResult): McpErrorCode | undefined {
  const c = r.structuredContent.code
  return c === 'invalid_params' || c === 'invalid_request' || c === 'not_found' || c === 'internal' ? c : undefined
}

/** serde's own position suffix. The caller never saw the buffer it indexes —
 *  the args were re-serialized on the way in — so the numbers point at nothing. */
const SERDE_TAIL = / at line \d+ column \d+/g
/** A message shaped like an argument fault. serde's vocabulary first, then the
 *  hybrid arms' own (`layer_id is required`, `pad_us … must be`). */
const ARG_FAULT = /\b(missing field|invalid type|unknown field|unknown variant|invalid value|is required|must be|expected )/

/** The refusal a THROWN error stands for.
 *
 *  Four sources reach here. A hybrid arm's own argument refusal is an
 *  `McpArgError`, the class every TS parser throws, and carries its code. A
 *  hybrid arm throws `Error(JSON.stringify(commandError))` — that is a
 *  `CommandError` and gets the same mapper every table tool gets, so
 *  `RippleInsideHole` reads the same from `remove_pauses` as from `delete_layers`.
 *  A napi compute throws serde text or an OS message. A thrown envelope error
 *  (`unwrapEnvelope`'s `{ code: number, message, data }`) maps its number back.
 *  `fallback` is the code for a plain message: `internal` unless the route knows
 *  its failures are the caller's (the motif store's are). */
export function thrownToToolError(err: unknown, fallback: McpErrorCode = 'internal', tool?: string): McpToolErrorJson {
  if (err instanceof McpArgError) return err.toJson()
  const e = err as { code?: unknown; message?: unknown; data?: unknown } | null
  const raw = typeof e?.message === 'string' ? e.message : String(err)
  if (typeof e?.code === 'number') {
    const code: McpErrorCode = e.code === -32602 ? 'invalid_params' : e.code === -32600 ? 'invalid_request' : e.code === -32601 ? 'not_found' : 'internal'
    return { code, message: raw.replace(SERDE_TAIL, ''), ...(e.data === undefined ? {} : { data: e.data }) }
  }
  const asCommandError = parseCommandError(raw)
  if (asCommandError) return mapCommandError(asCommandError, tool)
  const message = raw.replace(SERDE_TAIL, '')
  return { code: ARG_FAULT.test(message) ? 'invalid_params' : fallback, message }
}

function parseCommandError(s: string): CommandError | null {
  if (!s.startsWith('{')) return null
  try {
    const v = JSON.parse(s) as unknown
    if (v !== null && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string') return v as CommandError
  } catch { /* not JSON — a plain message that happens to start with a brace */ }
  return null
}
