// apps/desktop/src/main/state/persistence.ts
//
// The PURE on-disk persistence surface: project serialization + the
// schema-version gate. No node:fs here — the file read/write/delete shell and
// the workspace/cache/LogBus/recents/jobs orchestration live in
// workspace-orchestrator.ts (injected fs). The disk form of a project is
// projectFile.ts's.
import { WorkspaceFailure } from '../../shared/workspaceErrors'
import { SCHEMA_VERSION, type Project } from './model'
import { migrationEvaluation } from './migrationEvaluation'
import { upgradeWire, type FilePlan, type MigrationContext, type MotifCopy, type PositionBakeReport } from './migrate'
import { parseProject, type GridRepair } from './serialize'
import { mediaAtFolder, toProjectFile } from './projectFile'
import type { PathPlatform } from './projectPathNative'

/** Where the pre-upgrade bytes are kept when the migration chain moves a project
 *  forward: beside the project file, named for the version it came from.
 *  `.json`, not `.wcpr`: a backup must never be what an open picks.
 *
 *  Deliberately NOT in `Backups/`. That directory is the autosave's rolling
 *  snapshot set — 20 newest, gc'd by filename — and its snapshots are taken
 *  AFTER a write, so by the time one exists the upgraded bytes are already what
 *  got copied. The one file that can restore a project a bad migration step
 *  mangled must not be subject to a retention policy at all. */
export function preUpgradeBackupFile(fromVersion: number): string {
  return `project.pre-v${fromVersion}.json`
}

/** 2-space-indented JSON, NO trailing newline. Round-trip fidelity, not
 *  byte-identical key order, is the contract. */
export function serializeProjectToJson(p: Project): string {
  return JSON.stringify(toProjectFile(p), null, 2)
}

/** The schema-version gate: refuse what this build cannot read, and report the
 *  version of what it can. Two refusals only —
 *
 *  - a missing / non-numeric version: not a project file this build recognises;
 *  - a version AHEAD of the build: the file may carry fields and semantics that
 *    do not exist here, and writing it back would silently drop them.
 *
 *  An OLDER version is deliberately NOT a refusal — it is the migration chain's
 *  input (migrate.ts).
 *
 *  Both refusals are WorkspaceFailures rather than prose: what renders them is
 *  the startup screen, which has to say this in the user's language.
 *  `ProjectSchemaTooNew` carries both versions so that copy can state
 *  the mismatch instead of guessing that an app update fixes it — the file it
 *  fires on most often is one left behind by a different build of this repo.
 */
export function schemaGate(project: unknown): number {
  const v = (project as { schema_version?: unknown })?.schema_version
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new WorkspaceFailure({ error: 'ProjectSchemaUnreadable' })
  }
  if (v > SCHEMA_VERSION) {
    throw new WorkspaceFailure({ error: 'ProjectSchemaTooNew', found: v, supported: SCHEMA_VERSION })
  }
  return v
}

/** A parsed project plus what the load had to do to get there. */
export interface ParsedProjectFile {
  project: Project
  /** The on-disk version, when the chain upgraded it; null when the file was
   *  already current. The caller preserves the pre-upgrade bytes off the back of
   *  this — see `openProject`. */
  upgradedFrom: number | null
  bakedPositions: PositionBakeReport[]
  /** Motif packages the upgrade recorded in `Motifs/` that the open still
   *  has to copy there (`openProject`). */
  motifCopies: MotifCopy[]
  /** Files the upgrade moved a record to, for the open to move or copy
   *  inside the folder. */
  filePlans: FilePlan[]
}

/** Load the project file's text from the folder `dir`: parse → gate → upgrade →
 *  cast → each media item at its place in `dir` under `platform`'s path rules.
 *  JSON.parse throws on malformed text; the gate runs BEFORE the structural cast
 *  so the rich version-specific guidance wins over parseProject's generic check,
 *  and the chain runs before it so the cast only ever sees the current shape.
 *  No derivative is ready afterwards: the open finds them in the cache again. */
export function loadProjectFromJson(text: string, opts: {
  dir: string; platform?: PathPlatform; onGridRepair?: (repairs: readonly GridRepair[]) => void; migration?: MigrationContext
}): ParsedProjectFile {
  const json: unknown = JSON.parse(text)
  const version = schemaGate(json)
  const bakedPositions: PositionBakeReport[] = []
  const motifCopies: MotifCopy[] = []
  const filePlans: FilePlan[] = []
  const { wire } = upgradeWire(json as Record<string, unknown>, version, SCHEMA_VERSION, undefined, {
    ...migrationEvaluation, ...opts.migration,
    onBake: report => bakedPositions.push(report), onMotifCopy: copy => motifCopies.push(copy), onFile: plan => filePlans.push(plan),
  })
  // Omitting the hook (tests) leaves `onGridRepair: undefined`, which parseProject
  // falls back to its console default for — the reporting default is unchanged.
  const parsed = parseProject(wire, { onGridRepair: opts.onGridRepair })
  const project = { ...parsed, media_pool: mediaAtFolder(parsed.media_pool, opts.dir, opts.platform ?? process.platform) }
  return { project, upgradedFrom: version === SCHEMA_VERSION ? null : version, bakedPositions, motifCopies, filePlans }
}
