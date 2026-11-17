// What a v5 project's Motif ids rendered, for its upgrade to v6
// (`state/migrate.ts`): a built-in, else the installed Motif's current
// version, else its draft (`drafts/<id>`, which is also a linked directory's
// mirror). This is the app-wide resolution v5 used; only the upgrade may
// resolve through it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN_IDS, BUILTIN_MANIFESTS, type Manifest } from '../../shared/motifs/catalog'
import { isProposalPreviewId } from '../../shared/motifs/projectMotifs'
import type { LegacyMotif, MigrationContext, MotifCopy } from '../state/migrate'
import type { MotifCopyOutcome } from '../state/workspace-orchestrator'
import type { BuiltinMotif } from './authoring'
import type { MotifFile } from './packageFiles'
import { libraryPackage, ProjectMotifStore } from './projectStore'
import { DRAFTS_DIR, type UserMotifStore } from './store'

/** A resolved package: its table entry's facts and the files to copy. */
export interface LegacyPackage extends LegacyMotif { files: readonly MotifFile[] }

/** The package v5 rendered for Motif `id`; null when nothing did. A built-in
 *  id resolves to the built-in or to nothing, as in v5. */
export function resolveLegacyMotif(store: UserMotifStore, builtins: readonly BuiltinMotif[], id: string): LegacyPackage | null {
  const library = libraryPackage(store, builtins, id)
  if (library) {
    const from = { uid: library.uid, version: library.version, revision: library.revision }
    return { uid: library.uid, revision: library.revision, from, files: library.files }
  }
  if (BUILTIN_IDS.includes(id) || isProposalPreviewId(id) || !store.getDraft(id)) return null
  if (linkedDiagnostic(store, id)) return null
  const draft = store.packageSnapshot(id)
  return draft ? { uid: store.lineage.of(`${DRAFTS_DIR}/${id}`), revision: draft.revision, from: null, files: draft.files } : null
}

/** Why draft `id`'s linked directory was invalid, as its working state
 *  recorded it; such a draft rendered nothing. */
function linkedDiagnostic(store: UserMotifStore, id: string): string | null {
  try {
    const state = JSON.parse(readFileSync(path.join(store.root(), '.workspaces', `${id}.json`), 'utf8')) as { diagnostic?: unknown }
    return typeof state.diagnostic === 'string' && state.diagnostic ? state.diagnostic : null
  } catch { return null }
}

/** The manifest v5 sized Motif `id` with: a built-in's, else the store's. */
function legacyManifest(store: UserMotifStore, id: string): Manifest | null {
  return BUILTIN_MANIFESTS.get(id) ?? store.getMotif(id)?.manifest ?? null
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
 *  be heard. */
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
