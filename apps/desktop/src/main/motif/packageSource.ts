// Reading package directories through their revision records (ADR 0164).
// Shared by the library (`store.ts`) and a project's Motifs
// (`projectStore.ts`); each says what a directory's files come to, this module
// when that has to be worked out again. Capture pins are the resolver's
// (`resolver.ts`).
import { readMotifFile, sameStamp, stampMotifFile, type MotifFile } from './packageFiles'
import type { PackageRevisions, PackageStamp } from './packageRevisions'

/** One package as the catalog lists it: its page, its revision and the paths
 *  of its files. */
export interface PackageListing { html: string; revision: string; paths: string[] }

/** A package's files from one read, with their revision. */
export interface PackageSnapshot { files: MotifFile[]; revision: string }

/** The revision a directory's files make; throws what makes them no package. */
export type PackageRevisionOf = (files: readonly MotifFile[], dir: string) => string

export class PackageSource {
  constructor(readonly revisions: PackageRevisions, private readonly revisionOf: PackageRevisionOf) {}

  /** The bytes are hashed only when their stamp has no record; a read that a
   *  write crossed is hashed and not recorded. What the files decide, a
   *  revision or the reason they make no package, is recorded; a failed read
   *  is tried again. */
  snapshot(dir: string, taken?: PackageStamp): PackageSnapshot {
    const { files, revision } = this.read(dir, taken)
    return { files, revision }
  }

  /** `snapshot`, with the stamp its files were read under: null when a write
   *  crossed the read. */
  read(dir: string, taken?: PackageStamp): PackageSnapshot & { stamp: PackageStamp | null } {
    const { files, stamp } = this.revisions.read(dir, taken)
    const known = stamp && this.revisions.lookup(dir, stamp)
    if (known && 'revision' in known) return { files, revision: known.revision, stamp }
    if (known) throw new Error(known.diagnostic)
    let revision: string
    try { revision = this.revisionOf(files, dir) } catch (error) {
      if (stamp) this.revisions.record(dir, stamp, { diagnostic: error instanceof Error ? error.message : String(error) })
      throw error
    }
    if (stamp) this.revisions.record(dir, stamp, { revision })
    return { files, revision, stamp }
  }

  /** The page, revision and paths of the package in `dir`, read in full only
   *  when its files changed since its revision was recorded. `pages` are
   *  files read besides the page; one the package lacks is absent from
   *  `read`. Throws when the directory is not a package's. */
  listing(dir: string, pages: readonly string[] = []): PackageListing & { read: Map<string, Buffer> } {
    const stamp = this.revisions.stamp(dir)
    const known = this.revisions.lookup(dir, stamp)
    const wanted = ['index.html', ...pages].filter(rel => stamp.files.some(f => f.path === rel))
    if (known && 'revision' in known) {
      const read = new Map<string, Buffer>()
      for (const rel of wanted) {
        const bytes = readMotifFile(dir, rel)
        // A file is the stamped one only if it did not move while it was read.
        if (!bytes || !sameStamp(stamp.files.find(f => f.path === rel), stampMotifFile(dir, rel))) break
        read.set(rel, bytes)
      }
      const html = read.get('index.html')
      if (html && read.size === wanted.length)
        return { html: html.toString('utf8'), revision: known.revision, paths: stamp.files.map(f => f.path), read }
    }
    const { files, revision } = this.snapshot(dir, stamp)
    const read = new Map(files.filter(f => f.path === 'index.html' || pages.includes(f.path)).map(f => [f.path, f.bytes]))
    const html = read.get('index.html')
    if (!html) throw new Error('A Motif folder must contain index.html')
    return { html: html.toString('utf8'), revision, paths: files.map(f => f.path), read }
  }
}
