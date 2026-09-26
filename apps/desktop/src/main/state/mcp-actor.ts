// apps/desktop/src/main/state/mcp-actor.ts
//
// The one place an MCP client's name becomes an `Actor`. The name is what the
// client declared in `initialize` — untrusted, unbounded text — and it lands
// in history entries, checkpoints, log rows and an aria-label, none of which
// the log redactor sees. So it is normalized here, once, before it reaches any
// of them.
import type { Actor } from './history'

/** What an MCP call is stamped with when no client has named itself
 *  (pre-`initialize`, or a caller that passes none). */
export const MCP_FALLBACK_CLIENT = 'mcp'

/** Long enough for any real client id, short enough that it cannot dominate a
 *  log ring entry. */
export const CLIENT_MAX_BYTES = 64

// C0 and C1 control characters, DEL included.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** The client name as it is recorded: control characters stripped, trimmed,
 *  clamped to `CLIENT_MAX_BYTES` of UTF-8 on a code-point boundary, and the
 *  fallback when nothing is left. */
export function normalizeClientName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(CONTROL, '').trim()
  if (clean === '') return MCP_FALLBACK_CLIENT
  let out = ''
  let bytes = 0
  for (const ch of clean) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (bytes + n > CLIENT_MAX_BYTES) break
    out += ch
    bytes += n
  }
  return out.trimEnd()
}

export function mcpActor(client?: string | null): Actor {
  return { kind: 'Agent', client: normalizeClientName(client) }
}
