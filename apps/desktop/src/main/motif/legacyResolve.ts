// What a v5 project's Motif ids rendered, for its upgrade to v6
// (`state/migrate.ts`): a built-in, else the installed Motif's current
// version, else its draft (`drafts/<id>`, which is also a linked directory's
// mirror). This is the app-wide resolution v5 used; only the upgrade may
// resolve through it, and it is the one reader of an older release's
// `drafts/` and `.workspaces/`, which stay in the library folder untouched.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN_IDS, BUILTIN_MANIFESTS, parseManifestIsland, type Manifest } from '../../shared/motifs/catalog'
import type { AppNotice } from '../../shared/ipc'
import { isProposalPreviewId } from '../../shared/motifs/projectMotifs'
import type { LegacyMotif, MigrationContext, MotifCopy } from '../state/migrate'
import type { MotifCopyOutcome } from '../state/workspace-orchestrator'
import type { BuiltinMotif } from './authoring'
import { packageContentHash } from './contentHash'
import { hasMotifFile, motifFileSegments, readMotifFile, type MotifFile } from './packageFiles'
import { PackageSource } from './packageSource'
import { libraryPackage, ProjectMotifStore } from './projectStore'
import { DRAFTS_DIR, type UserMotifStore } from './store'

/** A resolved package: its table entry's facts and the files to copy. */
export interface LegacyPackage extends LegacyMotif { files: readonly MotifFile[] }

/** The folder of draft `id` when it holds a page; null otherwise. */
function draftDir(store: UserMotifStore, id: string): string | null {
  if (motifFileSegments(id)?.length !== 1 || id.startsWith('.')) return null
  return hasMotifFile(store.root(), `${DRAFTS_DIR}/${id}/index.html`) ? path.join(store.root(), DRAFTS_DIR, id) : null
}

/** The drafts an older release left in the library folder, which nothing
 *  lists any more: each `drafts/<id>/` holding a page. */
export function legacyDraftIds(store: UserMotifStore): string[] {
  let names: string[]
  try { names = readdirSync(path.join(store.root(), DRAFTS_DIR)) } catch { return [] }
  return names.filter(name => draftDir(store, name) !== null).sort()
}

/** The one startup notice for a library that still holds an older release's
 *  drafts: how many, and the folder they are in. Null when it holds none. */
export function legacyDraftsNotice(store: UserMotifStore): AppNotice | null {
  const count = legacyDraftIds(store).length
  return count ? { level: 'info', code: 'motif_drafts_left', args: { count, folder: path.join(store.root(), DRAFTS_DIR) } } : null
}

/** The package v5 rendered for Motif `id`; null when nothing did. A built-in
 *  id resolves to the built-in or to nothing, as in v5. */
export function resolveLegacyMotif(store: UserMotifStore, builtins: readonly BuiltinMotif[], id: string): LegacyPackage | null {
  const library = libraryPackage(store, builtins, id)
  if (library) {
    const from = { uid: library.uid, version: library.version, revision: library.revision }
    return { uid: library.uid, revision: library.revision, from, files: library.files }
  }
  if (BUILTIN_IDS.includes(id) || isProposalPreviewId(id)) return null
  const dir = draftDir(store, id)
  if (!dir || linkedDiagnostic(store, id)) return null
  try { parseManifestIsland(readFileSync(path.join(dir, 'index.html'), 'utf8')) } catch { return null }
  const draft = new PackageSource(store.revisions, files => packageContentHash(files)).snapshot(dir)
  return { uid: store.lineage.of(`${DRAFTS_DIR}/${id}`), revision: draft.revision, from: null, files: draft.files }
}

/** Why draft `id`'s linked directory was invalid, as its working state
 *  recorded it; such a draft rendered nothing. */
function linkedDiagnostic(store: UserMotifStore, id: string): string | null {
  try {
    const state = JSON.parse(readFileSync(path.join(store.root(), '.workspaces', `${id}.json`), 'utf8')) as { diagnostic?: unknown }
    return typeof state.diagnostic === 'string' && state.diagnostic ? state.diagnostic : null
  } catch { return null }
}

/** The manifest v5 sized Motif `id` with: a built-in's, else the installed
 *  Motif's, else its draft's. */
function legacyManifest(store: UserMotifStore, id: string): Manifest | null {
  const builtin = BUILTIN_MANIFESTS.get(id)
  if (builtin) return builtin
  const installed = store.installedManifest(id)
  if (installed) return installed
  const dir = draftDir(store, id)
  const page = dir && readMotifFile(dir, 'index.html')
  try { return page ? parseManifestIsland(page.toString('utf8')) : null } catch { return null }
}

/** Copies each planned package into the project's `Motifs/`. A folder that
 *  makes a package already is kept (an upgrade run again changes nothing);
 *  a package that is gone or cannot be copied leaves its entry without a
 *  revision, and says why. */
export function placeMigratedMotifs(project: ProjectMotifStore, copies: readonly MotifCopy[],
  resolve: (id: string) => LegacyPackage | null): MotifCopyOutcome[] {
  return copies.map(({ id, source }) => {
    try {
      const pkg = resolve(source ?? id)
      if (!pkg) return { id, revision: null, diagnostic: 'The Motif is no longer in the library' }
      return { id, revision: project.materialize(id, pkg.files, 'placed') }
    } catch (error) {
      return { id, revision: null, diagnostic: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** The upgrade's facts and its Motif copies for the open path
 *  (`OrchestratorDeps.migration` and `placeMigratedMotifs`). A Motif's size
 *  comes from the project's own folder first, then from the library as v5
 *  found it. `onProject` sees each project store made, so its revisions can
 *  be heard (`MotifResolver.hear`). */
export function legacyMigration(store: UserMotifStore, builtins: readonly BuiltinMotif[],
  onProject?: (project: ProjectMotifStore) => void) {
  const projectStore = (dir: string) => {
    const project = new ProjectMotifStore(dir, { revisions: store.revisions })
    onProject?.(project)
    return project
  }
  const resolve = (id: string) => resolveLegacyMotif(store, builtins, id)
  return {
    migration: (dir: string): MigrationContext => ({
      motifSize: (id, version) => {
        let manifest: Manifest | null = null
        try { manifest = new ProjectMotifStore(dir, { revisions: store.revisions }).describe(id)?.manifest ?? null } catch { /* not a package */ }
        if (manifest?.version !== version) manifest = legacyManifest(store, id)
        return manifest?.version === version ? manifest.size : null
      },
      legacyMotif: id => {
        const found = resolve(id)
        return found && { uid: found.uid, revision: found.revision, from: found.from }
      },
    }),
    placeMigratedMotifs: (dir: string, copies: readonly MotifCopy[]) => placeMigratedMotifs(projectStore(dir), copies, resolve),
  }
}
