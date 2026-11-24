// Saving project Motifs to the library (spec § Library). A project Motif is
// published as a new version of the library Motif of its lineage, or as a new
// library Motif; the library keeps every version (ADR 0172) and no project is
// changed by it, as projects hold copies.
//
// For an agent publication is two steps (ADR 0046): `propose` freezes the
// project Motif's files as a proposal and leaves the library alone; the
// user's `approve` in the Motif panel publishes it, `reject` declines it with
// a note. The user's own "Save to library" publishes directly (`publish`).
// A proposal lives in `<library>/.proposals/`: `<proposal id>.json` records
// it, `<proposal id>/` holds its frozen package while it waits.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assignUniqueId, BUILTIN_IDS, builtinLineage, idFromName, isBuiltinLineage, type Manifest } from '../../shared/motifs/catalog'
import { isProjectMotifKey, projectMotifKey, proposalPreviewId, type ProjectMotifSource } from '../../shared/motifs/projectMotifs'
import { newLineage } from './lineage'
import { normalize, replacePackage } from './motifPackage'
import { readMotifDirectory, type MotifFile } from './packageFiles'
import { MotifRefusal } from './refusal'
import { DRAFTS_DIR, PROPOSALS_DIR, type MotifVersion, type UserMotifStore } from './store'

export type PublicationState = 'awaiting_approval' | 'approved' | 'rejected'
/** An update adds a version to `id`, seen at `version`; a first publication
 *  takes `new_id`. */
export type ProposalTarget = { id: string; version: number } | { new_id: string }

/** The project Motif a publication is made from, as it stands now. */
export interface PublicationSource {
  /** The project's folder. */
  project: string
  motif_id: string
  uid: string
  revision: string
  files: readonly MotifFile[]
}

/** Where a proposal came from: the project and its Motif's id and lineage. */
interface ProposalOrigin { project: string; motif_id: string; uid: string }

/** One proposed publication, as `<proposal id>.json` records it. */
interface Proposal {
  proposal_id: string
  state: PublicationState
  /** The project Motif's revision that was proposed. */
  revision: string
  target: ProposalTarget
  proposed_at: string
  decided_at?: string
  note?: string
  /** What approval published: the library id and version. */
  library_id?: string
  version?: number
  source: ProposalOrigin
  /** The lineage a first publication takes, planned when proposed so the
   *  new id it shows is made from it (ADR 0171). Never shown. */
  lineage?: string
}

/** The answer `install_motif` gives, and the `publication` a project row
 *  carries. */
export interface PublicationView {
  state: PublicationState
  proposal_id: string
  revision: string
  target: ProposalTarget
  note?: string
  library_id?: string
  version?: number
}

export interface ProposalDiff {
  files: { added: string[]; removed: string[]; changed: string[] }
  props: { added: string[]; removed: string[]; changed: string[] }
}

/** One pending proposal as the Motif panel's card shows it. */
export interface ProposalCard extends PublicationView {
  /** The project Motif it was proposed from. */
  source: { project: string; motif_id: string }
  proposed_at: string
  /** The host the frozen package is served and previewed under. */
  preview_id: string
  manifest: Manifest
  /** Against the library version it replaces; null for a first publication. */
  diff: ProposalDiff | null
}

/** What a "Save to library" of the source at `revision` would write
 *  (`plan`): the library Motif it replaces with the change against it, or
 *  `replaces: null` for a new one. */
export interface PublishPlan { revision: string; replaces: { id: string; version: number } | null; diff: ProposalDiff | null }

/** A publication whose library Motif took another lineage than its source
 *  ("save as new"): the source's entry follows it when its project is open. */
export interface Fork { project: string; motif_id: string; uid: string; from: ProjectMotifSource }

/** What a publication wrote. */
export interface Published { motif_id: string; version: number; revision: string; fork?: Fork }

const NOTE_CHARS = 500
const RECORD = /^([0-9a-f-]{36})\.json$/

function view(p: Proposal): PublicationView {
  return { state: p.state, proposal_id: p.proposal_id, revision: p.revision, target: p.target,
    ...(p.note ? { note: p.note } : {}), ...(p.library_id ? { library_id: p.library_id } : {}), ...(p.version ? { version: p.version } : {}) }
}
const sameTarget = (a: ProposalTarget, b: ProposalTarget) => JSON.stringify(a) === JSON.stringify(b)
const sameOrigin = (p: Proposal, project: string, motifId: string) => path.resolve(p.source.project) === path.resolve(project) && p.source.motif_id === motifId

export class LibraryPublications {
  constructor(readonly store: UserMotifStore) { }

  private recordFile(proposalId: string) { return path.join(this.store.root(), PROPOSALS_DIR, `${proposalId}.json`) }
  private packageDir(proposalId: string) { return this.store.proposalDir(proposalId) }

  private save(p: Proposal): void {
    const file = this.recordFile(p.proposal_id)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify(p))
    renameSync(file + '.tmp', file)
  }

  /** Every recorded proposal. An older release's proposals (folders named by
   *  draft, with no record) are not among them. */
  private all(): Proposal[] {
    let names: string[]
    try { names = readdirSync(path.join(this.store.root(), PROPOSALS_DIR)) } catch { return [] }
    const out: Proposal[] = []
    for (const name of names) {
      const match = RECORD.exec(name)
      if (!match) continue
      try {
        const p = JSON.parse(readFileSync(path.join(this.store.root(), PROPOSALS_DIR, name), 'utf8')) as Proposal
        if (p.proposal_id === match[1] && p.source && typeof p.source.motif_id === 'string') out.push(p)
      } catch { /* an unreadable record proposes nothing */ }
    }
    return out.sort((a, b) => a.proposed_at < b.proposed_at ? -1 : a.proposed_at > b.proposed_at ? 1 : 0)
  }

  private discard(p: Proposal): void {
    rmSync(this.packageDir(p.proposal_id), { recursive: true, force: true })
    this.store.revisions.forget(this.packageDir(p.proposal_id))
    rmSync(this.recordFile(p.proposal_id), { force: true })
  }

  /** The latest proposal made from each Motif of `project`, by its id. */
  latestOf(project: string): Map<string, PublicationView> {
    const out = new Map<string, PublicationView>()
    for (const p of this.all()) if (sameOrigin(p, project, p.source.motif_id)) out.set(p.source.motif_id, view(p))
    return out
  }

  private installed(): Set<string> { return new Set(this.store.publishedIds()) }

  /** The installed Motif of lineage `uid`; null when the library holds none
   *  (a built-in's lineage included: a built-in is never replaced). */
  holderOf(uid: string): string | null {
    if (isBuiltinLineage(uid)) return null
    const installed = this.installed()
    return this.store.lineage.holders(uid).find(key => installed.has(key)) ?? null
  }

  /** Whether a new library Motif may take lineage `uid`: no built-in or
   *  installed Motif is of it. Otherwise publishing anew forks it. */
  private freeLineage(uid: string): boolean {
    return !isBuiltinLineage(uid) && this.holderOf(uid) === null
  }

  /** The installed Motif a publication replaces, checked against the
   *  version the caller saw: `targetId` when given, else the one of the
   *  source's lineage; null for a first publication. `required` makes the
   *  version a caller must send. */
  private replaceTarget(uid: string, targetId: string | undefined, expectedVersion: number | undefined, required: boolean): { id: string; version: number } | null {
    const target = targetId ?? this.holderOf(uid)
    if (target === null) return null
    if (BUILTIN_IDS.includes(target))
      throw new MotifRefusal(`'${target}' is a built-in Motif and cannot be replaced; omit target_id to publish a new Motif`, { error: 'BuiltinMotif', id: target })
    const prev = this.store.listManifests().find(m => m.id === target)
    if (!prev)
      throw new MotifRefusal(`target_id '${target}' is not an installed Motif — list_motifs { group: "library" } lists them`, { error: 'MotifNotFound', id: target })
    const current = this.store.versions(target)[0]?.version ?? prev.version
    if ((expectedVersion !== undefined || required) && expectedVersion !== current)
      throw new MotifRefusal(`Library version conflict: '${target}' is at version ${current}; send expected_version ${current} to replace it`, { error: 'VersionConflict', id: target, current_version: current })
    return { id: target, version: current }
  }

  /** New ids other pending proposals hold. */
  private pendingNewIds(except?: string): Map<string, Proposal> {
    const out = new Map<string, Proposal>()
    for (const p of this.all())
      if (p.proposal_id !== except && p.state === 'awaiting_approval' && 'new_id' in p.target) out.set(p.target.new_id, p)
    return out
  }

  /** The id a first publication proposed by an agent takes: its manifest
   *  name's. A name someone holds refuses with the ways forward; it is never
   *  numbered. */
  private proposedNewId(name: string, lineage: string, except?: string): string {
    const id = idFromName(name, lineage)
    const installed = this.store.listManifests().find(m => m.id === id)
    const rename = "rename the Motif's manifest name (the new id is made from it)"
    if (installed)
      throw new MotifRefusal(`Motif id '${id}' is taken by the library Motif '${installed.name}' (version ${installed.version}); nothing was proposed — rename the Motif's manifest name for a new id, or replace that Motif with target_id '${id}' and expected_version ${installed.version}`, { error: 'MotifIdTaken', id, holder: 'installed', options: [rename, `replace with target_id '${id}' + expected_version ${installed.version}`] })
    const pending = this.pendingNewIds(except).get(id)
    const holder: [string, string] | null = BUILTIN_IDS.includes(id) || id === DRAFTS_DIR ? ['builtin', 'a built-in Motif']
      : pending ? ['proposal', `a pending proposal from Motif '${pending.source.motif_id}'`] : null
    if (holder)
      throw new MotifRefusal(`Motif id '${id}' is taken by ${holder[1]}; nothing was proposed — rename the Motif's manifest name for a new id`, { error: 'MotifIdTaken', id, holder: holder[0], options: [rename] })
    return id
  }

  /** Adds `files` as the next version of `id`, a new library Motif of
   *  `lineage` when given. Every publication and restore goes through here. */
  private addVersion(id: string, files: readonly MotifFile[], lineage: string | null) {
    const version = this.store.nextVersion(id)
    const pkg = normalize(files, id, version)
    this.store.addVersion(id, version, pkg.files)
    if (lineage) this.store.lineage.set(id, lineage)
    return { version, revision: pkg.revision }
  }

  /** The fork a publication of `source` as `id` makes, when it took another
   *  lineage. */
  private fork(origin: ProposalOrigin, lineage: string, version: number, revision: string): Fork | undefined {
    return lineage === origin.uid ? undefined
      : { project: origin.project, motif_id: origin.motif_id, uid: lineage, from: { uid: lineage, version, revision } }
  }

  /** Publishes `files` as a new library Motif named for their manifest:
   *  of `origin`'s lineage when it is free, else of a new one. */
  private publishNew(origin: ProposalOrigin, files: readonly MotifFile[], planned?: string, proposalId?: string): Published {
    const lineage = planned && this.freeLineage(planned) ? planned : this.freeLineage(origin.uid) ? origin.uid : newLineage()
    const name = normalize(files, 'motif', 'own').manifest.name
    const id = assignUniqueId(name, lineage, [...this.installed(), ...this.pendingNewIds(proposalId).keys()])
    const added = this.addVersion(id, files, lineage)
    const fork = this.fork(origin, lineage, added.version, added.revision)
    return { motif_id: id, ...added, ...(fork ? { fork } : {}) }
  }

  /** An agent's `install_motif`: freeze `source` as a pending publication
   *  to the library Motif of its lineage (or `target_id`), else to a new
   *  one. The library is not touched; a newer proposal from the same Motif
   *  supersedes the older one. */
  propose(source: PublicationSource, targetId?: string, expectedVersion?: number): PublicationView & { superseded_proposal_id?: string } {
    const replaces = this.replaceTarget(source.uid, targetId, expectedVersion, targetId !== undefined)
    const mine = this.all().filter(p => sameOrigin(p, source.project, source.motif_id))
    const old = mine[mine.length - 1]
    if (replaces && old?.state === 'approved' && old.revision === source.revision && old.library_id === replaces.id && old.version === replaces.version)
      return view(old)
    const pending = old?.state === 'awaiting_approval' ? old : undefined
    let lineage: string | undefined
    let target: ProposalTarget
    if (replaces) target = replaces
    else {
      lineage = pending?.lineage && this.freeLineage(pending.lineage) ? pending.lineage : this.freeLineage(source.uid) ? source.uid : newLineage()
      target = { new_id: this.proposedNewId(normalize(source.files, 'motif', 'own').manifest.name, lineage, pending?.proposal_id) }
    }
    if (pending && pending.revision === source.revision && sameTarget(pending.target, target)) return view(pending)
    const proposal: Proposal = { proposal_id: randomUUID(), state: 'awaiting_approval', revision: source.revision, target, proposed_at: new Date().toISOString(),
      source: { project: source.project, motif_id: source.motif_id, uid: source.uid }, ...(lineage ? { lineage } : {}) }
    replacePackage(this.packageDir(proposal.proposal_id), source.files)
    this.save(proposal)
    for (const p of mine) this.discard(p)
    return { ...view(proposal), ...(pending ? { superseded_proposal_id: pending.proposal_id } : {}) }
  }

  private pending(proposalId: string): Proposal {
    const p = typeof proposalId === 'string' ? this.all().find(q => q.proposal_id === proposalId) : undefined
    if (!p)
      throw new MotifRefusal('This proposal was superseded or withdrawn; review the current one', { error: 'ProposalNotFound', proposal_id: proposalId })
    if (p.state !== 'awaiting_approval')
      throw new MotifRefusal(`This proposal was already ${p.state}`, { error: 'ProposalDecided', proposal_id: proposalId, state: p.state })
    return p
  }

  /** The user's approval: the frozen package becomes a library version, of
   *  the target, or of a new library Motif with `asNew`. No project is
   *  written; a fork names the source entry to follow it. */
  approve(proposalId: string, asNew = false): { publication: PublicationView } & Published {
    const proposal = this.pending(proposalId)
    const dir = this.packageDir(proposalId)
    if (!existsSync(dir))
      throw new MotifRefusal('The proposed package is gone; ask for a new proposal', { error: 'ProposalNotFound', proposal_id: proposalId })
    const files = readMotifDirectory(dir)
    let published: Published
    if (asNew) published = this.publishNew(proposal.source, files, proposal.lineage, proposalId)
    else if ('new_id' in proposal.target) {
      const id = proposal.target.new_id
      if (this.installed().has(id) || BUILTIN_IDS.includes(id))
        throw new MotifRefusal(`'${id}' was published by someone else since this proposal; save it as a new Motif, or reject it and ask for a new one`, { error: 'MotifIdTaken', id })
      const lineage = proposal.lineage && this.freeLineage(proposal.lineage) ? proposal.lineage : this.freeLineage(proposal.source.uid) ? proposal.source.uid : newLineage()
      const added = this.addVersion(id, files, lineage)
      const fork = this.fork(proposal.source, lineage, added.version, added.revision)
      published = { motif_id: id, ...added, ...(fork ? { fork } : {}) }
    } else {
      const id = proposal.target.id
      const current = this.store.versions(id)[0]?.version
      if (current !== proposal.target.version)
        throw new MotifRefusal(`'${id}' changed since this proposal (now ${current ? `version ${current}` : 'deleted'}); save it as a new Motif, or reject it and ask for a new one`, { error: 'VersionConflict', id, current_version: current ?? null })
      published = { motif_id: id, ...this.addVersion(id, files, null) }
    }
    const decided: Proposal = { ...proposal, state: 'approved', decided_at: new Date().toISOString(), library_id: published.motif_id, version: published.version }
    this.save(decided)
    rmSync(dir, { recursive: true, force: true })
    this.store.revisions.forget(dir)
    return { publication: view(decided), ...published }
  }

  /** The user's rejection, with their note for the agent. */
  reject(proposalId: string, note?: string): PublicationView {
    const proposal = this.pending(proposalId)
    const text = typeof note === 'string' ? note.trim().slice(0, NOTE_CHARS) : ''
    const decided: Proposal = { ...proposal, state: 'rejected', decided_at: new Date().toISOString(), ...(text ? { note: text } : {}) }
    this.save(decided)
    rmSync(this.packageDir(proposalId), { recursive: true, force: true })
    this.store.revisions.forget(this.packageDir(proposalId))
    return view(decided)
  }

  /** What `publish` of `source` with no `asNew` would write, without writing
   *  it: the library Motif it replaces (`targetId`, else the one of its
   *  lineage) at its current version, with the change against it; or
   *  `replaces: null` when it makes a new one. The panel confirms a
   *  replacement on this before sending `expectedVersion`. */
  plan(source: PublicationSource, targetId?: string): PublishPlan {
    const replaces = this.replaceTarget(source.uid, targetId, undefined, false)
    return { revision: source.revision, replaces, diff: replaces && this.diff(source.files, replaces) }
  }

  /** The user's own "Save to library": publishes `source` directly. The
   *  default target is the library Motif of its lineage, replaced only at
   *  `expectedVersion`; `asNew` makes a new library Motif. */
  publish(source: PublicationSource, options: { targetId?: string; expectedVersion?: number; asNew?: boolean } = {}): Published {
    const origin = { project: source.project, motif_id: source.motif_id, uid: source.uid }
    if (options.asNew) return this.publishNew(origin, source.files)
    const replaces = this.replaceTarget(source.uid, options.targetId, options.expectedVersion, true)
    if (!replaces) return this.publishNew(origin, source.files)
    return { motif_id: replaces.id, ...this.addVersion(replaces.id, source.files, null) }
  }

  /** Every pending proposal, as the Motif panel's cards show them. */
  proposals(): ProposalCard[] {
    const out: ProposalCard[] = []
    for (const p of this.all()) {
      if (p.state !== 'awaiting_approval') continue
      let manifest: Manifest
      try { manifest = normalize(readMotifDirectory(this.packageDir(p.proposal_id)), p.source.motif_id, 'own').manifest } catch { continue }
      out.push({ ...view(p), source: { project: p.source.project, motif_id: p.source.motif_id }, proposed_at: p.proposed_at,
        preview_id: proposalPreviewId(p.proposal_id), manifest,
        diff: 'id' in p.target ? this.diff(readMotifDirectory(this.packageDir(p.proposal_id)), p.target) : null })
    }
    return out
  }

  /** Files and props schema of `files` against the version they replace.
   *  Both sides are normalised under the target's id and version, so only a
   *  real change differs. */
  private diff(files: readonly MotifFile[], target: { id: string; version: number }): ProposalDiff | null {
    const current = this.store.versionFiles(target.id, target.version)
    if (!current) return null
    let before: ReturnType<typeof normalize>, after: ReturnType<typeof normalize>
    try {
      before = normalize(current, target.id, target.version)
      after = normalize(files, target.id, target.version)
    } catch {
      return null
    }
    const was = new Map(before.files.map(f => [f.path, f.bytes])), now = new Map(after.files.map(f => [f.path, f.bytes]))
    const keys = (o: object | undefined) => Object.keys(o ?? {})
    const prev = before.manifest.props_schema, next = after.manifest.props_schema
    return {
      files: { added: [...now.keys()].filter(k => !was.has(k)).sort(), removed: [...was.keys()].filter(k => !now.has(k)).sort(),
        changed: [...now.keys()].filter(k => was.has(k) && !was.get(k)!.equals(now.get(k)!)).sort() },
      props: { added: keys(next).filter(k => !(k in prev)), removed: keys(prev).filter(k => !(k in next)),
        changed: keys(next).filter(k => k in prev && JSON.stringify(prev[k]) !== JSON.stringify(next[k])) },
    }
  }

  /** The saved versions of installed `id`, newest first; the first is the
   *  current one. Built-ins have none. */
  listVersions(id: string): MotifVersion[] {
    return builtinLineage(id) ? [] : this.store.versions(id)
  }

  /** The user's restore of an older version of installed `id`: its files
   *  are saved again as the newest version. */
  restore(id: string, version: number): { motif_id: string; version: number; revision: string } {
    if (builtinLineage(id))
      throw new Error('Built-in Motifs have no version history')
    const current = this.store.versions(id)[0]
    if (!current)
      throw new Error('Unknown Motif: ' + id)
    if (version === current.version)
      throw new Error(`Version ${version} is already the current version of '${id}'`)
    const files = Number.isSafeInteger(version) ? this.store.versionFiles(id, version) : null
    if (!files)
      throw new Error(`'${id}' has no version ${version}`)
    return { motif_id: id, ...this.addVersion(id, files, null) }
  }

  /** The user's delete of library Motif `id`: every version goes to the
   *  system trash; refuses, changing nothing, when the trash refuses. No
   *  project loses anything: projects hold copies. */
  async delete(id: string): Promise<void> {
    if (builtinLineage(id))
      throw new Error('Cannot delete a built-in Motif')
    if (!this.installed().has(id))
      throw new Error('Unknown Motif: ' + id)
    await this.store.trashMotif(id)
  }

  /** The user's rename of library Motif `id`, whose folder name cannot be
   *  its host (`libraryIdDiagnostic`), to the key it would be placed under
   *  (`projectMotifKey`). Answers the new id. */
  rename(id: string): string {
    if (!this.installed().has(id))
      throw new Error('Unknown Motif: ' + id)
    if (isProjectMotifKey(id))
      throw new Error(`'${id}' is already a valid folder name`)
    const to = projectMotifKey(id)
    if (BUILTIN_IDS.includes(to))
      throw new Error(`'${to}' is the id of a built-in Motif`)
    this.store.renameMotif(id, to)
    return to
  }
}
