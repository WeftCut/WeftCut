// apps/desktop/bench/proxy/mirror.mjs
//
// One-way mirror of the agent's local working directory onto the remote app
// host, for the MCP proxy (proxy.ts), which syncs before forwarding every
// tools/call. Scan → diff against what was last pushed → an sftp batch.
//
// One-way means exactly that: what the agent wrote locally is what the app
// sees. Files the APP writes into the mirror (a linked Motif draft written
// through by update_motif_files) are never pulled back, and are only touched
// by a later push when the agent writes or deletes the same path itself.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** @typedef {{ files: Map<string, string>, dirs: Set<string> }} Snapshot  rel path (POSIX) → content sha1 */
/** @typedef {{ mkdirs: string[], puts: string[], rmFiles: string[], rmDirs: string[] }} SyncPlan */

/** Everything under `root` except the top-level names in `exclude`. */
export function scanDir(root, { exclude = ['.claude'] } = {}) {
  /** @type {Snapshot} */
  const snap = { files: new Map(), dirs: new Set() }
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!rel && exclude.includes(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        snap.dirs.add(r)
        walk(abs, r)
      } else if (e.isFile()) {
        snap.files.set(r, createHash('sha1').update(fs.readFileSync(abs)).digest('hex'))
      }
      // Symlinks and specials are not mirrored: the agent's file tools do not
      // make them.
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return snap
}

export const emptySnapshot = () => ({ files: new Map(), dirs: new Set() })

const depth = (p) => p.split('/').length

/** What to do remotely to turn `prev` into `next`. Dirs are created shallow
 *  first and removed deep first, files removed before their dirs. */
export function planSync(prev, next) {
  const mkdirs = [...next.dirs].filter((d) => !prev.dirs.has(d)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  const puts = [...next.files].filter(([f, h]) => prev.files.get(f) !== h).map(([f]) => f).sort()
  const rmFiles = [...prev.files.keys()].filter((f) => !next.files.has(f)).sort()
  const rmDirs = [...prev.dirs].filter((d) => !next.dirs.has(d)).sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))
  return { mkdirs, puts, rmFiles, rmDirs }
}

export const isEmptyPlan = (p) => !p.mkdirs.length && !p.puts.length && !p.rmFiles.length && !p.rmDirs.length

/** sftp batch commands for `plan`. `remoteRoot` in sftp's spelling
 *  (`/C:/Users/...`). Removals are `-`-prefixed: a file the app already
 *  deleted must not abort the batch. A name sftp cannot quote is refused. */
export function sftpBatch(plan, localRoot, remoteRoot) {
  const q = (s) => {
    if (/["\r\n]/.test(s)) throw new Error(`cannot mirror a path containing a quote or newline: ${JSON.stringify(s)}`)
    return `"${s}"`
  }
  const remote = (rel) => `${remoteRoot.replace(/\/+$/, '')}/${rel}`
  const lines = []
  for (const d of plan.mkdirs) lines.push(`-mkdir ${q(remote(d))}`)
  for (const f of plan.puts) lines.push(`put ${q(path.join(localRoot, ...f.split('/')))} ${q(remote(f))}`)
  for (const f of plan.rmFiles) lines.push(`-rm ${q(remote(f))}`)
  for (const d of plan.rmDirs) lines.push(`-rmdir ${q(remote(d))}`)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * A mirror bound to one local directory and one transport.
 * @param {{ localRoot: string, push: (plan: SyncPlan) => Promise<void> }} opts
 */
export function createMirror({ localRoot, push }) {
  let last = emptySnapshot()
  return {
    /** Push whatever changed since the last sync. Returns the plan applied. */
    async sync() {
      const next = scanDir(localRoot)
      const plan = planSync(last, next)
      if (!isEmptyPlan(plan)) await push(plan)
      last = next
      return plan
    },
  }
}
