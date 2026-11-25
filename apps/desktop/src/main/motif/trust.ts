// Which project Motif revisions may run on this machine (spec § Trust, ADR
// 0174, ADR 0182). Owns the machine-local record of trusted revisions and of
// trusted or dismissed project folders, the revisions trusted without a
// record (the library's), the rule that decides what a revision seen in the
// open project earns, and the overlay that turns a folder's state into what
// may render. Does not own the gate: `MotifResolver` refuses an untrusted
// revision, and every surface that lists Motifs overlays `effectiveState`.
import { mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import path from 'node:path'
import { ATOMIC_TEMP_SUFFIX, nodeAtomicWriteIo, writeFileAtomic } from '../atomicWrite'
import { motifRevision, type BuiltinMotif } from './authoring'
import type { MotifState, RevisionCause } from './projectStore'
import type { UserMotifStore } from './store'

/** The record's file name in the library root, so a data-root move carries
 *  it with the library. */
export const TRUST_FILE = '.trust.json'
/** Where an unreadable record is moved, for a person to look at. */
export const TRUST_CORRUPT_SUFFIX = '.corrupt'
/** Every name the record writes in the library root: itself, its atomic
 *  write's temp, and an unreadable one moved aside. None is a package's. */
export const TRUST_FILES: readonly string[] = [TRUST_FILE, TRUST_FILE + ATOMIC_TEMP_SUFFIX, TRUST_FILE + TRUST_CORRUPT_SUFFIX]
/** Revisions kept in the record; past it the oldest trusted leave first. */
export const TRUST_KEPT = 20_000
/** Revisions remembered as found untrusted at the opens of projects no
 *  longer open; past it the oldest leave first. The open project's are all
 *  kept: a project shipping more folders than this must not push its own
 *  out. */
export const FOUND_KEPT = 20_000
/** Project folders kept in each folder scope of the record (trusted,
 *  dismissed); past it the oldest leave first. */
export const PROJECTS_KEPT = 2_000

/** LANDMINE: stays 1. A build that knows only `revisions` reads a record of
 *  this version and ignores `projects` and `dismissed`; any other version
 *  makes it set the whole record aside as unreadable (ADR 0182). */
const FORMAT = 1
const REVISION = /^[0-9a-f]{64}$/

/** Why a revision was trusted: copied in from this machine's library, made
 *  in a project here, an edit made while its project was open here, or the
 *  user's own Trust of that one revision. Nothing writes `user` now; a record
 *  holding it is still read, and what it trusts stays trusted. */
export type TrustCause = 'placed' | 'created' | 'edited-while-open' | 'user'

/** Whether a revision may run. */
export interface MotifTrustView { trusted(revision: string): boolean }

/** Trusts everything: for a resolver or host whose test is not about trust. */
export const ALL_TRUSTED: MotifTrustView = { trusted: () => true }

/** Whether the open project's Motif `id` may run at `revision`. The app's is
 *  `MotifResolver.projectTrusted`, which also judges an edit made while the
 *  project is open that the watcher has not heard yet, from the revision the
 *  open project last observed in the folder; a `MotifTrustView` is one that
 *  ignores the id. */
export interface ProjectTrustView { trusted(revision: string, id: string): boolean }

/** What project Motif `id`'s state is once trust is applied: a folder that
 *  makes a package of an untrusted revision is `untrusted`, its revision
 *  kept. Folder states other than `ok` pass through. */
export function effectiveState(id: string, state: MotifState, trust: ProjectTrustView): MotifState {
  if (state.status !== 'ok' || state.revision === null || trust.trusted(state.revision, id)) return state
  return { status: 'untrusted', revision: state.revision, diagnostic: UNTRUSTED_DIAGNOSTIC }
}

/** An untrusted Motif's diagnostic, as export refusals and `project://session`
 *  quote it. */
export const UNTRUSTED_DIAGNOSTIC = 'not trusted on this machine'

/** What seeing `revision` earns: `trust` to record it, `found` to remember it
 *  as found untrusted at an open, null for nothing.
 *
 *  - `placed`: trusted, its bytes came from this machine's library.
 *  - `created`: trusted, unless the same bytes were found untrusted at an
 *    open.
 *  - `imported`: trusted when the files as they came (`base`, the revision
 *    they make under the id they carry) are, and the copy was not found
 *    untrusted at an open: a ZIP this library exported, taken in under
 *    another id because the project holds its own. Otherwise nothing:
 *    trusted only if these bytes already are.
 *  - `edited-while-open`: trusted when the revision this session last
 *    observed in the folder (`base`) is, and the result was not found
 *    untrusted at an open. Never the revision a project's table records: the
 *    sender of a project writes that.
 *  - `opened`: remembered as found when not trusted. */
export function trustOnSeen(revision: string, cause: RevisionCause, base: string | null,
  known: { trusted(revision: string): boolean; found: { has(revision: string): boolean } }): 'trust' | 'found' | null {
  switch (cause) {
    case 'placed': return 'trust'
    case 'created': return known.found.has(revision) ? null : 'trust'
    case 'imported': return base !== null && known.trusted(base) && !known.found.has(revision) ? 'trust' : null
    case 'edited-while-open': return base !== null && known.trusted(base) && !known.found.has(revision) ? 'trust' : null
    case 'opened': return known.trusted(revision) ? null : 'found'
  }
}

/** The revisions the library holds: every built-in's, and every installed
 *  version's. Trusted without a record: the library grows only from what
 *  the user published or approved here. */
export function libraryRevisions(store: UserMotifStore, builtins: readonly BuiltinMotif[]): Set<string> {
  const out = new Set<string>()
  for (const builtin of builtins) {
    try { out.add(motifRevision(store, [...builtins], builtin.id)) } catch { /* not a package */ }
  }
  let ids: string[] = []
  try { ids = store.publishedIds() } catch { /* an unreadable library holds none */ }
  for (const id of ids) {
    try { for (const version of store.versions(id)) out.add(version.revision) } catch { /* not a package */ }
  }
  return out
}

/** A folder's key in the record: its canonical path, so a symlink and its
 *  target are one project and a renamed or moved folder is another. Null when
 *  the folder cannot be read. */
export type CanonicalFolder = (dir: string) => string | null

const realFolder: CanonicalFolder = (dir) => {
  try { return realpathSync.native(dir) } catch { return null }
}

/** Whether the open project's folder is trusted on this machine, and whether
 *  its question was put off (*Later*, or *Stop trusting*). */
export interface ProjectTrustState { trusted: boolean; dismissed: boolean }

interface TrustRecord {
  /** Trusted revisions, oldest first. */
  revisions: Map<string, [number, TrustCause]>
  /** Trusted project folders by canonical path, oldest first. */
  projects: Map<string, number>
  /** Project folders whose question was put off, oldest first. */
  dismissed: Map<string, number>
}

/** The trust record of one machine, in `<library>/.trust.json`: revisions by
 *  when they were trusted and why, and project folders by when they were
 *  trusted or their question put off. The maps in memory are the record; the
 *  file follows them, written whole aside and renamed into place, coalesced
 *  to one write per turn of the event loop (`flush` writes now). What the
 *  user decides about a folder is written before the call returns. */
export class MotifTrust implements MotifTrustView {
  private record: TrustRecord | null = null
  private library: Set<string> | null = null
  /** Revisions found untrusted at the opens of projects no longer open,
   *  oldest first, at most `FOUND_KEPT`. Kept for the app's life, never per
   *  project: they are bytes, and the same bytes found elsewhere are as
   *  foreign. */
  private readonly found = new Set<string>()
  /** Revisions found untrusted since the open project became the open one
   *  (`projectOpened`), every one kept. */
  private foundNow = new Set<string>()
  /** The open project's folder as `projectOpened` named it, and its key once
   *  the folder could be read. */
  private openDir: string | null = null
  private openKey: string | null = null
  private dirty = false
  private scheduled = false

  /** `readLibrary` answers the revisions the library holds
   *  (`libraryRevisions`); it is asked again after `libraryChanged`. */
  constructor(private readonly file: string, private readonly readLibrary: () => Iterable<string>,
    private readonly clock: () => number = Date.now, private readonly canonical: CanonicalFolder = realFolder) {}

  /** Whether `revision` is trusted for its bytes. A trusted folder never
   *  makes one so (`openProjectTrusted` is laid over this by the resolver):
   *  trusting a folder records no revision, and untrusting it leaves every
   *  revision as it was. */
  trusted(revision: string): boolean {
    return this.load().revisions.has(revision) || this.libraryRevisions().has(revision)
  }

  /** Applies `trustOnSeen` to a revision the open project saw. */
  seen(revision: string, cause: RevisionCause, base: string | null): void {
    const found = { has: (r: string) => this.foundNow.has(r) || this.found.has(r) }
    const decision = trustOnSeen(revision, cause, base, { trusted: (r) => this.trusted(r), found })
    // An import trusted for its source's bytes is this library's, placed.
    if (decision === 'trust') this.add(revision, cause === 'imported' ? 'placed' : cause as TrustCause)
    else if (decision === 'found') this.foundNow.add(revision)
  }

  /** Project folder `dir` becomes the open one (null: none is): what the
   *  last one found joins the revisions kept from earlier opens. */
  projectOpened(dir: string | null = null): void {
    for (const revision of this.foundNow) {
      this.found.delete(revision)
      this.found.add(revision)
      if (this.found.size > FOUND_KEPT) this.found.delete(this.found.values().next().value!)
    }
    this.foundNow = new Set()
    this.openDir = dir
    this.openKey = dir === null ? null : this.canonical(dir)
  }

  /** Whether the open project's folder is trusted here: every revision under
   *  it may run, whatever wrote it (ADR 0182). */
  openProjectTrusted(): boolean {
    const key = this.openFolder()
    return key !== null && this.load().projects.has(key)
  }

  projectState(): ProjectTrustState {
    const key = this.openFolder()
    if (key === null) return { trusted: false, dismissed: false }
    const record = this.load()
    return { trusted: record.projects.has(key), dismissed: record.dismissed.has(key) }
  }

  /** The user trusts the open project's folder. Throws when no project is
   *  open or its folder cannot be read. */
  trustProject(): void {
    this.put(this.load().projects, this.requireOpenFolder())
    this.flush()
  }

  /** The user stops trusting the open project's folder; its question stays
   *  put off. */
  untrustProject(): void {
    const key = this.requireOpenFolder()
    const record = this.load()
    if (record.projects.delete(key)) this.dirty = true
    this.put(record.dismissed, key)
    this.flush()
  }

  /** The user puts the open project's question off (*Later*). A folder put
   *  off already keeps when it was. */
  dismissProject(): void {
    const key = this.requireOpenFolder()
    const record = this.load()
    if (!record.dismissed.has(key)) this.put(record.dismissed, key)
    this.flush()
  }

  /** Save As made `toDir` from `fromDir`: the new folder is trusted, and its
   *  question put off, exactly when the old one's is. */
  carryProject(fromDir: string, toDir: string): void {
    const to = this.canonical(toDir)
    if (to === null) return
    const from = this.canonical(fromDir)
    const record = this.load()
    for (const scope of [record.projects, record.dismissed]) {
      if (from !== null && scope.has(from)) this.put(scope, to)
      else if (scope.delete(to)) this.dirty = true
    }
    this.flush()
  }

  /** The library changed on disk: its revisions are read again when next
   *  asked. */
  libraryChanged(): void { this.library = null }

  /** Writes the record now when it holds what the file does not. A record
   *  that cannot be written lasts the process, and is written again with
   *  the next change. */
  flush(): void {
    if (!this.dirty || !this.record) return
    this.dirty = false
    const { revisions, projects, dismissed } = this.record
    const saved = {
      version: FORMAT,
      revisions: Object.fromEntries(revisions),
      projects: Object.fromEntries(projects),
      dismissed: Object.fromEntries(dismissed),
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileAtomic(nodeAtomicWriteIo, this.file, JSON.stringify(saved))
    } catch (error) {
      this.dirty = true
      console.warn('[motif-trust] the trust record could not be written', error)
    }
  }

  /** The open project's folder key, read again while its folder could not
   *  be: a project store opens before its folder is first written. */
  private openFolder(): string | null {
    if (this.openKey === null && this.openDir !== null) this.openKey = this.canonical(this.openDir)
    return this.openKey
  }

  private requireOpenFolder(): string {
    const key = this.openFolder()
    if (key === null) throw new Error(this.openDir === null ? 'No project is open' : 'The project folder cannot be read')
    return key
  }

  /** Sets `key` in a folder scope as its newest entry. */
  private put(scope: Map<string, number>, key: string): void {
    scope.delete(key)
    scope.set(key, this.clock())
    while (scope.size > PROJECTS_KEPT) scope.delete(scope.keys().next().value!)
    this.dirty = true
  }

  private add(revision: string, cause: TrustCause): void {
    if (!REVISION.test(revision)) return
    const record = this.load().revisions
    // A revision the library holds is recorded too: it stays trusted once
    // its library version is deleted.
    if (record.has(revision)) return
    record.set(revision, [this.clock(), cause])
    while (record.size > TRUST_KEPT) record.delete(record.keys().next().value!)
    this.dirty = true
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => { this.scheduled = false; this.flush() })
  }

  private libraryRevisions(): Set<string> {
    if (!this.library) this.library = new Set(this.readLibrary())
    return this.library
  }

  private load(): TrustRecord {
    if (this.record) return this.record
    this.record = { revisions: new Map(), projects: new Map(), dismissed: new Map() }
    let text: string
    try { text = readFileSync(this.file, 'utf8') } catch { return this.record }
    const parsed = parseRecord(text)
    if (!parsed) {
      // Moved aside, never written over: what it held is for a person to
      // read, and until then nothing in it is trusted.
      try { renameSync(this.file, this.file + TRUST_CORRUPT_SUFFIX) } catch { /* left in place */ }
      return this.record
    }
    parsed.revisions.sort((a, b) => a[1][0] - b[1][0])
    for (const [revision, entry] of parsed.revisions.slice(-TRUST_KEPT)) this.record.revisions.set(revision, entry)
    for (const scope of ['projects', 'dismissed'] as const) {
      parsed[scope].sort((a, b) => a[1] - b[1])
      for (const [key, at] of parsed[scope].slice(-PROJECTS_KEPT)) this.record[scope].set(key, at)
    }
    return this.record
  }
}

const CAUSES: ReadonlySet<string> = new Set<TrustCause>(['placed', 'created', 'edited-while-open', 'user'])

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The record's entries, or null when the text is no record of this format.
 *  An entry that is not one is dropped alone; a folder scope that is not a
 *  map holds none, as in a record written before folder scopes. */
function parseRecord(text: string): { revisions: [string, [number, TrustCause]][]; projects: [string, number][]; dismissed: [string, number][] } | null {
  let saved: unknown
  try { saved = JSON.parse(text) } catch { return null }
  if (!isMap(saved)) return null
  const { version, revisions } = saved
  if (version !== FORMAT || !isMap(revisions)) return null
  const out: [string, [number, TrustCause]][] = []
  for (const [revision, entry] of Object.entries(revisions)) {
    if (!REVISION.test(revision) || !Array.isArray(entry)) continue
    const [at, cause] = entry as unknown[]
    if (typeof at === 'number' && Number.isFinite(at) && typeof cause === 'string' && CAUSES.has(cause)) out.push([revision, [at, cause as TrustCause]])
  }
  const folders = (scope: unknown): [string, number][] => isMap(scope)
    ? Object.entries(scope).filter((e): e is [string, number] => e[0] !== '' && typeof e[1] === 'number' && Number.isFinite(e[1]))
    : []
  return { revisions: out, projects: folders(saved.projects), dismissed: folders(saved.dismissed) }
}
