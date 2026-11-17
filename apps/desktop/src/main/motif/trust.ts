// Which project Motif revisions may run on this machine (spec § Trust). Owns
// the machine-local record of trusted revisions, the revisions trusted
// without a record (the library's), the rule that decides what a revision
// seen in the open project earns, and the overlay that turns a folder's state
// into what may render. Does not own the gate: `MotifResolver` refuses an
// untrusted revision, and every surface that lists Motifs overlays
// `effectiveState`.
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { nodeAtomicWriteIo, writeFileAtomic } from '../atomicWrite'
import { motifRevision, type BuiltinMotif } from './authoring'
import type { MotifState, RevisionCause } from './projectStore'
import type { UserMotifStore } from './store'

/** The record's file name in the library root, so a data-root move carries
 *  it with the library. */
export const TRUST_FILE = '.trust.json'
/** Where an unreadable record is moved, for a person to look at. */
export const TRUST_CORRUPT_SUFFIX = '.corrupt'
/** Revisions kept in the record; past it the oldest trusted leave first. */
export const TRUST_KEPT = 20_000
/** Revisions remembered as found untrusted at an open; past it the oldest
 *  leave first. */
export const FOUND_KEPT = 20_000

const FORMAT = 1
const REVISION = /^[0-9a-f]{64}$/

/** Why a revision was trusted: copied in from this machine's library, made
 *  in a project here, an edit made while its project was open here, or the
 *  user's own Trust. */
export type TrustCause = 'placed' | 'created' | 'edited-while-open' | 'user'

/** Whether a revision may run. */
export interface MotifTrustView { trusted(revision: string): boolean }

/** Trusts everything: for a resolver or host whose test is not about trust. */
export const ALL_TRUSTED: MotifTrustView = { trusted: () => true }

/** What a project Motif's state is once trust is applied: a folder that
 *  makes a package of an untrusted revision is `untrusted`, its revision
 *  kept. Folder states other than `ok` pass through. */
export function effectiveState(state: MotifState, trust: MotifTrustView): MotifState {
  if (state.status !== 'ok' || state.revision === null || trust.trusted(state.revision)) return state
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
 *    open (adopting a received folder in place makes nothing new).
 *  - `imported`: nothing; trusted only if these bytes already are.
 *  - `edited-while-open`: trusted when the revision it was made from
 *    (`base`) is, and the result was not found untrusted at an open (an edit
 *    made while the project was closed, recorded late, is no edit made here).
 *  - `opened`: remembered as found when not trusted. */
export function trustOnSeen(revision: string, cause: RevisionCause, base: string | null,
  known: { trusted(revision: string): boolean; found: ReadonlySet<string> }): 'trust' | 'found' | null {
  switch (cause) {
    case 'placed': return 'trust'
    case 'created': return known.found.has(revision) ? null : 'trust'
    case 'imported': return null
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

/** The trust record of one machine: revisions by when they were trusted and
 *  why, in `<library>/.trust.json`. The map in memory is the record; the
 *  file follows it, written whole aside and renamed into place, coalesced to
 *  one write per turn of the event loop (`flush` writes now). */
export class MotifTrust implements MotifTrustView {
  /** Trusted revisions, oldest first. */
  private record: Map<string, [number, TrustCause]> | null = null
  private library: Set<string> | null = null
  /** Revisions found untrusted at an open, oldest first. Kept for the app's
   *  life, never per project: they are bytes, and the same bytes found
   *  elsewhere are as foreign. */
  private readonly found = new Set<string>()
  private dirty = false
  private scheduled = false

  /** `readLibrary` answers the revisions the library holds
   *  (`libraryRevisions`); it is asked again after `libraryChanged`. */
  constructor(private readonly file: string, private readonly readLibrary: () => Iterable<string>,
    private readonly clock: () => number = Date.now) {}

  trusted(revision: string): boolean {
    return this.load().has(revision) || this.libraryRevisions().has(revision)
  }

  /** Applies `trustOnSeen` to a revision the open project saw. */
  seen(revision: string, cause: RevisionCause, base: string | null): void {
    const decision = trustOnSeen(revision, cause, base, { trusted: (r) => this.trusted(r), found: this.found })
    if (decision === 'trust') this.add(revision, cause as TrustCause)
    else if (decision === 'found') {
      this.found.delete(revision)
      this.found.add(revision)
      if (this.found.size > FOUND_KEPT) this.found.delete(this.found.values().next().value!)
    }
  }

  /** The user's Trust: recorded and written before it returns. */
  trustNow(revision: string): void {
    this.add(revision, 'user')
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
    const revisions: Record<string, [number, TrustCause]> = {}
    for (const [revision, entry] of this.record) revisions[revision] = entry
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileAtomic(nodeAtomicWriteIo, this.file, JSON.stringify({ version: FORMAT, revisions }))
    } catch (error) {
      this.dirty = true
      console.warn('[motif-trust] the trust record could not be written', error)
    }
  }

  private add(revision: string, cause: TrustCause): void {
    if (!REVISION.test(revision)) return
    const record = this.load()
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

  private load(): Map<string, [number, TrustCause]> {
    if (this.record) return this.record
    this.record = new Map()
    let text: string
    try { text = readFileSync(this.file, 'utf8') } catch { return this.record }
    const entries = parseRecord(text)
    if (!entries) {
      // Moved aside, never written over: what it held is for a person to
      // read, and until then nothing in it is trusted.
      try { renameSync(this.file, this.file + TRUST_CORRUPT_SUFFIX) } catch { /* left in place */ }
      return this.record
    }
    entries.sort((a, b) => a[1][0] - b[1][0])
    for (const [revision, entry] of entries.slice(-TRUST_KEPT)) this.record.set(revision, entry)
    return this.record
  }
}

const CAUSES: ReadonlySet<string> = new Set<TrustCause>(['placed', 'created', 'edited-while-open', 'user'])

/** The record's entries, or null when the text is no record of this format.
 *  An entry that is not one is dropped alone. */
function parseRecord(text: string): [string, [number, TrustCause]][] | null {
  let saved: unknown
  try { saved = JSON.parse(text) } catch { return null }
  if (typeof saved !== 'object' || saved === null) return null
  const { version, revisions } = saved as { version?: unknown; revisions?: unknown }
  if (version !== FORMAT || typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)) return null
  const out: [string, [number, TrustCause]][] = []
  for (const [revision, entry] of Object.entries(revisions)) {
    if (!REVISION.test(revision) || !Array.isArray(entry)) continue
    const [at, cause] = entry as unknown[]
    if (typeof at === 'number' && Number.isFinite(at) && typeof cause === 'string' && CAUSES.has(cause)) out.push([revision, [at, cause as TrustCause]])
  }
  return out
}
