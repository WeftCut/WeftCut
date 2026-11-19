// A project's own Motifs: the packages under `<project>/Motifs/<id>/` that
// the project renders, read as their files stand (spec § Project Motifs). Owns
// the folders and what they hold; the table in project.json that names them
// is the actor's.
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assignUniqueId, builtinLineage, idFromName, parseManifestIsland, type Manifest } from '../../shared/motifs/catalog'
import { collisionId, isNewMotifId, isProjectMotifKey, projectMotifKey, type MotifStatus, type ProjectMotifEntry, type ProjectMotifs } from '../../shared/motifs/projectMotifs'
import { motifRevision, type BuiltinMotif } from './authoring'
import { readMotifZip } from './archive'
import { newLineage } from './lineage'
import { declaredManifest, declaredPackage, emptyPackageFiles, normalize, replacePackage, validateFiles } from './motifPackage'
import { motifFileSegments, readMotifDirectory, readMotifFile, sameStamps, stampMotifDirectory, type MotifFile } from './packageFiles'
import { PackageRevisions, type PackageStamp } from './packageRevisions'
import { PackageSource, type PackageListing, type PackageSnapshot } from './packageSource'
import { caseAliasRefusal, revisionConflict } from './refusal'
import type { UserMotifStore } from './store'

/** The folder under a project that holds its Motifs. */
export const PROJECT_MOTIFS_DIR = 'Motifs'

/** How a project Motif's revision came to be seen: copied in from the
 *  library, made in the project, brought in from a ZIP or a folder outside
 *  the project's `Motifs/`, changed while the project was open here, or
 *  found in a folder without being made here: when the project was opened,
 *  or put back from a backup (Motif trust, `trust.ts`). */
export type RevisionCause = 'placed' | 'created' | 'imported' | 'edited-while-open' | 'opened'
/** `base` is the revision the store last observed in the folder an edit was
 *  made in (`edited-while-open`), null when it observed none; or the one an
 *  import's files made as they came, under the id they carried
 *  (`imported`); null for every other cause. */
export type RevisionListener = (id: string, revision: string, cause: RevisionCause, base: string | null) => void

/** A project Motif's folder as it stands. */
export interface MotifState { status: MotifStatus; revision: string | null; diagnostic?: string }

/** A library or built-in package to copy into a project. */
export interface LibraryPackage { id: string; uid: string; version: number; revision: string; files: readonly MotifFile[] }

/** Where a Motif made in a project starts. `empty` is the empty package,
 *  with `changes` (path to bytes, null to delete) laid over it when given;
 *  `copy` takes the files of any Motif the caller read; `zip` keeps the
 *  lineage the archive names. */
export type CreateSource =
  | { kind: 'empty'; name?: string; changes?: ReadonlyMap<string, Buffer | null> }
  | { kind: 'copy'; files: readonly MotifFile[] }
  | { kind: 'zip'; path: string }
  | { kind: 'directory'; path: string }

/** What placing or making a project Motif came to: the id and table entry to
 *  record, and whether a folder was written. */
export interface Placement { id: string; entry: ProjectMotifEntry; copied: boolean }

/** The package library Motif `id` places: a built-in, else the installed
 *  Motif's current version; null when the library has neither. An installed
 *  Motif without a recorded lineage gets one recorded only with `mint`;
 *  without it, one that lasts the call, so a plan never carried out writes
 *  nothing to the library. */
export function libraryPackage(store: UserMotifStore, builtins: readonly BuiltinMotif[], id: string, mint = true): LibraryPackage | null {
  const builtin = builtins.find(b => b.id === id)
  if (builtin) {
    const uid = builtinLineage(id)
    if (!uid) return null
    const files = builtin.files ?? [{ path: 'index.html', bytes: Buffer.from(builtin.html) }]
    return { id, uid, version: builtin.manifest.version, revision: motifRevision(store, [...builtins], id), files }
  }
  const installed = store.installedSnapshot(id)
  if (!installed) return null
  const uid = mint ? store.lineage.of(id) : store.lineage.peek(id) ?? newLineage()
  return { id, uid, version: installed.version, revision: installed.revision, files: installed.files }
}

/** The library's current package of lineage `uid`: the built-in of that
 *  lineage, else the installed Motif recorded with it; null when the library
 *  holds none. */
export function libraryPackageOfLineage(store: UserMotifStore, builtins: readonly BuiltinMotif[], uid: string): LibraryPackage | null {
  const builtin = builtins.find(b => builtinLineage(b.id) === uid)
  if (builtin) return libraryPackage(store, builtins, builtin.id)
  const installed = new Set(store.publishedIds())
  const id = store.lineage.holders(uid).find(key => installed.has(key))
  return id === undefined ? null : libraryPackage(store, builtins, id)
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
 *  the app never rewrites a folder an author edits. A folder is read only
 *  under its exact name, and only a name that is a table key
 *  (`isProjectMotifKey`) holds a package.
 *
 *  One store serves one open session of its project: it remembers the
 *  revision it last observed in each folder, which is what an edit made
 *  while the project is open is judged from (`observe`). */
export class ProjectMotifStore {
  private readonly dir: string
  private readonly source: PackageSource
  private readonly listeners = new Set<RevisionListener>()
  /** The revision each folder held when this store last saw it, by id: as
   *  found at the open, then as each write or read of it here found it. */
  private readonly observed = new Map<string, string>()
  /** Every name under `Motifs/` when the project opened (`open`), by exact
   *  name, and each id a backup was put back in (`found`): the folders whose
   *  bytes may have come with the project. Null until `open`: a store not
   *  opened makes nothing it observes. */
  private foundIds: Set<string> | null = null
  /** The content (`contentKey`) of each folder found here whose revision was
   *  not trusted when it was found, under whatever name: a folder that first
   *  appears holding the same content is a copy or move of found bytes, never
   *  made here. */
  private readonly foundContent = new Set<string>()
  /** Whether a revision was trusted when its folder was found (`open`). */
  private trustedWhenFound: (revision: string) => boolean = () => false

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

  /** The entry under `Motifs/` whose name differs from `id` only in case;
   *  null when there is none. */
  private caseAlias(id: string): string | null {
    let names: string[]
    try { names = readdirSync(this.dir) } catch { return null }
    const folded = id.toLowerCase()
    return names.find(name => name !== id && name.toLowerCase() === folded) ?? null
  }

  /** Whether an entry named exactly `id` is under `Motifs/`, a folder or
   *  anything else.
   *
   *  LANDMINE: by name, never by `lstat`: on a case-insensitive file system
   *  (macOS, Windows) `Motifs/evil` reaches `Motifs/Evil/`, whose bytes
   *  would then be read and hashed under a key the open never found them
   *  under (Motif trust). */
  private present(id: string): boolean {
    try { this.folder(id) } catch { return false }
    try { return readdirSync(this.dir).includes(id) } catch { return false }
  }

  /** `id`'s folder when it is there; null when it is gone. Throws when its
   *  name is no table key: no package is read under it. */
  private packageFolder(id: string): string | null {
    if (!this.present(id)) return null
    if (!isProjectMotifKey(id))
      throw new Error(`The folder name must be lowercase letters, digits and single dashes: rename Motifs/${id}/`)
    return this.folder(id)
  }

  status(id: string): MotifState {
    try {
      const dir = this.packageFolder(id)
      if (!dir) return { status: 'missing', revision: null }
      return { status: 'ok', revision: this.source.listing(dir).revision }
    } catch (error) {
      return { status: 'invalid', revision: null, diagnostic: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The package of `id` and the manifest it declares; null when its folder
   *  is gone, throws when its files make no package. */
  describe(id: string): (PackageListing & { manifest: Manifest }) | null {
    const dir = this.packageFolder(id)
    if (!dir) return null
    const { html, revision, paths, read } = this.source.listing(dir, ['manifest.json'])
    const json = read.get('manifest.json')
    const declared = json ? JSON.parse(json.toString('utf8')) as Manifest : parseManifestIsland(html)
    return { html, revision, paths, manifest: { ...declared, id } }
  }

  /** `id`'s files from one read, with their revision; null when its folder
   *  is gone, throws when they make no package. */
  snapshot(id: string): PackageSnapshot | null {
    const dir = this.packageFolder(id)
    return dir ? this.source.snapshot(dir) : null
  }

  packageFiles(id: string): MotifFile[] {
    return this.snapshot(id)?.files ?? []
  }

  /** A file of `id`'s package. */
  readFile(id: string, rel: string): Buffer | null {
    try {
      const dir = this.packageFolder(id)
      return dir === null ? null : readMotifFile(dir, rel)
    } catch { return null }
  }

  /** Copies `files` into `id`'s folder, written aside and renamed into place
   *  whole, and answers the folder's revision, which the listeners hear with
   *  `cause`. An existing folder that makes a package is kept as it is, so
   *  copying again changes nothing; one that makes none is never written
   *  over, and its diagnostic is thrown. A kept folder holding other bytes
   *  than `files` is heard as `opened`: it was not made by this call.
   *  `base` goes to the listeners with `cause` (`RevisionListener`). A
   *  folder named `id` in another case is refused before anything is written:
   *  a case-insensitive file system (macOS, Windows) cannot hold both, and
   *  the project must open on one. */
  materialize(id: string, files: readonly MotifFile[], cause: RevisionCause, base: string | null = null): string {
    const dir = this.folder(id)
    let wrote = false
    if (!this.present(id)) {
      const alias = this.caseAlias(id)
      if (alias !== null) throw caseAliasRefusal(alias, id)
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
        wrote = true
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    const revision = this.source.snapshot(dir).revision
    const made = wrote || revision === revisionOf(files, id)
    this.emit(id, revision, made ? cause : 'opened', made ? base : null)
    return revision
  }

  /** Replaces `id`'s folder whole with `files` and answers the revision it
   *  then holds, which the listeners hear with `cause`. For a copy the app
   *  writes over the author's (updating it from the library); an author's
   *  own edits go through `applyChanges`. */
  replace(id: string, files: readonly MotifFile[], cause: RevisionCause): string {
    const dir = this.folder(id)
    replacePackage(dir, files)
    const revision = this.source.snapshot(dir).revision
    this.emit(id, revision, cause)
    return revision
  }

  /** Copies a library or built-in package into the project. A lineage the
   *  table holds is placed again under its id: its folder is copied only when
   *  gone. Otherwise the copy is keyed by the library id (`projectMotifKey`,
   *  as the v5 upgrade keys one); another lineage on that key, or a folder
   *  holding other files, sends it to `collisionId`. */
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
    const key = projectMotifKey(pkg.id)
    const id = [key, collisionId(key, pkg.uid)].find(free)
    if (!id) throw new Error(`Motif id '${collisionId(key, pkg.uid)}' is taken in this project`)
    const copied = !this.present(id)
    const revision = this.materialize(id, pkg.files, 'placed')
    return { id, entry: { uid: pkg.uid, revision, from }, copied }
  }

  /** Makes a new Motif in the project, of a new lineage, its files normalised
   *  under the id it takes. The id comes from its name, numbered when the
   *  table or a folder holds it; a ZIP is an automatic copy, so it keeps the
   *  id it carries and a taken one becomes `collisionId`. A directory that
   *  is one of this project's own Motif folders is adopted in place
   *  (`adopt`). A ZIP or another directory is heard as `imported`: its bytes
   *  were not made here. With it goes the revision its files made as they
   *  came, under the id they carried (a directory's own name when they carry
   *  none), so a copy of trusted bytes renamed here is judged by them. */
  create(source: CreateSource, table: Readonly<ProjectMotifs>): Placement & { path: string } {
    let files: readonly MotifFile[]
    let uid = newLineage()
    let carried: string | null = null
    let came: string | null = null
    switch (source.kind) {
      case 'empty': {
        const empty = emptyPackageFiles(source.name)
        files = source.changes ? withChanges(empty, source.changes) : empty
        break
      }
      case 'copy': files = source.files; break
      case 'directory': {
        if (!path.isAbsolute(source.path)) throw new Error('Source path must be absolute')
        const real = realpathSync.native(source.path)
        const own = this.ownFolder(real)
        if (own !== null) return this.adopt(own, table)
        files = readMotifDirectory(real)
        came = revisionOf(files, declaredId(files) ?? path.basename(real))
        break
      }
      case 'zip': {
        if (!path.isAbsolute(source.path)) throw new Error('Source path must be absolute')
        const archive = readMotifZip(source.path)
        files = archive.files
        // A lineage the project holds already forks, as a publication does.
        if (archive.lineage && !Object.values(table).some(e => e.uid === archive.lineage)) uid = archive.lineage
        carried = declaredManifest(files).input.id ?? null
        if (carried !== null) came = revisionOf(files, carried)
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
    const imported = source.kind === 'zip' || source.kind === 'directory'
    const revision = this.materialize(id, pkg.files, imported ? 'imported' : 'created', imported ? came : null)
    return { id, entry: { uid, revision, from: null }, copied: true, path: this.folder(id) }
  }

  /** The name of the folder `real` (a resolved path) when it is one of this
   *  project's Motif folders; null otherwise. */
  private ownFolder(real: string): string | null {
    let root: string
    try { root = realpathSync.native(this.dir) } catch { return null }
    return path.dirname(real) === root ? path.basename(real) : null
  }

  /** A folder written under `Motifs/` becomes a Motif of a new lineage under
   *  its own name, its files as they stand; one the table holds is answered
   *  as it is. Adopting writes nothing: the folder is observed (`observe`),
   *  so it is trusted as the watcher would judge it, made here only when it
   *  first appeared while the project was open. */
  private adopt(id: string, table: Readonly<ProjectMotifs>): Placement & { path: string } {
    const held = Object.hasOwn(table, id) ? table[id] : undefined
    if (held) return { id, entry: held, copied: false, path: this.folder(id) }
    if (!isProjectMotifKey(id))
      throw new Error(`Motifs/${id} cannot be a Motif id: rename the folder to lowercase letters, digits and single dashes`)
    const state = this.observe(id)
    if (!state.revision) throw new Error(state.diagnostic ?? `Motifs/${id} holds no Motif package`)
    return { id, entry: { uid: newLineage(), revision: state.revision, from: null }, copied: false, path: this.folder(id) }
  }

  /** Applies `changes` (path to bytes, null to delete) to `id`'s folder,
   *  whose revision must be `expected`; a function makes them from the files
   *  the folder holds. `expected` null repairs a folder whose files make no
   *  package, which has no revision; a folder that makes one refuses it. The
   *  whole result must make a package before any file is written; the files
   *  are written one by one (`writeThrough`). Answers the new revision, heard
   *  as an edit of the one read, which is observed first when this store last
   *  saw another; a repair is heard as an edit of the last package seen. */
  applyChanges(id: string, expected: string | null,
    changes: ReadonlyMap<string, Buffer | null> | ((files: readonly MotifFile[]) => ReadonlyMap<string, Buffer | null>)): string {
    const dir = this.packageFolder(id)
    if (!dir) throw new Error(`Motif '${id}' has no folder in this project`)
    const { files, revision, stamp } = this.readForEdit(id, dir, expected)
    if (!stamp) throw new Error('The Motif folder changed while it was read; read it again')
    if (revision !== expected) throw revisionConflict(revision, revision === null
      ? 'send expected_revision: null to repair its files'
      : expected === null ? 'it makes a package: send its revision as expected_revision' : 'read the Motif again and merge')
    if (revision !== null) this.saw(id, revision)
    if (typeof changes === 'function') changes = changes(files)
    const { revision: after } = declaredPackage(withChanges(files, changes), id)
    writeThrough(dir, stamp, files, changes)
    this.emit(id, after, 'edited-while-open', revision ?? this.observed.get(id) ?? null)
    return after
  }

  /** `id`'s files for an edit, with their revision: null when they make no
   *  package. A valid folder is read through its revision records unless the
   *  caller repairs (`expected` null); a folder that cannot be read throws. */
  private readForEdit(id: string, dir: string, expected: string | null): { files: MotifFile[]; revision: string | null; stamp: PackageStamp | null } {
    if (expected !== null) {
      try { return this.source.read(dir) } catch (error) {
        const { files, stamp } = this.source.revisions.read(dir)
        if (revisionOf(files, id) !== null) throw error
        return { files, revision: null, stamp }
      }
    }
    const { files, stamp } = this.source.revisions.read(dir)
    return { files, revision: revisionOf(files, id), stamp }
  }

  /** The project becomes the open one: every folder under `Motifs/` is
   *  `found`, and every name there, folder or not, is one whose bytes came
   *  with the project. `trusted` answers whether a revision may run here: a
   *  folder found holding one keeps no content key, as a copy of it would
   *  be trusted anyway, so an open reads in full only the folders it finds
   *  untrusted or broken. */
  open(trusted: (revision: string) => boolean = () => false): void {
    this.trustedWhenFound = trusted
    let names: string[] = []
    try { names = readdirSync(this.dir) } catch { /* no Motifs/ yet */ }
    this.foundIds = new Set(names)
    for (const id of this.ids()) this.found(id)
  }

  /** `id`'s folder as it stands, heard as `opened` when it holds a package:
   *  bytes this session finds without having made them, as the project
   *  opens or as a backup is put back. */
  found(id: string): MotifState {
    this.foundIds?.add(id)
    const state = this.status(id)
    if (state.revision) this.emit(id, state.revision, 'opened')
    if (state.revision === null || !this.trustedWhenFound(state.revision)) {
      const key = this.contentKey(id)
      if (key !== null) this.foundContent.add(key)
    }
    return state
  }

  /** What the folder named `name` holds, whatever it is named: the revision
   *  its files make under one fixed id, the folder's name entering a
   *  revision only as its manifest's id (`declaredPackage`). Null when it
   *  holds no package. Read under the exact name, a name that is no table key
   *  included: `Motifs/Evil/` renamed `evil` holds the same content. */
  private contentKey(name: string): string | null {
    try {
      if (!this.present(name)) return null
      return revisionOf(readMotifDirectory(path.join(this.dir, name)), CONTENT_KEY_ID)
    } catch { return null }
  }

  /** `id`'s folder as it stands. A package other than the one this store
   *  last observed in it is heard as an edit made here of that one
   *  (`edited-while-open`, without a base when it observed none); a folder
   *  that first appeared after the open, and was never put back from a
   *  backup, is heard as `created`: received bytes cannot arrive in a new
   *  folder while the project is open, except as a copy or move of a folder
   *  found here, which is heard as found (`opened`) when its content is one
   *  found untrusted. These are the ways a write made while the project is
   *  open earns trust. The watcher, a read that finds an untrusted revision,
   *  and adopting the folder observe it. */
  observe(id: string): MotifState {
    const state = this.status(id)
    if (!state.revision) return state
    if (!this.observed.has(id) && this.foundIds !== null && !this.foundIds.has(id)) {
      const key = this.foundContent.size > 0 ? this.contentKey(id) : null
      this.emit(id, state.revision, key !== null && this.foundContent.has(key) ? 'opened' : 'created')
    } else this.saw(id, state.revision)
    return state
  }

  /** Hears `revision` as an edit of what `id`'s folder last held here, when
   *  it is not that. */
  private saw(id: string, revision: string): void {
    const base = this.observed.get(id) ?? null
    if (revision !== base) this.emit(id, revision, 'edited-while-open', base)
  }

  /** Listens for every revision the store writes or is told it saw;
   *  answers the unsubscribe. */
  onRevisionSeen(listener: RevisionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Tells the listeners, and observes `revision` as what `id`'s folder
   *  holds. */
  private emit(id: string, revision: string, cause: RevisionCause, base: string | null = null): void {
    this.observed.set(id, revision)
    for (const listener of this.listeners) listener(id, revision, cause, base)
  }
}

/** The id a folder's content is hashed under for `contentKey`: any fixed
 *  one, as `declaredPackage` checks no id. */
const CONTENT_KEY_ID = 'content'

/** `files` with `changes` (path to bytes, null to delete) applied. */
function withChanges(files: readonly MotifFile[], changes: ReadonlyMap<string, Buffer | null>): MotifFile[] {
  const next = new Map(files.map(f => [f.path, f.bytes]))
  for (const [rel, bytes] of changes) {
    if (bytes) next.set(rel, bytes)
    else next.delete(rel)
  }
  return [...next].map(([rel, bytes]) => ({ path: rel, bytes }))
}

/** The revision `files` make under `id`; null when they make no package. */
function revisionOf(files: readonly MotifFile[], id: string): string | null {
  try { return declaredPackage(files, id).revision } catch { return null }
}

/** The id `files`' manifest carries; null when they carry none or make no
 *  package. */
function declaredId(files: readonly MotifFile[]): string | null {
  try { return declaredManifest(files).input.id ?? null } catch { return null }
}
