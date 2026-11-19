// Revisions of a project's Motifs kept under `<project>/Backups/motifs/`, so
// a folder can be put back as a revision the project recorded (undo, "update
// the project copy"). Content-addressed: `.blobs/<sha256>` holds each file's
// bytes once, `<id>/<revision>.json` maps a revision's paths to them. A folder
// whose files make no package, which no revision can hold, is moved whole to
// `unfinished/` before the app replaces it. Owns the backup folder; when to
// back up, restore or collect is the caller's.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { motifFileSegments, type MotifFile } from './packageFiles'
import { declaredPackage, replacePackage } from './motifPackage'
import { PROJECT_MOTIFS_DIR } from './projectStore'

/** The folder under a project that keeps its Motif revisions. */
export const MOTIF_BACKUPS_DIR = path.join('Backups', 'motifs')
/** Dot-named: a Motif id never starts with a dot, so no Motif's records can
 *  take this folder. */
const BLOBS_DIR = '.blobs'
/** Where a replaced folder's unfinished files are kept, for a person to find.
 *  Not dot-named, so a Motif `unfinished` shares it with its records: `gc`
 *  removes no folder, so neither touches the other's entries. */
export const UNFINISHED_DIR = 'unfinished'

const REVISION = /^[0-9a-f]{64}$/

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** A backed-up revision: each file's path and the sha256 of its bytes. */
interface RevisionRecord { files: Record<string, string> }

export class MotifBackups {
  private readonly root: string
  private readonly motifs: string

  constructor(projectDir: string) {
    this.root = path.join(projectDir, MOTIF_BACKUPS_DIR)
    this.motifs = path.join(projectDir, PROJECT_MOTIFS_DIR)
  }

  /** `id`, checked to name one folder. */
  private id(id: string): string {
    if (motifFileSegments(id)?.length !== 1 || id.startsWith('.')) throw new Error(`Invalid Motif id: ${JSON.stringify(id)}`)
    return id
  }

  private recordFile(id: string, revision: string): string {
    this.id(id)
    if (!REVISION.test(revision)) throw new Error(`Invalid Motif revision: ${revision}`)
    return path.join(this.root, id, `${revision}.json`)
  }

  private blob(hash: string): string { return path.join(this.root, BLOBS_DIR, hash) }

  /** Writes atomically: a reader sees the whole file or none. */
  private write(file: string, bytes: Buffer | string): void {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, bytes)
      renameSync(temp, file)
    } finally { rmSync(temp, { force: true }) }
  }

  /** Keeps `files` as `revision` of `id`. A blob already kept is not written
   *  again, nor is a record already naming these files; one naming others
   *  is written over: the project folder may have come from anyone. */
  backup(id: string, files: readonly MotifFile[], revision: string): void {
    const record = this.recordFile(id, revision)
    const paths: Record<string, string> = {}
    for (const file of files) {
      if (!motifFileSegments(file.path)) throw new Error(`Invalid Motif asset path: ${file.path}`)
      paths[file.path] = sha256(file.bytes)
    }
    const text = JSON.stringify({ files: paths } satisfies RevisionRecord)
    try { if (readFileSync(record, 'utf8') === text) return } catch { /* none kept yet */ }
    for (const file of files) {
      const hash = paths[file.path]!
      if (!existsSync(this.blob(hash))) this.write(this.blob(hash), file.bytes)
    }
    // The record last: a revision is listed only once every blob it names is kept.
    this.write(record, text)
  }

  has(id: string, revision: string): boolean {
    try { return existsSync(this.recordFile(id, revision)) } catch { return false }
  }

  /** The files of `revision` of `id`; null when it was not backed up. Throws
   *  when a blob is gone or no longer holds its bytes, or when the files make
   *  another revision than the record names: a received project's backups
   *  are its sender's, and a record trusted by its name would put any bytes
   *  in a folder under a revision this machine trusts (Motif trust). */
  files(id: string, revision: string): MotifFile[] | null {
    let record: RevisionRecord
    try { record = JSON.parse(readFileSync(this.recordFile(id, revision), 'utf8')) as RevisionRecord } catch { return null }
    const files = Object.entries(record.files).map(([rel, hash]) => {
      const bytes = readFileSync(this.blob(hash))
      if (sha256(bytes) !== hash) throw new Error(`Backed-up file ${rel} of Motif '${id}' is damaged`)
      return { path: rel, bytes }
    })
    let made: string | null
    try { made = declaredPackage(files, id).revision } catch { made = null }
    if (made !== revision) throw new Error(`The backup of revision ${revision} of Motif '${id}' holds other files`)
    return files
  }

  /** Puts `revision` of `id` back as its folder under `Motifs/`, replacing
   *  what it holds whole. Throws, changing nothing, when the revision was not
   *  backed up, a blob is damaged or the files make another revision. */
  restore(id: string, revision: string): void {
    const files = this.files(id, revision)
    if (!files) throw new Error(`Revision ${revision} of Motif '${id}' has no backup`)
    replacePackage(path.join(this.motifs, id), files)
  }

  /** Moves `id`'s folder under `unfinished/` as `<id>-<UTC time>` and
   *  answers where it went. Nothing is ever removed from there. */
  setAside(id: string): string {
    this.id(id)
    // The ISO time with `:` and `.` as `-`: Windows refuses `:` in a name.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const parent = path.join(this.root, UNFINISHED_DIR)
    mkdirSync(parent, { recursive: true })
    let aside = path.join(parent, `${id}-${stamp}`)
    for (let n = 2; existsSync(aside); n++) aside = path.join(parent, `${id}-${stamp}-${n}`)
    renameSync(path.join(this.motifs, id), aside)
    return aside
  }

  /** Puts a folder `setAside` moved back as `id`'s, replacing what the
   *  folder holds now. */
  putBack(id: string, aside: string): void {
    const folder = path.join(this.motifs, this.id(id))
    rmSync(folder, { recursive: true, force: true })
    renameSync(aside, folder)
  }

  /** Removes every backed-up revision not in `keep` (pairs of id and
   *  revision), then every blob no kept revision names. A kept record that
   *  cannot be read leaves every blob in place. */
  gc(keep: Iterable<readonly [id: string, revision: string]>): void {
    const kept = new Set([...keep].map(([id, revision]) => `${id}/${revision}`))
    const named = new Set<string>()
    let readAll = true
    let ids: string[]
    try { ids = readdirSync(this.root).filter(name => name !== BLOBS_DIR) } catch { return }
    for (const id of ids) {
      let names: string[]
      try { names = readdirSync(path.join(this.root, id)) } catch { continue }
      for (const name of names) {
        const file = path.join(this.root, id, name)
        // `unfinished/` holds folders kept for a person, never collected.
        try { if (lstatSync(file).isDirectory()) continue } catch { continue }
        const revision = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
        if (!kept.has(`${id}/${revision}`)) { rmSync(file, { force: true }); continue }
        try {
          const record = JSON.parse(readFileSync(file, 'utf8')) as RevisionRecord
          for (const hash of Object.values(record.files)) named.add(hash)
        } catch { readAll = false }
      }
      try { if (readdirSync(path.join(this.root, id)).length === 0) rmSync(path.join(this.root, id), { recursive: true }) } catch { /* left */ }
    }
    if (!readAll) return
    let blobs: string[]
    try { blobs = readdirSync(path.join(this.root, BLOBS_DIR)) } catch { return }
    for (const hash of blobs) if (!named.has(hash)) rmSync(this.blob(hash), { force: true })
  }
}
