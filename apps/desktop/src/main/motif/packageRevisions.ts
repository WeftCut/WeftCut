// What a package directory's bytes came to, remembered by the stamps of its
// files, so an unchanged package is answered without reading it (ADR 0164).
// Owns the record and when it may be believed; what the bytes come to is the
// caller's (`store.ts` for app-owned packages, `workspace.ts` for linked
// directories).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type FileStamp, type MotifFile, readStampedFiles, sameStamps, stampMotifDirectory } from './packageFiles'

/** What a directory's files came to: the revision of the package they make,
 *  or why they make none. */
export type PackageOutcome = { revision: string } | { diagnostic: string }

/** A directory's files as stat saw them, and when. */
export interface PackageStamp { takenMs: number; files: FileStamp[] }

/** A file changed this shortly before it was stamped can change again without
 *  its times moving (FAT keeps modification times in 2 s steps), so a stamp
 *  holding one is not recorded and the package is read again next time. */
export const STAMP_SETTLE_MS = 2000

interface Entry { files: FileStamp[]; outcome: PackageOutcome }

const settled = (stamp: PackageStamp): boolean => {
  const limitNs = BigInt(Math.floor(stamp.takenMs - STAMP_SETTLE_MS)) * 1_000_000n
  return stamp.files.every(f => BigInt(f.mtimeNs) <= limitNs && BigInt(f.ctimeNs) <= limitNs)
}

const isStamp = (f: unknown): f is FileStamp => {
  const s = f as FileStamp | null
  return !!s && typeof s.path === 'string' && typeof s.size === 'number'
    && [s.mtimeNs, s.ctimeNs, s.ino].every(v => typeof v === 'string' && /^\d+$/.test(v))
}

const isOutcome = (o: unknown): o is PackageOutcome => {
  const v = o as { revision?: unknown; diagnostic?: unknown } | null
  return !!v && (typeof v.revision === 'string') !== (typeof v.diagnostic === 'string')
}

export class PackageRevisions {
  private readonly entries = new Map<string, Entry>()

  /** `file` keeps the records across launches; without one they last the
   *  process. `generation` names the code that derived the outcomes: records
   *  of another generation are dropped, so a release that hashes or validates
   *  differently never answers from an older one's. */
  constructor(
    private readonly file: string | null = null,
    private readonly generation = '',
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { generation?: unknown; packages?: unknown }
      if (saved.generation !== generation || !saved.packages || typeof saved.packages !== 'object') return
      for (const [dir, entry] of Object.entries(saved.packages as Record<string, Partial<Entry>>)) {
        if (Array.isArray(entry?.files) && entry.files.every(isStamp) && isOutcome(entry.outcome))
          this.entries.set(dir, { files: entry.files, outcome: entry.outcome })
      }
    } catch { /* Absent or unreadable: every package is read once. */ }
  }

  /** Throws what the walk throws (a link, a path no package may hold, the
   *  package limits, a directory that is gone); such a directory has no record. */
  stamp(dir: string): PackageStamp {
    const takenMs = this.now()
    try { return { takenMs, files: stampMotifDirectory(dir) } }
    catch (error) { this.forget(dir); throw error }
  }

  /** The files, and the stamp they were read under: null when one changed
   *  during the read, so the bytes belong to no stamp. A stamp the caller
   *  already took serves as the one before the read. */
  read(dir: string, stamp = this.stamp(dir)): { files: MotifFile[]; stamp: PackageStamp | null } {
    const files = readStampedFiles(dir, stamp.files)
    return { files, stamp: sameStamps(stamp.files, stampMotifDirectory(dir)) ? stamp : null }
  }

  /** The outcome recorded for exactly these files, else null. */
  lookup(dir: string, stamp: PackageStamp): PackageOutcome | null {
    const entry = this.entries.get(dir)
    return entry && sameStamps(entry.files, stamp.files) ? entry.outcome : null
  }

  /** `stamp` must be the one the outcome's bytes were read under. */
  record(dir: string, stamp: PackageStamp, outcome: PackageOutcome): void {
    if (settled(stamp)) this.entries.set(dir, { files: stamp.files, outcome })
    else if (!this.entries.delete(dir)) return
    this.save()
  }

  forget(dir: string): void {
    if (this.entries.delete(dir)) this.save()
  }

  /** A record that cannot be written costs one more read, never an error. */
  private save(): void {
    if (!this.file) return
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(temp, JSON.stringify({ generation: this.generation, packages: Object.fromEntries(this.entries) }))
      renameSync(temp, this.file)
    } catch { try { rmSync(temp, { force: true }) } catch { /* nothing was written */ } }
  }
}
