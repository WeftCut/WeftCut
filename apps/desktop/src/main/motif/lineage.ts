// Which Motif each package of the store is a version of: its lineage, a uid
// apart from its id (ADR 0171). Kept beside the packages, never in them, so no
// package path is reserved for it and a folder copied by hand starts a new
// lineage. Owns the record; the rules for when a package takes which lineage
// are `workspace.ts`'s.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The record's file name in the store root. */
export const LINEAGE_FILE = '.lineage.json'

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether `value` is a lineage uid: a lowercase RFC 9562 UUID string. */
export function isLineageUid(value: unknown): value is string {
  return typeof value === 'string' && UID.test(value)
}

export function newLineage(): string {
  return randomUUID()
}

/** Lineage uids by package key: a package's path in the store, `<id>` for an
 *  installed Motif and `drafts/<id>` for a draft. */
export class MotifLineage {
  private uids: Map<string, string> | null = null

  /** Without a file the record lasts the process. */
  constructor(private readonly file: string | null = null) {}

  /** The uid of `key`, recording a new lineage when it has none. */
  of(key: string): string {
    const uids = this.load()
    const known = uids.get(key)
    if (known) return known
    const uid = newLineage()
    uids.set(key, uid)
    this.save()
    return uid
  }

  /** The uid recorded for `key`, without minting one. */
  peek(key: string): string | null {
    return this.load().get(key) ?? null
  }

  set(key: string, uid: string): void {
    if (!isLineageUid(uid)) throw new Error(`Invalid Motif lineage: ${uid}`)
    const uids = this.load()
    if (uids.get(key) === uid) return
    uids.set(key, uid)
    this.save()
  }

  /** `to` takes `from`'s lineage; `from` keeps none. */
  move(from: string, to: string): void {
    const uids = this.load()
    const uid = uids.get(from)
    uids.delete(from)
    if (uid) uids.set(to, uid)
    else uids.delete(to)
    this.save()
  }

  forget(...keys: string[]): void {
    const uids = this.load()
    if (keys.map(k => uids.delete(k)).some(Boolean)) this.save()
  }

  /** The keys recorded with lineage `uid`. */
  holders(uid: string): string[] {
    return [...this.load()].filter(([, u]) => u === uid).map(([key]) => key)
  }

  private load(): Map<string, string> {
    if (this.uids) return this.uids
    this.uids = new Map()
    if (!this.file) return this.uids
    let text: string
    try { text = readFileSync(this.file, 'utf8') } catch { return this.uids }
    try {
      const saved = JSON.parse(text) as { packages?: Record<string, unknown> }
      for (const [key, uid] of Object.entries(saved.packages ?? {}))
        if (isLineageUid(uid)) this.uids.set(key, uid)
    } catch {
      // Unlike a cache, a lost record cannot be derived again: an unreadable
      // one is set aside for a person rather than overwritten by the next save.
      try { renameSync(this.file, `${this.file}.unreadable-${Date.now()}`) } catch { /* left in place */ }
    }
    return this.uids
  }

  /** A record that cannot be written lasts the process: the packages it
   *  misses start new lineages at the next launch. */
  private save(): void {
    if (!this.file || !this.uids) return
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(temp, JSON.stringify({ packages: Object.fromEntries(this.uids) }))
      renameSync(temp, this.file)
    } catch { try { rmSync(temp, { force: true }) } catch { /* nothing was written */ } }
  }
}
