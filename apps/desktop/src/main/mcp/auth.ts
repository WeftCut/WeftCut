import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const AUTH_FILE = () => path.join(app.getPath('userData'), 'mcp_auth.json')

export interface McpAuth {
  token: string
  port: number
}

export function loadOrInitAuth(): McpAuth {
  try {
    const raw = fs.readFileSync(AUTH_FILE(), 'utf8')
    const a = JSON.parse(raw) as McpAuth
    if (a.token && typeof a.port === 'number') return a
  } catch {
    /* fall through to fresh */
  }
  return { token: randomBytes(32).toString('hex'), port: 0 } // 0 → OS-pick at listen
}

/// Persist the token/port pair, owner-readable only.
///
/// `0600` is the only confidentiality lever this file has: the stdio shim is a
/// plain Node process that re-reads it on every connect, so encrypting it
/// (Electron `safeStorage`) would lock the shim out. `mode` is honored on
/// creation alone, hence the explicit chmod for a rewrite. POSIX-only in
/// effect — Windows maps the mode to the read-only bit and gains nothing.
export function saveAuth(a: McpAuth): void {
  try {
    fs.writeFileSync(AUTH_FILE(), JSON.stringify(a), { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(AUTH_FILE(), 0o600)
  } catch {
    /* best-effort */
  }
}

export function rotateToken(a: McpAuth): McpAuth {
  const next = { ...a, token: randomBytes(32).toString('hex') }
  saveAuth(next)
  return next
}
