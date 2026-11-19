// Keeps the open project's Motif folders and its recorded Motif table in
// step (spec § Project Motifs): a library Motif is copied in before the
// commit that records it, a folder edited on disk becomes a recorded commit,
// every revision the table records is backed up, and a state taken back from
// history puts each folder back as its table says. Owns none of the three:
// the folders are `ProjectMotifStore`'s, the backups `MotifBackups`', the
// table the actor's.
import { rmSync } from 'node:fs'
import path from 'node:path'
import { motifEntry, type ProjectMotifs, type ProjectMotifSource } from '../../shared/motifs/projectMotifs'
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
    status: (id) => project()?.status(id).status ?? 'missing',
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
  /** Makes the `Motifs/` watcher tell `id`'s next change even when it ends
   *  in the state it last told (`ProjectMotifWatcher.forget`). */
  rewatch?: (id: string) => void
}

export class ProjectMotifRecords {
  /** `<project>\0<id>\0<revision>` known to be backed up, so a commit reads
   *  no folder whose recorded revision is already kept. */
  private readonly kept = new Set<string>()
  /** The table as the last recorded state left it: what a move through
   *  history moves away from. */
  private table: Readonly<ProjectMotifs>
  /** Motifs whose folder holds a package the table does not record yet, and
   *  that could not be recorded when it was seen (`retry`). */
  private readonly unrecorded = new Set<string>()

  constructor(private readonly deps: ProjectMotifRecordsDeps) {
    this.table = deps.actor.snapshot().motifs
    deps.actor.subscribe((e) => this.changed(e))
  }

  private backups(project: ProjectMotifStore): MotifBackups {
    return new MotifBackups(path.dirname(project.root()))
  }

  /** Every recorded state: its revisions are backed up; one taken back from
   *  history first has its folders put back to match it. */
  private changed(e: ChangeEvent): void {
    const before = this.table
    this.table = e.new_snapshot.motifs
    if (e.replaced) { this.kept.clear(); this.unrecorded.clear() }
    const project = this.deps.project()
    if (!project) return
    if (e.from_history) this.reconcile(project, before, e.new_snapshot.motifs)
    this.backUp(project, e.new_snapshot.motifs)
  }

  /** Backs up each revision `motifs` records whose folder holds it. */
  private backUp(project: ProjectMotifStore, motifs: Readonly<ProjectMotifs>): void {
    const backups = this.backups(project)
    for (const [id, entry] of Object.entries(motifs)) {
      if (!entry.revision) continue
      const key = `${project.root()}\0${id}\0${entry.revision}`
      if (this.kept.has(key)) continue
      try {
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
      } catch (error) {
        this.warn(`Revision ${entry.revision} of Motif '${id}' could not be backed up`, { motif_id: id, revision: entry.revision, error: String(error) })
      }
    }
  }

  /** Puts back, from its backup, each folder that holds the revision
   *  `before` recorded but not the one `after` does, after backing up what
   *  it holds. A gone folder is put back too. Any other folder holds an edit
   *  not recorded yet and is left as it is: one whose files make no package
   *  is unfinished, one that makes a package is recorded next. */
  private reconcile(project: ProjectMotifStore, before: Readonly<ProjectMotifs>, after: Readonly<ProjectMotifs>): void {
    const backups = this.backups(project)
    for (const [id, entry] of Object.entries(after)) {
      if (!entry.revision) continue
      try {
        const state = project.status(id)
        if (state.revision === entry.revision) continue
        if (state.status === 'invalid') {
          this.warn(`Motif '${id}' was not put back: its folder holds an unfinished edit`, { motif_id: id, diagnostic: state.diagnostic })
          continue
        }
        if (state.status === 'ok' && state.revision !== (motifEntry(before, id)?.revision ?? null)) {
          this.warn(`Motif '${id}' was not put back: its folder holds an edit not recorded yet, which is recorded now`, { motif_id: id, revision: state.revision })
          this.unrecorded.add(id)
          continue
        }
        if (!backups.has(id, entry.revision)) {
          this.warn(`Motif '${id}' was not put back: revision ${entry.revision} has no backup`, { motif_id: id, revision: entry.revision })
          continue
        }
        const current = state.status === 'ok' ? project.snapshot(id) : null
        if (current) backups.backup(id, current.files, current.revision)
        backups.restore(id, entry.revision)
        // Bytes put back were not made here: found, never an edit (Motif
        // trust), and what the next edit of the folder is judged from.
        project.found(id)
        // An edit landing again on the revision the watcher last told is
        // still an edit of the folder just put back.
        this.deps.rewatch?.(id)
      } catch (error) {
        this.warn(`Motif '${id}' could not be put back`, { motif_id: id, revision: entry.revision, error: String(error) })
      }
    }
    // Not from inside this broadcast: a commit now would reach the
    // remaining listeners before the state they are about to hear.
    if (this.unrecorded.size) queueMicrotask(() => this.retry())
  }

  /** A folder the watcher saw change, and observed (Motif trust is the
   *  store's: `ProjectMotifStore.observe`). One the table records and that
   *  makes a package becomes a `set_project_motif` commit (`FILE_EDITS`), its
   *  revision backed up first; any other change is status alone. One the
   *  project refuses to record now (an export or a project switch under way)
   *  waits for `retry`. */
  folderChanged(id: string, state: MotifState): void {
    const project = this.deps.project()
    const entry = motifEntry(this.deps.actor.snapshot().motifs, id)
    if (!project || !entry || state.status !== 'ok') return
    // Called from the watcher's timer, where a throw would escape the app.
    try { this.record(project, id, entry.revision) }
    catch (error) {
      this.notRecorded(id)
      this.warn(`The edit to Motif '${id}' could not be recorded`, { motif_id: id, error: String(error) })
    }
  }

  /** Records the folders whose edit could not be recorded when it was seen;
   *  the host calls it when the project takes writes again. */
  retry(): void {
    const project = this.deps.project()
    if (!project) return
    const ids = [...this.unrecorded]
    this.unrecorded.clear()
    for (const id of ids) this.folderChanged(id, project.status(id))
  }

  /** `id` waits for `retry`, and the watcher tells its next change. */
  private notRecorded(id: string): void {
    this.unrecorded.add(id)
    this.deps.rewatch?.(id)
  }

  /** Records what `id`'s folder holds when it is not `recorded`. */
  private record(project: ProjectMotifStore, id: string, recorded: string | null): void {
    let snapshot
    try { snapshot = project.snapshot(id) } catch { return }
    if (!snapshot || snapshot.revision === recorded) return
    this.backups(project).backup(id, snapshot.files, snapshot.revision)
    const result = this.deps.actor.dispatch('set_project_motif', { motif_id: id, revision: snapshot.revision }, FILE_EDITS)
    if (!result.ok) {
      this.notRecorded(id)
      this.warn(`The edit to Motif '${id}' could not be recorded`, { motif_id: id, error: result.error })
    }
  }

  /** A project open settled: a Motif changed while the project was closed
   *  is recorded like an edit, and the backups keep only what the table
   *  records (undo history starts empty at an open, and is never stored).
   *  Recording trusts nothing: its folders were found when the project
   *  became the open one (`MotifResolver.setProject`). */
  opened(): void {
    const project = this.deps.project()
    if (!project) return
    this.unrecorded.clear()
    const keep: [string, string][] = []
    const kept = () => { for (const [id, entry] of Object.entries(this.deps.actor.snapshot().motifs)) if (entry.revision) keep.push([id, entry.revision]) }
    kept()
    for (const [id, entry] of Object.entries(this.deps.actor.snapshot().motifs)) {
      try {
        if (project.status(id).status === 'ok') this.record(project, id, entry.revision)
      } catch (error) {
        this.warn(`Motif '${id}' could not be checked`, { motif_id: id, error: String(error) })
      }
    }
    kept()
    try {
      this.backups(project).gc(keep)
      this.kept.clear()
    } catch (error) {
      this.warn('The project\'s Motif backups could not be collected', { error: String(error) })
    }
    this.backUp(project, this.deps.actor.snapshot().motifs)
  }

  /** The user's update of the project copy of `id` to the library's current
   *  version of its lineage: the folder is replaced, then one commit records
   *  the new revision and source and rebinds every layer on it to the new
   *  props schema. The replaced revision stays in the backups; files that
   *  made no package are moved under `Backups/motifs/unfinished/`, answered
   *  as `unfinished`: that folder relative to the project's, `/`-separated,
   *  for the panel to show. A refused commit puts the folder back as it
   *  was. */
  updateFromLibrary(id: string): { motif_id: string; revision: string; from: ProjectMotifSource; unfinished?: string } {
    const project = this.deps.project()
    if (!project) throw new Error('No project is open')
    const snapshot = this.deps.actor.snapshot()
    const entry = motifEntry(snapshot.motifs, id)
    if (!entry) throw new Error(`No Motif '${id}' in this project`)
    const pkg = this.deps.libraryOfLineage(entry.uid)
    if (!pkg) throw new Error(`The library holds no version of Motif '${id}'`)
    const backups = this.backups(project)
    const state = project.status(id)
    const before = state.status === 'ok' ? project.snapshot(id) : null
    if (before) backups.backup(id, before.files, before.revision)
    // Files that make no package are an edit in progress: kept, never replaced.
    const unfinished = state.status === 'invalid' ? backups.setAside(id) : null
    const putBack = () => {
      if (before) {
        backups.restore(id, before.revision)
        project.found(id)
      } else if (unfinished) backups.putBack(id, unfinished)
      else rmSync(project.folder(id), { recursive: true, force: true })
    }
    let revision: string
    const from: ProjectMotifSource = { uid: pkg.uid, version: pkg.version, revision: pkg.revision }
    try {
      revision = project.replace(id, pkg.files, 'placed')
      const after = project.snapshot(id)!
      backups.backup(id, after.files, after.revision)
      const manifest = project.describe(id)!.manifest
      const result = this.deps.actor.dispatch('update_project_motif', { motif_id: id, revision, from, updates: buildRebindUpdates(motifLayers(snapshot, id), id, manifest) })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
    } catch (error) {
      try { putBack() }
      catch (undo) { this.warn(`Motif '${id}' could not be put back as it was`, { motif_id: id, error: String(undo), ...(unfinished ? { unfinished } : {}) }) }
      throw error
    }
    if (unfinished) this.warn(`The unfinished files of Motif '${id}' were moved to ${unfinished}`, { motif_id: id, unfinished })
    const shown = unfinished && path.relative(path.dirname(project.root()), unfinished).split(path.sep).join('/')
    return { motif_id: id, revision, from, ...(shown ? { unfinished: shown } : {}) }
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
