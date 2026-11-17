// apps/desktop/src/main/motif/motifTools.ts
//
// Host-level Motif tool dispatcher. Both surfaces call this: the renderer IPC
// path (ts-actor-host.handleInvoke `case 'motif'`) and the MCP path (server.ts
// `route === 'motif'`). Returns a RAW value (array | object | null), or a
// promise of one for the library delete, which waits on the system trash; the
// MCP caller wraps it via shapeMotifMcpResult, the renderer returns it as-is.
//
// A tool names a project Motif by default and a library Motif with
// `group: 'library'`. Every change to the project's Motif table is a recorded
// commit attributed to `by`; the library is changed only by the user, or by
// their approval of an agent's proposal (`publications.ts`).
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { builtinLineage, parseManifestIsland, type Manifest } from '../../shared/motifs/catalog'
import type { ActorHandle } from '../state/actor'
import type { Actor } from '../state/history'
import { encodeMotifZip } from './archive'
import type { BuiltinMotif } from './authoring'
import { libraryRows, projectDirOf, projectRows, type MotifGroup } from './catalogRows'
import { fileChanges } from './fileChanges'
import { readMotifDirectory, type MotifFile } from './packageFiles'
import { libraryPackage, type CreateSource, type ProjectMotifStore } from './projectStore'
import { LibraryPublications, type Fork, type PublicationSource } from './publications'
import { MotifRefusal, revisionConflict } from './refusal'
import type { UserMotifStore } from './store'

export interface MotifToolDeps {
  store: UserMotifStore
  builtins: BuiltinMotif[]
  /** The open project's Motifs; null with none open. */
  project: () => ProjectMotifStore | null
  /** The open project's recorded state: its Motif table, and the commits
   *  that change it. */
  actor: Pick<ActorHandle, 'snapshot' | 'dispatch'>
  /** Emit `motifs:changed` to the renderer (picker re-pull + host buster). */
  emitChanged: () => void
  /** Tell connected agents the catalog changed (MCP resources list_changed). */
  notifyAgents?: () => void
}

/** The user, as their own approval's commit records them. */
const USER: Actor = { kind: 'User' }
/** read_motif's text bound; a larger text file is refused, not truncated. */
const TEXT_READ_BYTES = 256 * 1024

/** The subject Motif of a call: one input name on every tool (`motif_id`). */
function subject(a: Record<string, unknown>): string {
  if (typeof a.motif_id !== 'string' || !a.motif_id)
    throw new Error('motif_id is required: the id list_motifs reports')
  return a.motif_id
}

function groupOf(a: Record<string, unknown>, fallback: MotifGroup | null = 'project'): MotifGroup | null {
  if (a.group === undefined) return fallback
  if (a.group !== 'project' && a.group !== 'library') throw new Error("group must be 'project' or 'library'")
  return a.group
}

const inventory = (files: readonly MotifFile[]) =>
  files.map(f => ({ path: f.path, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') }))

/** A committed dispatch, or its refusal thrown as the command error it is. */
function commit(deps: MotifToolDeps, op: string, args: Record<string, unknown>, by: Actor | undefined): void {
  const result = deps.actor.dispatch(op, args, by)
  if (!result.ok) throw new Error(JSON.stringify(result.error))
}

export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps, by?: Actor): unknown {
  const a = rawArgs
  const publications = new LibraryPublications(deps.store)
  const table = () => deps.actor.snapshot().motifs
  const changed = () => { deps.emitChanged(); deps.notifyAgents?.() }

  const openProject = (): ProjectMotifStore => {
    const project = deps.project()
    if (!project) throw new MotifRefusal('No project is open: open one first, or name a library Motif with group: "library"', { error: 'NoProjectOpen' }, 'invalid_request')
    return project
  }
  /** Project Motif `id`'s folder store and its table entry. */
  const projectMotif = (id: string) => {
    const project = openProject()
    const entry = Object.hasOwn(table(), id) ? table()[id]! : undefined
    if (!entry) throw new MotifRefusal(`No Motif '${id}' in this project — list_motifs lists its Motifs; group: "library" reads the library's`, { error: 'MotifNotFound', id })
    return { project, entry }
  }
  /** Project Motif `id` as its folder holds it now; refuses one that cannot render. */
  const projectPackage = (id: string) => {
    const { project, entry } = projectMotif(id)
    const state = project.status(id)
    const snapshot = state.status === 'ok' ? project.snapshot(id) : null
    if (!snapshot)
      throw new MotifRefusal(`Motif '${id}' is ${state.status}: ${state.diagnostic ?? `Motifs/${id}/ is gone`}`, { error: 'MotifUnavailable', id, status: state.status })
    return { project, entry, snapshot }
  }
  const libraryMotif = (id: string) => {
    const pkg = libraryPackage(deps.store, deps.builtins, id)
    if (!pkg) throw new MotifRefusal(`No library Motif '${id}' — list_motifs { group: "library" } lists them`, { error: 'MotifNotFound', id })
    const builtin = deps.builtins.find(b => b.id === id)
    const manifest: Manifest = builtin?.manifest ?? parseManifestIsland(pkg.files.find(f => f.path === 'index.html')!.bytes.toString('utf8'))
    return { pkg, manifest }
  }
  /** The project Motif a publication is made from. */
  const publicationSource = (id: string): PublicationSource => {
    const { project, entry, snapshot } = projectPackage(id)
    if (a.expected_revision !== undefined && a.expected_revision !== snapshot.revision)
      throw revisionConflict(snapshot.revision, 'preview the current revision, then send it')
    return { project: projectDirOf(project), motif_id: id, uid: entry.uid, revision: snapshot.revision, files: snapshot.files }
  }
  /** A save-as-new while its source project is open: the entry follows the
   *  new library Motif, in one commit the user makes. */
  const follow = (fork: Fork | undefined) => {
    const project = deps.project()
    if (!fork || !project || path.resolve(projectDirOf(project)) !== path.resolve(fork.project)) return
    const entry = Object.hasOwn(table(), fork.motif_id) ? table()[fork.motif_id] : undefined
    if (!entry?.revision) return
    commit(deps, 'set_project_motif', { motif_id: fork.motif_id, uid: fork.uid, revision: entry.revision, from: fork.from }, USER)
  }

  switch (name) {
    case 'list_motifs': {
      const group = groupOf(a, null)
      const project = deps.project()
      const motifs = project ? table() : null
      const proposed = project && group !== 'library' ? publications.latestOf(projectDirOf(project)) : null
      // Library rows first: the renderer's catalog keys rows by id, and the
      // project's Motif is the one its layers render.
      return [
        ...(group !== 'project' ? libraryRows(deps.store, deps.builtins, motifs) : []),
        ...(proposed ? projectRows(project!, motifs!, deps.store, deps.builtins).map(row => {
          const publication = proposed.get(row.id as string)
          return publication ? { ...row, publication } : row
        }) : []),
      ]
    }
    case 'read_motif': {
      if ('encoding' in a)
        throw new Error('read_motif takes no encoding: a path answers its UTF-8 text, or {size, sha256} for a binary file')
      const id = subject(a)
      let read: { manifest: Manifest | null; revision: string | null; files: () => MotifFile[]; file: (rel: string) => Buffer | null; extra: Record<string, unknown> }
      if (groupOf(a) === 'library') {
        const { pkg, manifest } = libraryMotif(id)
        read = { manifest, revision: pkg.revision, files: () => [...pkg.files], file: rel => pkg.files.find(f => f.path === rel)?.bytes ?? null,
          extra: { group: 'library', status: builtinLineage(id) ? 'builtin' : 'installed', version: pkg.version } }
      } else {
        const { project, entry } = projectMotif(id)
        const state = project.status(id)
        const extra = { group: 'project', status: state.status, from: entry.from, path: project.folder(id), ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}) }
        if (state.status === 'missing') throw new MotifRefusal(`Motif '${id}' has no folder in this project (Motifs/${id}/)`, { error: 'MotifUnavailable', id, status: 'missing' })
        // An invalid folder is read too: its files are how it gets fixed.
        const described = state.status === 'ok' ? project.describe(id) : null
        read = { manifest: described?.manifest ?? null, revision: state.revision, files: () => readMotifDirectory(project.folder(id)),
          file: rel => project.readFile(id, rel), extra }
      }
      if (a.path === undefined)
        return { motif_id: id, manifest: read.manifest, revision: read.revision, ...read.extra, files: inventory(read.files()) }
      if (typeof a.path !== 'string') throw new Error('path must be a path relative to the Motif root')
      const bytes = read.file(a.path)
      if (!bytes)
        throw new Error('Unknown Motif file: ' + a.path)
      if (!isUtf8(bytes))
        return { motif_id: id, revision: read.revision, path: a.path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      if (bytes.length > TEXT_READ_BYTES)
        throw new Error(`${a.path} is ${Math.ceil(bytes.length / 1024)} KiB of text, over read_motif's 256 KiB; change it with update_motif_files edits, or read it in the Motif's folder`)
      return { motif_id: id, manifest: read.manifest, revision: read.revision, path: a.path, text: bytes.toString('utf8') }
    }
    case 'create_motif': {
      const project = openProject()
      const motifs = table()
      const source = createSource(a.source, src => {
        const group = groupOf(src)
        return group === 'library' ? [...libraryMotif(subject(src)).pkg.files] : projectPackage(subject(src)).snapshot.files
      })
      const made = project.create(source, motifs)
      if (Object.hasOwn(motifs, made.id)) return { motif_id: made.id, revision: made.entry.revision, path: made.path }
      try { commit(deps, 'set_project_motif', { motif_id: made.id, uid: made.entry.uid, revision: made.entry.revision, from: null }, by) }
      catch (error) {
        // A folder this call wrote and could not record would be left
        // untracked; one it adopted was the caller's before.
        if (made.copied) rmSync(made.path, { recursive: true, force: true })
        throw error
      }
      changed()
      return { motif_id: made.id, revision: made.entry.revision, path: made.path }
    }
    case 'update_motif_files': {
      const id = subject(a)
      const { project } = projectMotif(id)
      if (typeof a.expected_revision !== 'string' || !a.expected_revision)
        throw revisionConflict(project.status(id).revision ?? 'none', 'send the revision read_motif answers as expected_revision')
      const revision = project.applyChanges(id, a.expected_revision, files => fileChanges(files, a.files))
      commit(deps, 'set_project_motif', { motif_id: id, revision }, by)
      changed()
      return { motif_id: id, revision }
    }
    case 'delete_motif': {
      const id = subject(a)
      projectMotif(id)
      commit(deps, 'remove_project_motif', { motif_id: id }, by)
      changed()
      return { motif_id: id }
    }
    case 'export_motif': {
      const id = subject(a)
      let files: readonly MotifFile[], revision: string, lineage: string
      if (groupOf(a) === 'library') {
        const { pkg } = libraryMotif(id)
        files = pkg.files; revision = pkg.revision; lineage = pkg.uid
      } else {
        const { entry, snapshot } = projectPackage(id)
        files = snapshot.files; revision = snapshot.revision; lineage = entry.uid
      }
      if (a.expected_revision !== undefined && a.expected_revision !== revision)
        throw revisionConflict(revision, 'export it without expected_revision, or read it again')
      if (typeof a.path !== 'string' || !path.isAbsolute(a.path))
        throw new Error('export_motif needs path: an absolute app-machine .zip path in an existing folder')
      if (path.extname(a.path).toLowerCase() !== '.zip')
        throw new Error(`export_motif writes a ZIP: path must end in .zip, got ${a.path}`)
      const ordered = [...files.filter(f => f.path === 'index.html'), ...files.filter(f => f.path !== 'index.html')]
      // `wx`: never over an existing file (the same policy as
      // start_export's on_conflict: fail), and a missing parent folder
      // is ENOENT, not a folder made on the caller's behalf.
      writeFileSync(a.path, Buffer.from(encodeMotifZip(id, ordered, lineage)), { flag: 'wx' })
      return { motif_id: id, revision, path: a.path }
    }
    case 'install_motif': {
      // An agent proposes; the user approves in the Motif panel (ADR 0046).
      const proposed = publications.propose(publicationSource(subject(a)), a.target_id as string | undefined, a.expected_version as number | undefined)
      if (proposed.state === 'awaiting_approval') changed()
      return proposed
    }
    // ── Renderer-only channels (router MOTIF_CHANNELS, never MOTIF_TOOLS) ──
    case 'publish_motif': {
      // The user's own "Save to library": published directly. `dry_run`
      // answers what it would replace, for the panel's confirm card.
      if (a.dry_run === true) return publications.plan(publicationSource(subject(a)), a.target_id as string | undefined)
      const { fork, ...published } = publications.publish(publicationSource(subject(a)),
        { targetId: a.target_id as string | undefined, expectedVersion: a.expected_version as number | undefined, asNew: a.as_new === true })
      follow(fork)
      changed()
      return published
    }
    case 'list_motif_proposals': return publications.proposals()
    case 'approve_motif_proposal': {
      const { fork, ...approved } = publications.approve(a.proposal_id as string, a.as_new === true)
      follow(fork)
      changed()
      return approved
    }
    case 'reject_motif_proposal': {
      const rejected = publications.reject(a.proposal_id as string, a.note as string | undefined)
      changed()
      return rejected
    }
    case 'list_motif_versions': return publications.listVersions(subject(a))
    case 'restore_motif_version': {
      // The user restores an older library version as the newest one.
      const restored = publications.restore(subject(a), a.version as number)
      changed()
      return restored
    }
    case 'delete_library_motif': {
      const id = subject(a)
      return publications.delete(id).then(() => {
        changed()
        return { motif_id: id }
      })
    }
    default:
      throw new Error(`runMotifTool: unhandled tool ${name}`)
  }
}

const SOURCE_KEYS: Record<string, readonly string[]> = {
  empty: ['kind', 'name'], copy: ['kind', 'motif_id', 'group'], zip: ['kind', 'path'], directory: ['kind', 'path'],
}

/** `create_motif`'s source, checked; `copied` reads the files a copy names. */
function createSource(raw: unknown, copied: (source: Record<string, unknown>) => readonly MotifFile[]): CreateSource {
  const source = raw as Record<string, unknown> | null
  const kind = source && typeof source === 'object' ? source.kind : undefined
  if (typeof kind !== 'string' || !Object.hasOwn(SOURCE_KEYS, kind))
    throw new Error("source must be one of {kind:'empty', name}, {kind:'copy', motif_id, group?}, {kind:'zip', path}, {kind:'directory', path}")
  if (kind === 'zip' && 'file_id' in source!)
    throw new Error("A ZIP source is {kind:'zip', path} with an absolute app-machine path; file_id uploads are gone")
  const extra = Object.keys(source!).filter(k => !SOURCE_KEYS[kind]!.includes(k))
  if (extra.length) throw new Error(`A ${kind} source takes ${SOURCE_KEYS[kind]!.slice(1).join(', ')} only, not ${extra.join(', ')}`)
  switch (kind) {
    case 'empty':
      if (source!.name !== undefined && typeof source!.name !== 'string') throw new Error('name must be a string')
      return { kind, ...(typeof source!.name === 'string' ? { name: source!.name } : {}) }
    case 'copy': return { kind, files: copied(source!) }
    default:
      if (typeof source!.path !== 'string' || !path.isAbsolute(source!.path)) throw new Error('Source path must be absolute')
      return { kind: kind as 'zip' | 'directory', path: source!.path }
  }
}
