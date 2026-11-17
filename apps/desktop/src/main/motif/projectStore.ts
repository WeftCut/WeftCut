// A project's own Motifs: the packages under `<project>/Motifs/<id>/` that
// the project renders, read as their files stand (spec § Project Motifs). Owns
// the folders and what they hold; the table in project.json that names them
// is the actor's.
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assignUniqueId, builtinLineage, idFromName, parseManifestIsland, type Manifest } from '../../shared/motifs/catalog'
import { collisionId, isNewMotifId, type MotifStatus, type ProjectMotifEntry, type ProjectMotifs } from '../../shared/motifs/projectMotifs'
import { motifRevision, type BuiltinMotif } from './authoring'
import { readMotifZip } from './archive'
import { newLineage } from './lineage'
import { declaredManifest, declaredPackage, emptyPackageFiles, normalize, validateFiles } from './motifPackage'
import { motifFileSegments, readMotifDirectory, readMotifFile, sameStamps, stampMotifDirectory, type MotifFile } from './packageFiles'
import { PackageRevisions, type PackageStamp } from './packageRevisions'
import { PackageSource, type PackageListing, type PackageSnapshot, type PinnedPackage } from './packageSource'
import { revisionConflict } from './refusal'
import type { UserMotifStore } from './store'

/** The folder under a project that holds its Motifs. */
export const PROJECT_MOTIFS_DIR = 'Motifs'

/** How a project Motif's revision came to be seen: copied in from the
 *  library, made in the project, changed while the project was open here, or
 *  found when it was opened. */
export type RevisionCause = 'placed' | 'created' | 'edited-while-open' | 'opened'
export type RevisionListener = (id: string, revision: string, cause: RevisionCause) => void

/** A project Motif's folder as it stands. */
export interface MotifState { status: MotifStatus; revision: string | null; diagnostic?: string }

/** A library or built-in package to copy into a project. */
export interface LibraryPackage { id: string; uid: string; version: number; revision: string; files: readonly MotifFile[] }

/** Where a Motif made in a project starts. `copy` takes the files of any
 *  Motif the caller read; `zip` keeps the lineage the archive names. */
export type CreateSource =
  | { kind: 'empty'; name?: string }
  | { kind: 'copy'; files: readonly MotifFile[] }
  | { kind: 'zip'; path: string }
  | { kind: 'directory'; path: string }

/** What placing or making a project Motif came to: the id and table entry to
 *  record, and whether a folder was written. */
export interface Placement { id: string; entry: ProjectMotifEntry; copied: boolean }

/** The package library Motif `id` places: a built-in, else the installed
 *  Motif's current version; null when the library has neither. */
export function libraryPackage(store: UserMotifStore, builtins: readonly BuiltinMotif[], id: string): LibraryPackage | null {
  const builtin = builtins.find(b => b.id === id)
  if (builtin) {
    const uid = builtinLineage(id)
    if (!uid) return null
    const files = builtin.files ?? [{ path: 'index.html', bytes: Buffer.from(builtin.html) }]
    return { id, uid, version: builtin.manifest.version, revision: motifRevision(store, [...builtins], id), files }
  }
  const installed = store.installedSnapshot(id)
  if (!installed) return null
  return { id, uid: store.lineage.of(id), version: installed.version, revision: installed.revision, files: installed.files }
}

/** Writes `changed` (path to bytes, null to delete) into the author's folder
 *  `dir` file by file, each through a temporary file and a rename, after
 *  checking its files still have `stamp`: a write never lands on files changed
 *  since they were read. `then` runs after the writes; when a write or `then`
 *  fails, the files written are put back. The folder itself is never replaced
 *  or moved. */
export function writeThrough(dir: string, stamp: PackageStamp | null, original: readonly MotifFile[],
  changed: ReadonlyMap<string, Buffer | null>, then?: () => void): void {
  if (!stamp || !sameStamps(stamp.files, stampMotifDirectory(dir)))
    throw new Error('The Motif folder changed during the update; read it again')
  const applied: string[] = []
  try {
    for (const [rel, bytes] of changed) {
      const dest = path.join(dir, ...rel.split('/'))
      if (bytes) {
        mkdirSync(path.dirname(dest), { recursive: true })
        const temp = dest + '.motif-' + randomUUID()
        try {
          writeFileSync(temp, bytes)
          renameSync(temp, dest)
        } finally {
          rmSync(temp, { force: true })
        }
      } else rmSync(dest, { force: true })
      applied.push(rel)
    }
    then?.()
  } catch (error) {
    for (const rel of applied.reverse()) {
      const dest = path.join(dir, ...rel.split('/')), old = original.find(f => f.path === rel)
      if (old) writeFileSync(dest, old.bytes)
      else rmSync(dest, { force: true })
    }
    throw error
  }
}

/** The Motifs of the project in one folder. A folder's revision is its files'
 *  as they stand (`declaredPackage`), remembered by their stamps (ADR 0164):
 *  the app never rewrites a folder an author edits. */
export class ProjectMotifStore {
  private readonly dir: string
  private readonly source: PackageSource
  private readonly listeners = new Set<RevisionListener>()

  constructor(projectDir: string, options: { revisions?: PackageRevisions } = {}) {
    this.dir = path.join(projectDir, PROJECT_MOTIFS_DIR)
    this.source = new PackageSource(options.revisions ?? new PackageRevisions(),
      (files, dir) => declaredPackage(files, path.basename(dir)).revision)
  }

  root(): string { return this.dir }

  /** The folder of `id`; throws for an id no folder may take. */
  folder(id: string): string {
    if (typeof id !== 'string' || motifFileSegments(id)?.length !== 1 || id.startsWith('.'))
      throw new Error(`Invalid Motif id: ${JSON.stringify(id)}`)
    return path.join(this.dir, id)
  }

  /** The folder names under `Motifs/`, the app's own dot-folders aside. */
  ids(): string[] {
    let entries: string[]
    try { entries = readdirSync(this.dir) } catch { return [] }
    return entries.filter(name => {
      if (name.startsWith('.')) return false
      try { return lstatSync(path.join(this.dir, name)).isDirectory() } catch { return false }
    }).sort()
  }

  /** Whether `id`'s folder exists, as a folder or anything else. */
  private present(id: string): boolean {
    try { lstatSync(this.folder(id)); return true } catch { return false }
  }

  status(id: string): MotifState {
    try {
      if (!this.present(id)) return { status: 'missing', revision: null }
      return { status: 'ok', revision: this.source.listing(this.folder(id)).revision }
    } catch (error) {
      return { status: 'invalid', revision: null, diagnostic: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The package of `id` and the manifest it declares; null when its folder
   *  is gone, throws when its files make no package. */
  describe(id: string): (PackageListing & { manifest: Manifest }) | null {
    if (!this.present(id)) return null
    const { html, revision, paths, read } = this.source.listing(this.folder(id), ['manifest.json'])
    const json = read.get('manifest.json')
    const declared = json ? JSON.parse(json.toString('utf8')) as Manifest : parseManifestIsland(html)
    return { html, revision, paths, manifest: { ...declared, id } }
  }

  /** `id`'s files from one read, with their revision; null when its folder
   *  is gone, throws when they make no package. */
  snapshot(id: string): PackageSnapshot | null {
    return this.present(id) ? this.source.snapshot(this.folder(id)) : null
  }

  packageFiles(id: string): MotifFile[] {
    return this.snapshot(id)?.files ?? []
  }

  /** A file of `id`'s package, or of a pinned revision under
   *  `.revisions/<revision>/`. */
  readFile(id: string, rel: string): Buffer | null {
    const pinned = /^\.revisions\/([0-9a-f]{64})\/(.+)$/.exec(rel)
    if (pinned) return this.source.pinnedFile(id, pinned[1]!, pinned[2]!)
    try { return readMotifFile(this.folder(id), rel) } catch { return null }
  }

  /** Pins `revision` of `id` for a capture host (`PackageSource.pin`); null
   *  when its folder is gone. */
  pin(id: string, revision: string): PinnedPackage | null {
    return this.source.pin(id, revision, () => this.present(id) ? this.folder(id) : null)
  }

  /** Copies `files` into `id`'s folder, written aside and renamed into place
   *  whole, and answers the folder's revision, which the listeners hear with
   *  `cause`. An existing folder that makes a package is kept as it is, so
   *  copying again changes nothing; one that makes none is never written
   *  over, and its diagnostic is thrown. */
  materialize(id: string, files: readonly MotifFile[], cause: RevisionCause): string {
    const dir = this.folder(id)
    if (!this.present(id)) {
      validateFiles(files)
      mkdirSync(this.dir, { recursive: true })
      const staging = path.join(this.dir, `.stage-${randomUUID()}`)
      try {
        for (const file of files) {
          const dest = path.join(staging, ...file.path.split('/'))
          mkdirSync(path.dirname(dest), { recursive: true })
          writeFileSync(dest, file.bytes)
        }
        renameSync(staging, dir)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    const revision = this.source.snapshot(dir).revision
    this.emit(id, revision, cause)
    return revision
  }

  /** Copies a library or built-in package into the project. A lineage the
   *  table holds is placed again under its id: its folder is copied only when
   *  gone. Another lineage on the package's id, or a folder holding other
   *  files, sends the copy to `collisionId`. */
  place(pkg: LibraryPackage, table: Readonly<ProjectMotifs>): Placement {
    const from = { uid: pkg.uid, version: pkg.version, revision: pkg.revision }
    const held = Object.entries(table).find(([, entry]) => entry.uid === pkg.uid)
    if (held) {
      const [id, entry] = held
      if (this.status(id).status === 'ok') return { id, entry, copied: false }
      const revision = this.materialize(id, pkg.files, 'placed')
      return { id, entry: { ...entry, revision }, copied: true }
    }
    const free = (id: string) => !Object.hasOwn(table, id) && (!this.present(id) || this.status(id).revision === pkg.revision)
    const id = [pkg.id, collisionId(pkg.id, pkg.uid)].find(free)
    if (!id) throw new Error(`Motif id '${collisionId(pkg.id, pkg.uid)}' is taken in this project`)
    const copied = !this.present(id)
    const revision = this.materialize(id, pkg.files, 'placed')
    return { id, entry: { uid: pkg.uid, revision, from }, copied }
  }

  /** Makes a new Motif in the project, of a new lineage, its files normalised
   *  under the id it takes. The id comes from its name, numbered when the
   *  table or a folder holds it; a ZIP is an automatic copy, so it keeps the
   *  id it carries and a taken one becomes `collisionId`. */
  create(source: CreateSource, table: Readonly<ProjectMotifs>): Placement & { path: string } {
    let files: readonly MotifFile[]
    let uid = newLineage()
    let carried: string | null = null
    switch (source.kind) {
      case 'empty': files = emptyPackageFiles(source.name); break
      case 'copy': files = source.files; break
      case 'directory': {
        if (!path.isAbsolute(source.path)) throw new Error('Source path must be absolute')
        files = readMotifDirectory(realpathSync.native(source.path))
        break
      }
      case 'zip': {
        if (!path.isAbsolute(source.path)) throw new Error('Source path must be absolute')
        const archive = readMotifZip(source.path)
        files = archive.files
        // A lineage the project holds already forks, as a publication does.
        if (archive.lineage && !Object.values(table).some(e => e.uid === archive.lineage)) uid = archive.lineage
        carried = declaredManifest(files).input.id ?? null
        break
      }
      default: throw new Error('Unknown Motif source kind')
    }
    const name = normalize(files, 'motif', 'own').manifest.name
    const taken = [...Object.keys(table), ...this.ids()]
    const isTaken = (id: string) => taken.some(t => t.toLowerCase() === id)
    let id: string
    if (source.kind === 'zip') {
      const own = carried && isNewMotifId(carried) ? carried : idFromName(name, uid)
      id = isTaken(own) ? collisionId(own, uid) : own
      if (isTaken(id)) throw new Error(`Motif id '${id}' is taken in this project`)
    } else id = assignUniqueId(name, uid, taken.map(t => t.toLowerCase()))
    const pkg = normalize(files, id, 'own')
    const revision = this.materialize(id, pkg.files, 'created')
    return { id, entry: { uid, revision, from: null }, copied: true, path: this.folder(id) }
  }

  /** Applies `changes` (path to bytes, null to delete) to `id`'s folder,
   *  whose revision must be `expected`. The whole result must make a package
   *  before any file is written; the files are written one by one
   *  (`writeThrough`). Answers the new revision. */
  applyChanges(id: string, expected: string, changes: ReadonlyMap<string, Buffer | null>): string {
    const dir = this.folder(id)
    if (!this.present(id)) throw new Error(`Motif '${id}' has no folder in this project`)
    const { files, revision, stamp } = this.source.read(dir)
    if (!stamp) throw new Error('The Motif folder changed while it was read; read it again')
    if (revision !== expected) throw revisionConflict(revision, 'read the Motif again and merge')
    const next = new Map(files.map(f => [f.path, f.bytes]))
    for (const [rel, bytes] of changes) {
      if (bytes) next.set(rel, bytes)
      else next.delete(rel)
    }
    const { revision: after } = declaredPackage([...next].map(([p, bytes]) => ({ path: p, bytes })), id)
    writeThrough(dir, stamp, files, changes)
    this.emit(id, after, 'edited-while-open')
    return after
  }

  /** `id`'s folder as it stands; tells the listeners when it holds a
   *  package. */
  seen(id: string, cause: RevisionCause): MotifState {
    const state = this.status(id)
    if (state.revision) this.emit(id, state.revision, cause)
    return state
  }

  /** Listens for every revision the store writes or is told it saw;
   *  answers the unsubscribe. */
  onRevisionSeen(listener: RevisionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(id: string, revision: string, cause: RevisionCause): void {
    for (const listener of this.listeners) listener(id, revision, cause)
  }
}
