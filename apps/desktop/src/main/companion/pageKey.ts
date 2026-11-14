// apps/desktop/src/main/companion/pageKey.ts
//
// The companion page's key: what its routes accept and the link carries in its
// fragment. Kept in the profile, apart from the MCP bearer (`mcp_auth.json`),
// so a page left open finds the app again after a restart, and so the key in a
// browser's history reads the project and drives the player, nothing more.
// Never rotated by itself.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { nodeAtomicWriteIo, writeFileAtomic, type AtomicWriteIo } from '../atomicWrite.js'

export const PAGE_KEY_FILE = 'companion_key.json'

const PAGE_KEY = /^[0-9a-f]{64}$/

export interface PageKeyIo {
  /** The file's text, or null when it cannot be read. */
  read(file: string): string | null
  write: AtomicWriteIo
}

/** Owner-only on POSIX: `mode` applies when the temp file is created, and the
 *  chmod covers a temp left behind by a crash. Windows maps both to the
 *  read-only bit and gains nothing. */
const ownerOnlyWriteIo: AtomicWriteIo = {
  ...nodeAtomicWriteIo,
  open: (p) => {
    const fd = fs.openSync(p, 'w', 0o600)
    fs.fchmodSync(fd, 0o600)
    return fd
  },
}

export const NODE_PAGE_KEY_IO: PageKeyIo = {
  read: (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } },
  write: ownerOnlyWriteIo,
}

/** The key in `<dir>/companion_key.json`, or a new one written there when the
 *  file is missing or does not hold a valid key. A failed write still returns
 *  the new key: the page works for this run and the next run mints another. */
export function loadOrCreatePageKey(dir: string, io: PageKeyIo = NODE_PAGE_KEY_IO, now: () => Date = () => new Date()): string {
  const file = path.join(dir, PAGE_KEY_FILE)
  const stored = parse(io.read(file))
  if (stored !== null) return stored
  const key = randomBytes(32).toString('hex')
  try {
    writeFileAtomic(io.write, file, JSON.stringify({ page_key: key, created_at: now().toISOString() }))
  } catch (error) {
    console.warn('[companion] the page key could not be saved; links from this run stop working after a restart', error)
  }
  return key
}

function parse(text: string | null): string | null {
  if (text === null) return null
  try {
    const key = (JSON.parse(text) as { page_key?: unknown }).page_key
    return typeof key === 'string' && PAGE_KEY.test(key) ? key : null
  } catch {
    return null
  }
}
