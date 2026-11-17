// What a `motif://` host serves (spec § Project Motifs). A bare id is the open
// project's `Motifs/<id>/`; `<id>--library` is the library's current version
// of `id`, a built-in's bundled package included; `<key>--proposal` is a
// pending publication's frozen package. The protocol handler, capture and
// covers resolve and pin through here, never through a store.
import { parseManifestIsland, type Manifest } from '../../shared/motifs/catalog'
import { MotifError } from '../../shared/motifs/errors'
import { libraryHost, libraryIdOfHost, proposalOfHost, proposalPreviewId, type MotifStatus } from '../../shared/motifs/projectMotifs'
import { motifRevision, type BuiltinMotif } from './authoring'
import { motifFileSegments, type MotifFile } from './packageFiles'
import { libraryPackage, type ProjectMotifStore } from './projectStore'
import type { UserMotifStore } from './store'

export type MotifScope = 'project' | 'library' | 'proposal'

/** The scope a host names and the id within it: the project's or library's
 *  Motif id, or the proposal's key. */
export interface MotifRoute { scope: MotifScope; id: string }

export function routeOfHost(host: string): MotifRoute {
  const proposal = proposalOfHost(host)
  if (proposal !== null) return { scope: 'proposal', id: proposal }
  const library = libraryIdOfHost(host)
  if (library !== null) return { scope: 'library', id: library }
  return { scope: 'project', id: host }
}

/** A host's package as it stands: its manifest and revision when `ok`, why
 *  not otherwise. */
export interface ResolvedMotif extends MotifRoute {
  status: MotifStatus
  revision: string | null
  manifest: Manifest | null
  diagnostic?: string
}

/** A package that may render. */
export interface RenderableMotif { manifest: Manifest; revision: string }

/** A capture host's hold on a pinned revision snapshot; `release` is idempotent. */
export interface PinnedPackage { release(): void }

/** One scope's packages, by id. `describe` and `snapshot` answer null when
 *  the package is gone and throw what makes its files no package. */
interface ScopeReader {
  describe(id: string): RenderableMotif | null
  file(id: string, rel: string): Buffer | null
  snapshot(id: string): { files: readonly MotifFile[]; revision: string } | null
}

/** A pinned revision's path under its host: `.revisions/<revision>/<rel>`. */
const PINNED_PATH = /^\.revisions\/([0-9a-f]{64})\/(.+)$/
/** Snapshots no host holds that stay for reuse; held ones never leave. */
const UNHELD_SNAPSHOTS = 2

const builtinFiles = (b: BuiltinMotif) => b.files ?? [{ path: 'index.html', bytes: Buffer.from(b.html) }]

export class MotifResolver {
  private projectStore: ProjectMotifStore | null = null
  /** Revision snapshots by `<scope>/<id>/<revision>`, oldest first, with
   *  their holders. The key carries no project: a revision is its bytes. */
  private readonly pinned = new Map<string, { files: Map<string, Buffer>; holders: number }>()
  private readonly library: ScopeReader
  private readonly proposals: ScopeReader

  constructor(private readonly store: UserMotifStore, private readonly builtins: readonly BuiltinMotif[]) {
    this.library = {
      describe: id => {
        const builtin = builtins.find(b => b.id === id)
        if (builtin) return { manifest: builtin.manifest, revision: motifRevision(store, [...builtins], id) }
        const listing = store.installedListing(id)
        return listing && { manifest: parseManifestIsland(listing.html), revision: listing.revision }
      },
      file: (id, rel) => {
        const builtin = builtins.find(b => b.id === id)
        if (builtin) return builtinFiles(builtin).find(f => f.path === rel)?.bytes ?? null
        return store.installedFile(id, rel)
      },
      snapshot: id => libraryPackage(store, builtins, id),
    }
    this.proposals = {
      describe: key => {
        const listing = store.describe(proposalPreviewId(key))
        return listing && { manifest: parseManifestIsland(listing.html), revision: listing.revision }
      },
      file: (key, rel) => store.readFile(proposalPreviewId(key), rel),
      snapshot: key => store.packageSnapshot(proposalPreviewId(key)),
    }
  }

  /** The open project's Motifs; null when no project is open, and every
   *  project host is then missing. */
  setProject(project: ProjectMotifStore | null): void { this.projectStore = project }
  project(): ProjectMotifStore | null { return this.projectStore }

  private reader(scope: MotifScope): ScopeReader | null {
    if (scope === 'library') return this.library
    if (scope === 'proposal') return this.proposals
    const project = this.projectStore
    if (!project) return null
    return {
      describe: id => {
        const found = project.describe(id)
        return found && { manifest: found.manifest, revision: found.revision }
      },
      file: (id, rel) => project.readFile(id, rel),
      snapshot: id => project.snapshot(id),
    }
  }

  /** Every status a host can have is decided here; `gate`, `readFile` and
   *  `pin` refuse whatever is not `ok`. */
  resolve(host: string): ResolvedMotif {
    const route = routeOfHost(host)
    const absent = (diagnostic: string): ResolvedMotif => ({ ...route, status: 'missing', revision: null, manifest: null, diagnostic })
    const reader = this.reader(route.scope)
    if (!reader) return absent('No project is open')
    try {
      const found = reader.describe(route.id)
      if (!found) return absent(missingText(route))
      return { ...route, status: 'ok', revision: found.revision, manifest: found.manifest }
    } catch (error) {
      return { ...route, status: 'invalid', revision: null, manifest: null, diagnostic: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The host's package when it may render; throws a `content` MotifError
   *  naming why not. */
  gate(host: string): RenderableMotif {
    const resolved = this.resolve(host)
    if (resolved.status !== 'ok') throw new MotifError('content', resolved.diagnostic ?? `Motif '${host}' is ${resolved.status}`)
    return { manifest: resolved.manifest!, revision: resolved.revision! }
  }

  /** A file the host serves: one of a pinned revision under
   *  `.revisions/<revision>/`, else of its package while it may render. */
  readFile(host: string, rel: string): Buffer | null {
    const route = routeOfHost(host)
    const pinned = PINNED_PATH.exec(rel)
    if (pinned) return this.pinned.get(pinKey(route, pinned[1]!))?.files.get(pinned[2]!) ?? null
    if (!motifFileSegments(rel) || this.resolve(host).status !== 'ok') return null
    return this.reader(route.scope)!.file(route.id, rel)
  }

  /** Pins `revision` of the host's package, so a capture host serves its page
   *  and companions from one snapshot and a save cannot mix old HTML with new
   *  assets. A held snapshot stays until every host holding it releases it: a
   *  host still loading its page must not lose it to a later pin. A revision
   *  not pinned already passes `gate`; throws when the package no longer
   *  holds `revision`. */
  pin(host: string, revision: string): PinnedPackage {
    const route = routeOfHost(host)
    const key = pinKey(route, revision)
    let snapshot = this.pinned.get(key)
    if (snapshot) this.pinned.delete(key)
    else {
      this.gate(host)
      const read = this.reader(route.scope)!.snapshot(route.id)
      if (read?.revision !== revision) throw new Error('Motif revision changed before capture; refresh the catalog')
      snapshot = { files: new Map(read.files.map(f => [f.path, f.bytes])), holders: 0 }
    }
    snapshot.holders++
    // Most recently pinned last.
    this.pinned.set(key, snapshot)
    const held = snapshot
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        held.holders--
        this.trimPinned()
      },
    }
  }

  /** Every host served now: the library's Motifs and the open project's. */
  hosts(): string[] {
    return [
      ...this.builtins.map(b => libraryHost(b.id)),
      ...this.store.publishedIds().map(libraryHost),
      ...this.projectStore?.ids() ?? [],
    ]
  }

  private trimPinned(): void {
    let unheld = 0
    for (const s of this.pinned.values()) if (s.holders === 0) unheld++
    for (const [key, s] of this.pinned) {
      if (unheld <= UNHELD_SNAPSHOTS) return
      if (s.holders > 0) continue
      this.pinned.delete(key)
      unheld--
    }
  }
}

const pinKey = (route: MotifRoute, revision: string) => `${route.scope}/${route.id}/${revision}`

function missingText({ scope, id }: MotifRoute): string {
  if (scope === 'project') return `Motif '${id}' has no folder in this project`
  if (scope === 'library') return `Motif '${id}' is not in the library`
  return `No pending publication '${id}'`
}
