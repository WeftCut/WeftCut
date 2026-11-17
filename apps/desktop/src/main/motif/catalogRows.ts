// The Motif catalog as `list_motifs` answers it: the open project's Motifs
// and the library's, one row each. A project row's state against the library
// is derived on every read, never stored (spec § Project Motifs).
import path from 'node:path'
import { builtinLineage, PARAMS_PAGE_FILE } from '../../shared/motifs/catalog'
import { isProjectMotifKey, type ProjectMotifEntry, type ProjectMotifs } from '../../shared/motifs/projectMotifs'
import { listMotifsInner, motifRevision, motifToPayload, type BuiltinMotif } from './authoring'
import { normalize } from './motifPackage'
import { type LibraryPackage, type ProjectMotifStore } from './projectStore'
import type { UserMotifStore } from './store'

export type MotifGroup = 'project' | 'library'

/** A project Motif against the library Motif of its lineage: the same
 *  content (`in_sync`), changed in the project since it was copied
 *  (`modified`), an unchanged copy the library has moved past
 *  (`update_available`), or of a lineage the library does not hold
 *  (`project_only`). */
export type ProjectMotifState = 'in_sync' | 'modified' | 'update_available' | 'project_only'

/** The library Motif of a lineage as a state needs it: no files. */
export type LibraryHead = Pick<LibraryPackage, 'id' | 'uid' | 'version' | 'revision'>

/** The library's current Motif of lineage `uid`: the built-in of it, else
 *  the installed Motif recorded with it; null when the library holds none. */
export function libraryHeadOfLineage(store: UserMotifStore, builtins: readonly BuiltinMotif[], uid: string): LibraryHead | null {
  const builtin = builtins.find(b => builtinLineage(b.id) === uid)
  if (builtin) return { id: builtin.id, uid, version: builtin.manifest.version, revision: motifRevision(store, [...builtins], builtin.id) }
  const installed = new Set(store.publishedIds())
  const id = store.lineage.holders(uid).find(key => installed.has(key))
  const head = id === undefined ? null : store.installedHead(id)
  return head && { id: id!, uid, ...head }
}

/** Whether `files`, stamped with the library Motif's id and version, are its
 *  package: a copy keeps its content when its folder takes another id, and a
 *  publication stamps the version it adds. Keyed by both revisions, which
 *  fix the answer. */
const sameContentSeen = new Map<string, boolean>()
const SAME_CONTENT_KEPT = 256
function sameContent(projectRevision: string, files: () => readonly { path: string; bytes: Buffer }[], library: LibraryHead): boolean {
  const key = `${projectRevision}\0${library.id}\0${library.version}\0${library.revision}`
  let same = sameContentSeen.get(key)
  if (same === undefined) {
    try { same = normalize(files(), library.id, library.version).revision === library.revision } catch { same = false }
    if (sameContentSeen.size >= SAME_CONTENT_KEPT) sameContentSeen.delete(sameContentSeen.keys().next().value!)
    sameContentSeen.set(key, same)
  }
  return same
}

/** The state of a project Motif whose folder holds `revision` (its recorded
 *  one when the folder holds none). `files` reads the folder, only when the
 *  revisions alone do not decide. */
export function projectMotifState(entry: ProjectMotifEntry, revision: string | null, library: LibraryHead | null,
  files: () => readonly { path: string; bytes: Buffer }[]): ProjectMotifState {
  if (!library) return 'project_only'
  if (revision === library.revision) return 'in_sync'
  if (revision && sameContent(revision, files, library)) return 'in_sync'
  if (entry.from && entry.from.uid === library.uid && revision === entry.from.revision) return 'update_available'
  return 'modified'
}

/** The open project's Motif rows, by id. A row whose folder makes
 *  a package carries its manifest and page; one that does not carries its
 *  `status`, and an `invalid` one the package error as `diagnostic`. A
 *  `missing` row needs no text: the status and `path` say it, and each
 *  reader words it in its own language. */
export function projectRows(project: ProjectMotifStore, table: Readonly<ProjectMotifs>, store: UserMotifStore,
  builtins: readonly BuiltinMotif[]): Record<string, unknown>[] {
  return Object.entries(table).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, entry]) => {
    const folder = project.status(id)
    const library = libraryHeadOfLineage(store, builtins, entry.uid)
    const revision = folder.revision ?? entry.revision
    const state = projectMotifState(entry, revision, library, () => project.packageFiles(id))
    const base = { group: 'project', id, uid: entry.uid, status: folder.status, state, from: entry.from, path: project.folder(id) }
    if (folder.status !== 'ok') return { ...base, revision: null, ...(folder.diagnostic ? { diagnostic: folder.diagnostic } : {}) }
    try {
      const pkg = project.describe(id)!
      return { ...motifToPayload(pkg.manifest, pkg.html, folder.status, pkg.revision, pkg.paths.includes(PARAMS_PAGE_FILE)), ...base, revision: pkg.revision }
    } catch (error) {
      return { ...base, status: 'invalid', revision: null, diagnostic: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Why library Motif `id` cannot be previewed or placed as it is named;
 *  null when it can. Its host, `<id>--library`, is one host label, which URL
 *  parsing lowercases. */
export function libraryIdDiagnostic(id: string): string | null {
  return isProjectMotifKey(id) ? null
    : `The folder name must be lowercase letters, digits and single dashes: rename the library folder '${id}' to preview or place it`
}

/** The library's rows: built-ins, then installed Motifs, each with the id
 *  the open project holds it under (`in_project`), null when it does not.
 *  One whose id cannot name its host is `invalid`, with no manifest, so it
 *  is offered for nothing until renamed. */
export function libraryRows(store: UserMotifStore, builtins: BuiltinMotif[], table: Readonly<ProjectMotifs> | null): Record<string, unknown>[] {
  const byLineage = new Map(Object.entries(table ?? {}).map(([id, entry]) => [entry.uid, id]))
  return listMotifsInner(store, builtins).map(row => {
    const id = row.id as string
    const uid = builtinLineage(id) ?? store.lineage.peek(id)
    const in_project = (uid && byLineage.get(uid)) ?? null
    const diagnostic = libraryIdDiagnostic(id)
    if (diagnostic) return { group: 'library', id, status: 'invalid', diagnostic, revision: row.content_hash, in_project }
    return { ...row, group: 'library', revision: row.content_hash, in_project }
  })
}

/** The project folder a project store serves. */
export function projectDirOf(project: ProjectMotifStore): string {
  return path.dirname(project.root())
}
