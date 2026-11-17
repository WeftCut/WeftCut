// Keeps the open project's Motif folders and its recorded Motif table in
// step (spec § Project Motifs): a library Motif is copied in before the
// commit that records it, a folder edited on disk becomes a recorded commit,
// every revision the table records is backed up, and a state taken back from
// history puts each folder back as its table says. Owns none of the three:
// the folders are `ProjectMotifStore`'s, the backups `MotifBackups`', the
// table the actor's.
import path from 'node:path'
import type { ProjectMotifs, ProjectMotifSource } from '../../shared/motifs/projectMotifs'
import type { ActorHandle, ChangeEvent, ProjectMotifAccess } from '../state/actor'
import type { Actor } from '../state/history'
import { eachLayer, type Project } from '../state/model'
import { buildRebindUpdates, type MotifLayerRef } from './authoring'
import { MotifBackups } from './backups'
import type { LibraryPackage, MotifState, ProjectMotifStore } from './projectStore'

/** Who a Motif folder edited on disk is recorded as: an edit no tool call
 *  made, by an agent writing the files or by the user in their own editor.
 *  An agent's, so Review lists it (ADR 0115). */
export const FILE_EDITS: Actor = { kind: 'Agent', client: 'files' }

/** The actor's view of the open project's Motifs (`ProjectMotifAccess`):
 *  folders read through `project`, library packages from `library`. */
export function projectMotifAccess(project: () => ProjectMotifStore | null, library: (id: string) => LibraryPackage | null): ProjectMotifAccess {
  return {
    manifest: (id) => {
      try { return project()?.describe(id)?.manifest ?? null } catch { return null }
    },
    place: (id, table) => {
      const pkg = library(id)
      if (!pkg) return null
      const store = project()
      if (!store) throw new Error('No project is open to copy it into')
      const placed = store.place(pkg, table)
      const manifest = store.describe(placed.id)?.manifest
      if (!manifest) throw new Error(`Motifs/${placed.id}/ holds no package`)
      return { id: placed.id, entry: placed.entry, manifest }
    },
  }
}

export interface ProjectMotifRecordsDeps {
  actor: Pick<ActorHandle, 'snapshot' | 'dispatch' | 'subscribe'>
  /** The open project's Motifs; null with none open. */
  project: () => ProjectMotifStore | null
  /** The library's current package of lineage `uid`; null when it holds none. */
  libraryOfLineage: (uid: string) => LibraryPackage | null
  /** A best-effort status-log row for what could not be kept in step. */
  warn?: (message: string, details: Record<string, unknown>) => void
}

export class ProjectMotifRecords {
  /** `<project>\0<id>\0<revision>` known to be backed up, so a commit reads
   *  no folder whose recorded revision is already kept. */
  private readonly kept = new Set<string>()

  constructor(private readonly deps: ProjectMotifRecordsDeps) {
    deps.actor.subscribe((e) => this.changed(e))
  }

  private backups(project: ProjectMotifStore): MotifBackups {
    return new MotifBackups(path.dirname(project.root()))
  }

  /** Every recorded state: its revisions are backed up; one taken back from
   *  history first has its folders put back to match it. */
  private changed(e: ChangeEvent): void {
    const project = this.deps.project()
    if (!project) return
    try {
      if (e.replaced) this.kept.clear()
      if (e.from_history) this.reconcile(project, e.new_snapshot.motifs)
      this.backUp(project, e.new_snapshot.motifs)
    } catch (error) {
      this.warn('Motif backups could not be kept in step with the project', { error: String(error) })
    }
  }

  /** Backs up each revision `motifs` records whose folder holds it. */
  private backUp(project: ProjectMotifStore, motifs: Readonly<ProjectMotifs>): void {
    const backups = this.backups(project)
    for (const [id, entry] of Object.entries(motifs)) {
      if (!entry.revision) continue
      const key = `${project.root()}\0${id}\0${entry.revision}`
      if (this.kept.has(key)) continue
      if (!backups.has(id, entry.revision)) {
        // The stamp-remembered revision first: a folder ahead of its record
        // is read whole only once it is recorded.
        if (project.status(id).revision !== entry.revision) continue
        let snapshot
        try { snapshot = project.snapshot(id) } catch { continue }
        if (snapshot?.revision !== entry.revision) continue
        backups.backup(id, snapshot.files, snapshot.revision)
      }
      this.kept.add(key)
    }
  }

  /** Puts back each folder whose revision is not the one `motifs` records,
   *  from its backup, after backing up what the folder holds. A folder whose
   *  files make no package is left as it is: they are an edit in progress,
   *  which no backup could hold. */
  private reconcile(project: ProjectMotifStore, motifs: Readonly<ProjectMotifs>): void {
    const backups = this.backups(project)
    for (const [id, entry] of Object.entries(motifs)) {
      if (!entry.revision) continue
      const state = project.status(id)
      if (state.revision === entry.revision) continue
      if (state.status === 'invalid') {
        this.warn(`Motif '${id}' was not put back: its folder holds an unfinished edit`, { motif_id: id, diagnostic: state.diagnostic })
        continue
      }
      if (!backups.has(id, entry.revision)) {
        this.warn(`Motif '${id}' was not put back: revision ${entry.revision} has no backup`, { motif_id: id, revision: entry.revision })
        continue
      }
      const current = project.snapshot(id)
      if (current) backups.backup(id, current.files, current.revision)
      backups.restore(id, entry.revision)
    }
  }

  /** A folder the watcher saw change. One the table records and that makes
   *  a package becomes a `set_project_motif` commit (`FILE_EDITS`), its
   *  revision backed up first; any other change is status alone. */
  folderChanged(id: string, state: MotifState): void {
    const project = this.deps.project()
    const entry = this.deps.actor.snapshot().motifs[id]
    if (!project || !entry || state.status !== 'ok') return
    // Called from the watcher's timer, where a throw would escape the app: a
    // write the project refuses now (an export or a project switch under
    // way) is told and left for the next change or open to record.
    try { if (this.record(project, id, entry.revision)) project.seen(id, 'edited-while-open') }
    catch (error) { this.warn(`The edit to Motif '${id}' could not be recorded`, { motif_id: id, error: String(error) }) }
  }

  /** Records what `id`'s folder holds when it is not `recorded`; answers
   *  whether a commit did. */
  private record(project: ProjectMotifStore, id: string, recorded: string | null): boolean {
    let snapshot
    try { snapshot = project.snapshot(id) } catch { return false }
    if (!snapshot || snapshot.revision === recorded) return false
    this.backups(project).backup(id, snapshot.files, snapshot.revision)
    const result = this.deps.actor.dispatch('set_project_motif', { motif_id: id, revision: snapshot.revision }, FILE_EDITS)
    if (!result.ok) this.warn(`The edit to Motif '${id}' could not be recorded`, { motif_id: id, error: result.error })
    return result.ok
  }

  /** A project open settled: each Motif's revision is seen as found, one
   *  changed while the project was closed is recorded like an edit, and the
   *  backups keep only what the table records (undo history starts empty at
   *  an open, and is never stored). */
  opened(): void {
    const project = this.deps.project()
    if (!project) return
    const keep: [string, string][] = []
    const kept = () => { for (const [id, entry] of Object.entries(this.deps.actor.snapshot().motifs)) if (entry.revision) keep.push([id, entry.revision]) }
    kept()
    for (const [id, entry] of Object.entries(this.deps.actor.snapshot().motifs)) {
      try {
        // Seen as found at the open, never as an edit made here (Motif trust).
        if (project.seen(id, 'opened').status === 'ok') this.record(project, id, entry.revision)
      } catch (error) {
        this.warn(`Motif '${id}' could not be checked`, { motif_id: id, error: String(error) })
      }
    }
    kept()
    try {
      this.backups(project).gc(keep)
      this.kept.clear()
      this.backUp(project, this.deps.actor.snapshot().motifs)
    } catch (error) {
      this.warn('The project\'s Motif backups could not be collected', { error: String(error) })
    }
  }

  /** The user's update of the project copy of `id` to the library's current
   *  version of its lineage: the folder is replaced, then one commit records
   *  the new revision and source and rebinds every layer on it to the new
   *  props schema. The replaced revision stays in the backups; a refused
   *  commit puts the folder back. */
  updateFromLibrary(id: string): { motif_id: string; revision: string; from: ProjectMotifSource } {
    const project = this.deps.project()
    if (!project) throw new Error('No project is open')
    const snapshot = this.deps.actor.snapshot()
    const entry = snapshot.motifs[id]
    if (!entry) throw new Error(`No Motif '${id}' in this project`)
    const pkg = this.deps.libraryOfLineage(entry.uid)
    if (!pkg) throw new Error(`The library holds no version of Motif '${id}'`)
    const backups = this.backups(project)
    let before: ReturnType<ProjectMotifStore['snapshot']> = null
    try { before = project.snapshot(id) } catch { /* an unfinished edit: replaced */ }
    if (before) backups.backup(id, before.files, before.revision)
    const revision = project.replace(id, pkg.files, 'placed')
    const after = project.snapshot(id)!
    backups.backup(id, after.files, after.revision)
    const manifest = project.describe(id)!.manifest
    const from: ProjectMotifSource = { uid: pkg.uid, version: pkg.version, revision: pkg.revision }
    const result = this.deps.actor.dispatch('update_project_motif', { motif_id: id, revision, from, updates: buildRebindUpdates(motifLayers(snapshot, id), id, manifest) })
    if (!result.ok) {
      if (before) backups.restore(id, before.revision)
      throw new Error(JSON.stringify(result.error))
    }
    return { motif_id: id, revision, from }
  }

  private warn(message: string, details: Record<string, unknown>): void {
    try { this.deps.warn?.(message, details) } catch { /* best effort */ }
  }
}

/** The layers of `p` on Motif `id`. */
function motifLayers(p: Project, id: string): MotifLayerRef[] {
  const out: MotifLayerRef[] = []
  for (const { layer } of eachLayer(p))
    if (layer.params.kind === 'Motif' && layer.params.motif_id === id) out.push({ layerId: layer.id, motifId: id, props: layer.params.props })
  return out
}
