// apps/desktop/src/main/state/ts-actor-host.ts
import { resolve as resolvePath } from 'node:path'
import { createActor, type ActorHandle, type ChangeEvent } from './actor'
import type { EntityRef } from './history'
import { uuidV7Gen } from './ids'
import { blankProject, eachLayer, rootComposition } from './model'
import { buildProjectSummary } from './summary'
import { routeChannel } from './router'
import { CommandFailure } from './errors'
import { createAutosave, type AutosaveController, type AutosaveFs, type AutosaveSaveState } from './autosave'
import { openProject, saveProjectAs, newWorkspace, makeEnqueueDerivatives, type WorkspaceNapi, type OrchestratorFs, type SchemaUpgradeReport } from './workspace-orchestrator'
import type { RelinkFs, RelinkReport } from './relink'
import { serializeProjectToJson } from './persistence'
import { currentEditTrace, editTraceId, EDIT_TRACE_ARG, runEditTrace } from '../../shared/editTrace'
import { describeGridRepairs, type GridRepair } from './serialize'
import { AgentActivityService } from '../agent/activity'
import { runTackIpc } from '../agent/tackIpc'
import { mcpActor } from './mcp-actor'
import { AGENT_VIEW_EVENT } from '../../shared/agent-activity'
import { PROJECT_OPENED_EVENT, type ProjectOpenedPayload } from '../../shared/project-events'
import { SAVE_STATUS_EVENT, type SaveStatus } from '../../shared/save-status'
import { PUBLICATION_BASE_ARG, type ProjectVersion, type ProjectPublication, type PublishedResult } from '../../shared/projectPublication'
import { createPublicationAnswers } from './publicationAnswers'
import { REVIEW_CHANGED_EVENT, type ReviewActivityArgs, type ReviewActivityView, type ReviewActionArgs, type ReviewActionResult, type ReviewChangedPayload, type ReviewVersion, type ReviewView, type ReviewViewArgs, type ReviewViewUnchanged } from '../../shared/review'
import { runHybrid, type ComputeNapi, type HybridDeps } from './hybrids'
import { recoverInterruptedImports } from './importRecovery'
import { captureImportSession, createMediaImporter, type MediaImporter } from './mediaImport'
import { createPoolFiles, type PoolFiles, type PoolFilesFs } from './poolFiles'
import { MotifCatalog, type Manifest } from '../../shared/motifs/catalog'
import type { UserMotifStore } from '../motif/store'
import { runMotifTool, type MotifToolDeps } from '../motif/motifTools'
import type { BuiltinMotif, MotifLayerRef } from '../motif/authoring'
import type { MediaItem, MotifParams, MotifRebindEntry } from './model'
import type { AppSettingsStore } from '../app-settings'
import type { AppSettingsPatch } from '../../shared/app-settings'
import type { ViewStateStore } from '../view-state'
import { viewStateDefaults, type ViewState } from '../../shared/view-state'
import type { ExportSettingsStore } from '../export-settings'
import type { KeybindingsStore } from '../keybindings'
import type { RecentsStore } from '../recents'
import { tasteView } from '../taste/view'
import { AuditStore } from '../lint/audits'
import type { WorkspaceStore } from '../workspace'
import { ExportJobError } from '../exportJobs'

export interface TsActorHostDeps {
  exportJobs?: import("../exportJobs").ExportJobs
  /** Where style packages live. Absent (tests) → no taste view. */
  styleDirs?: import("../taste/view").StyleDirs
  /** Installed font families, lowercased; null until the system scan lands.
   *  A style's font slots resolve against it (spec H2-D4). */
  installedFonts?: () => ReadonlySet<string> | null
  /** The clip-compute job registry (ADR 0121). Absent → plain calls. */
  computeJobs?: import("../compute/jobs").ComputeJobs
  beginImport?: HybridDeps['beginImport']
  onWorkspaceChanging?: () => void
  onWorkspaceOpened?: () => void
  /** mainWindow.webContents.send('evt:'+event, payload) */
  send: (event: string, payload: unknown) => void
  /** notifications/resources/list_changed to every MCP session: the pool's
   *  files or their names changed, and with them the `media://{id}` list; or a
   *  Motif publication was proposed, approved or rejected (`motifs://current`). */
  mcpResourcesChanged?: () => void
  /** Stats of the pool's files (poolFiles.ts) — node:fs in production. */
  poolFs: PoolFilesFs
  /** Combined OrchestratorFs & AutosaveFs adapter — node:fs in production, in-memory in tests. */
  fs: OrchestratorFs & AutosaveFs
  /** Directory-scan/stat/rename shell for the open-time media relink self-heal
   *  (relink.ts). Optional → openProject skips healing when omitted (tests). */
  relinkFs?: RelinkFs
  /** node:path.join — injected for testability. */
  join: (...parts: string[]) => string
  /** Backend napi facade for workspace bookkeeping. */
  napi: WorkspaceNapi
  /** Rust compute facade for the native-compute → TS-write hybrids. */
  compute: ComputeNapi
  /** Queue the background workspace-copy job (Backend.enqueueWorkspaceCopy). */
  enqueueWorkspaceCopy: (mediaId: string, sourcePath: string) => Promise<string | null | void>
  /** node:fs readFile (utf8) — for the subtitle hybrid. */
  readFile: (p: string) => string
  /** node:fs stat folded to `PathFacts` — `import_media` refuses on it before any write. */
  statPath: HybridDeps['statPath']
  /** node:fs realpath — an import of a file the pool already holds answers that item. */
  realPath?: HybridDeps['realPath']
  /** node:fs stat identity — whether two import paths name one file. */
  fileKey?: HybridDeps['fileKey']
  /** Draws an imported SVG to a PNG (svgRaster.ts). Optional → SVGs are refused. */
  rasterizeSvg?: HybridDeps['rasterizeSvg']
  /** Current workspace directory (cached from backend). Null before first open/newWorkspace. */
  workspaceDir: () => string | null
  /** Emit a diagnostic LogBus pin-row via the Rust log surface.
   *  Optional → no-op when omitted (tests that do not care about logging).
   *  Must never throw — wrap call sites in try/catch; a failing emit must not abort the mutation. */
  emitLog?: (entry: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
    category: { kind: 'Project' | 'Mcp' | 'System' | string; name?: string }
    source: { kind: 'User' } | { kind: 'Agent'; client: string } | { kind: 'System' }
    message: string
    i18n_key?: string
    i18n_args?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => void
  /** list_motifs JSON from the backend — used to hydrate the actor's motif catalog
   *  after start() and after motif-store-mutating operations (install/delete/write/
   *  import/amend/create_edit). Optional → no-op when absent (tests). */
  listMotifs?: () => Promise<string>
  /** On-disk user Motif store (the TS authoring/read/install surface).
   *  Optional → guard in runMotif throws if absent. Tests that don't exercise
   *  motif tools omit this so they don't need a real temp-dir store. */
  motifStore?: UserMotifStore
  /** Built-in Motifs ({id, manifest, html}), loaded once at boot from the
   *  relocated served assets. Empty in tests that don't exercise built-ins.
   *  Optional — defaults to [] when absent. */
  motifBuiltins?: BuiltinMotif[]
  /** App-level prefs store (config-dir JSON, owned in TS main). Optional → the
   *  'appSettings' route throws if a renderer hits it without one wired. */
  appSettings?: AppSettingsStore
  /** Per-workspace view.json store (owned in TS main). Optional → the
   *  'viewState' route throws if a renderer hits it without one wired. */
  viewState?: ViewStateStore
  /** Per-workspace export.json store (owned in TS main, opaque value). Optional → the
   *  'exportSettings' route throws if a renderer hits it without one wired. */
  exportSettings?: ExportSettingsStore
  /** Per-user keybinding overrides (config-dir JSON, owned in TS main). Optional → the
   *  'keybindings' route throws if a renderer hits it without one wired. */
  keybindings?: KeybindingsStore
  /** Recent-projects list + startup prefs (config-dir JSON, owned in TS main). Optional → the
   *  'recents' route throws if a renderer hits it without one wired. */
  recents?: RecentsStore
  /** App-level Workspace document (Dock arrangement; config-dir JSON, owned in TS
   *  main). Optional → the 'workspace' route throws if a renderer hits it without
   *  one wired. */
  workspace?: WorkspaceStore
}

interface PersistenceHandlers {
  open: (dir: string) => Promise<void>
  saveAs: (dir: string) => Promise<void>
  newWorkspace: (args: { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }) => Promise<string>
  save: () => Promise<void>
  close: () => Promise<void>
}

/** The project the USER has open: set where the UI's Open / New / Save As
 *  land, cleared by Close. Not the workspace slot — that is set before a
 *  failed open's swap and survives Close — and not the actor's state, which
 *  always holds a project (a startup placeholder, or the one just closed). */
export interface OpenedProject { dir: string }

/** What the MCP session view says about projects: the one open (its name read
 *  from the actor, so a rename cannot go stale) and where one can come from. */
export interface ProjectStatus {
  project: { name: string; dir: string } | null
  /** The Recents list, newest first — what the start screen shows. */
  recent_projects: Array<{ name: string; path: string }>
  /** Where the New Project dialog would create one. */
  default_parent_folder: string | null
}

/** What an agent's open / create answers: the project now open, and the one
 *  it replaced (flushed to disk first), if any. */
/** `already_open`: `open_project` named the folder already open, so nothing
 *  was flushed or reloaded and the undo history stands. */
export interface ProjectOpened { name: string; dir: string; replaced: string | null; already_open?: boolean }

export interface TsActorHost {
  exportJobs?: import("../exportJobs").ExportJobs
  computeJobs?: import("../compute/jobs").ComputeJobs
  projectOperationPending?: () => boolean
  actor: ActorHandle
  agent: AgentActivityService
  /** The project the user has open, or null on the start screen. What the MCP
   *  surface gates project work on (`server.ts`). */
  openedProject: () => OpenedProject | null
  projectStatus: () => ProjectStatus
  /** The open project's merged style tokens (`project://taste`); the default
   *  style alone on the start screen. Read fresh: TASTE.md is the user's file. */
  taste?: () => import("../taste/view").TasteView
  /** The last `check_composition` result per composition, for freshness. */
  audits: import("../lint/audits").AuditStore
  /** MCP's `open_project` / `create_project`: the start screen's Open and New,
   *  plus the event that brings the editor along. A `WorkspaceFailure` throws
   *  through untouched, leaving the open record as it was. */
  projects: {
    /** True once `shutdown` ran: an agent cannot open anything while the app
     *  quits. */
    shuttingDown: () => boolean
    open: (dir: string) => Promise<ProjectOpened>
    create: (args: { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }) => Promise<ProjectOpened>
  }
  handleInvoke: (channel: string, args: Record<string, unknown>) => Promise<unknown>
  /** Full published view; reads during replacement retain the last settled view. */
  publication: () => ProjectPublication<ReturnType<typeof buildProjectSummary>>
  /** The Review view (ADR 0115) against the published project — what
   *  `review_view` serves; the user-only list only when `includeUser`. Empty
   *  while no project is open. */
  reviewView: (includeUser?: boolean) => ReviewView
  /** Preserve the raw operation result and add a renderer-only view barrier. */
  published: <T>(run: () => Promise<T>) => Promise<PublishedResult<T>>
  /** Host-level MCP call: delegates to actor.mcpCall, then emits the appropriate
   *  LogBus pin-row for restore_checkpoint / create_checkpoint / begin_agent_session on success.
   *  The emit is best-effort (try/catch) and never blocks or fails the call.
   *  server.ts calls this instead of actor.mcpCall directly for the 'ts' route. */
  mcpCall: (name: string, argsJson: string, client?: string) => import('./mcp-commands.js').McpCallResult
  /** Hybrid deps (native-compute → TS-write). Exposed so the MCP host's hybrid
   *  branch can `runHybrid(name, args, tsHost.hybridDeps)` (server.ts). */
  hybridDeps: HybridDeps
  /** The host's one importer: the renderer's and every agent's imports of the
   *  same file join through it (server.ts passes the agent as `by`). */
  mediaImporter: MediaImporter
  /** What the disk holds for each pool item, as the summary shows it.
   *  Readers of a source's bytes settle it first (ADR 0153); a change found
   *  by a refresh, recheck or settle republishes. */
  poolFiles: PoolFiles
  /** Host-level Motif tool dispatch (catalog read + authoring + install). Both
   *  the renderer `handleInvoke('motif')` and the MCP `route==='motif'` path use it. */
  motifTool: (name: string, args: Record<string, unknown>) => unknown
  /** Re-pull list_motifs → actor.setUserMotifManifests. Exposed so the file
   *  watcher can refresh the actor catalog when a Motif appears on disk with no
   *  store-mutating tool call (otherwise add_motif rejects it). */
  refreshMotifCatalog: () => void
  /** The quit path's close: nothing can be opened from the call on, the
   *  project is flushed, and a write after the flush is refused instead of
   *  answered and then lost. A failed flush rejects with the project, and
   *  every service working for it, as they were. */
  shutdown: () => Promise<void>
  /** The quit path's "Quit without saving", after `shutdown` failed: the gate
   *  shuts as in `shutdown` and nothing more is written. */
  abandon: () => void
  /** Edits not on disk yet. */
  hasUnsavedEdits: () => boolean
  /** Writes the open project's unsaved edits before returning, for the one
   *  caller that cannot await (sessionEnd.ts). A failed write throws. Writes
   *  nothing with no project open, and nothing while a replacement is in
   *  flight: its own flush has run, and until it settles the folder and the
   *  project in memory need not be the same project. */
  saveNow: () => void
  start: () => void
  stop: () => void
}

/** Mints the `project:changed` wire payload the renderer reads. `affected`
 *  carries the refs themselves, so a reader decides from the ids whether an
 *  edit touched what it shows, which a count cannot tell it. */
export function mapChangeEvent(e: ChangeEvent): { op_id: string; actor_kind: 'user' | 'agent'; client: string | null; summary: string; timestamp: string; affected: EntityRef[] } {
  const actor_kind = e.actor.kind === 'Agent' ? 'agent' : 'user'
  const client = e.actor.kind === 'Agent' ? e.actor.client : null
  return { op_id: e.op_id, actor_kind, client, summary: e.summary, timestamp: e.timestamp, affected: e.affected }
}

/** Extract Manifest-shaped entries from a `list_motifs` JSON array.
 *  list_motifs returns every manifest field plus `html`/`status`/`content_hash`;
 *  we keep only non-builtin entries (installed + draft) — built-ins are already
 *  in the catalog's built-in layer and built-ins always win on id collision. */
function manifestsFromList(entries: unknown[]): Manifest[] {
  const out: Manifest[] = []
  for (const e of entries) {
    if (e == null || typeof e !== 'object') continue
    const entry = e as Record<string, unknown>
    if (entry['status'] === 'builtin') continue
    // Keep only entries that have at minimum the required Manifest fields.
    if (typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string') continue
    out.push(entry as unknown as Manifest)
  }
  return out
}

/** The pool as `resources/list` names it (`mediaResourceDefs`): ids, labels
 *  and paths, so a change to any of them is a change to the list. */
function mediaListKey(pool: Record<string, MediaItem>): string {
  return JSON.stringify(Object.values(pool).map((m) => [m.id, m.label, m.path_abs, m.path_rel]))
}

export function createTsActorHost(deps: TsActorHostDeps): TsActorHost {
  // Single shared idGen: used for blankProject, createActor, and orchestratorDeps.
  const idGen = uuidV7Gen()
  // The actor catalog's user layer is a watcher-refreshed cache. Back it with a
  // store fallback so add_motif resolves a disk-written Motif the instant
  // list_motifs (disk-backed) sees it, without waiting for the debounced refresh.
  const store = deps.motifStore
  const motifCatalog = new MotifCatalog(store ? (id) => store.getMotif(id)?.manifest ?? null : undefined)
  const actor = createActor({
    assertWritable: () => {
      deps.exportJobs?.assertWritable()
      if (replacing && !swapping) throw new ExportJobError('project_busy', 'Wait for the project operation to finish')
    },
    initial: blankProject(idGen, 'untitled'), idGen, clock: () => new Date().toISOString(), motifCatalog,
    autoDeleteEmptyTracks: () => deps.appSettings?.get().auto_delete_empty_tracks ?? true,
    defaultTextFont: () => deps.appSettings?.get().default_text_font,
    // Read at each creation, so an edit to TASTE.md reaches the next layer
    // without a reload. `opened` is assigned below; this runs only later.
    tasteTokens: () => (deps.styleDirs ? tasteView(deps.styleDirs, opened?.dir ?? null, { motif: (id) => motifCatalog.get(id) ?? null }).tokens : null),
    installedFonts: () => deps.installedFonts?.() ?? null,
    // Reconcile-dropped-transition rows ride the same log_emit seam as the
    // relink/checkpoint pin-rows.
    emitLog: (entry) => { try { deps.emitLog?.(entry) } catch (err) { console.warn('[ts-actor-host] emitLog failed (actor)', err) } },
  })
  let emitting = false
  let publicationVersion: ProjectVersion = { session: 0, revision: 0 }
  let publishedProject: ReturnType<ActorHandle['snapshot']> | null = null
  let publishedHistory = actor.historyStatus()
  let publishedDir: string | null = null
  /** A workspace replacement is under way, from the flush that saved the
   *  outgoing project to the end of the swap. Every write is refused then
   *  (`assertWritable`): one landing after the flush would be dropped by the
   *  swap, or written into a project already closed. */
  let replacing = false
  /** The swap itself: the one write `replacing` admits. */
  let swapping = false
  let replacementOccurred = false
  let deferredChange: { event: ChangeEvent; traceId?: string } | null = null
  const agent = new AgentActivityService(actor, deps.send)

  let saveStatus: SaveStatus = { state: 'ok', revision: 0 }
  /** Publishes autosave's state, and logs the transitions a user would look
   *  for in the log: failing once, and recovered once. A reset is a different
   *  project, not a recovery, and lands in that project's log, so it logs nothing. */
  const onSaveState = (state: AutosaveSaveState): void => {
    const wasFailing = saveStatus.state === 'failing'
    const revision = saveStatus.revision + 1
    saveStatus = state.kind === 'ok' ? { state: 'ok', revision } : {
      state: 'failing', revision, since: state.since.toISOString(), last_saved_at: state.lastSavedAt?.toISOString() ?? null,
      code: state.code, path: state.path, dir: state.dir,
    }
    if (emitting) {
      try { deps.send(SAVE_STATUS_EVENT, saveStatus) }
      catch (error) { console.warn('[ts-actor-host] save status notification failed', error) }
    }
    try {
      if (state.kind === 'failing' && !wasFailing) {
        deps.emitLog?.({
          level: 'warn', category: { kind: 'Project' }, source: { kind: 'System' },
          message: 'Project not saved: project.json cannot be written', i18n_key: 'log.save_failing',
          details: { kind: 'SaveFailing', code: state.code, path: state.path, since: state.since.toISOString(),
            last_saved_at: state.lastSavedAt?.toISOString() ?? null },
        })
      } else if (state.kind === 'ok' && state.cause === 'saved' && wasFailing) {
        deps.emitLog?.({
          level: 'info', category: { kind: 'Project' }, source: { kind: 'System' },
          message: 'Project saved again', i18n_key: 'log.save_recovered', details: { kind: 'SaveRecovered' },
        })
      }
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (save status)', err) }
  }
  const autosave: AutosaveController = createAutosave({
    actor,
    fs: deps.fs,
    workspaceDir: deps.workspaceDir,
    join: deps.join,
    serialize: serializeProjectToJson,
    onSaveState,
  })

  let importGeneration = 0
  let workspaceTransitions = 0
  // An item whose bytes must be read first is enqueued after the read, and
  // only into the project it was read for.
  const enqueuePreparedDerivatives = makeEnqueueDerivatives(deps.napi, async (item) => {
    const assertCurrent = captureImportSession(hybridDeps)
    const holds = (await poolFiles.settle(item)) === 'present'
    assertCurrent()
    return holds ? actor.snapshot().media_pool[item.id] ?? null : null
  })
  const enqueueDerivatives = (project: import('./model').Project): void => {
    enqueuePreparedDerivatives(project)
    void recoverInterruptedImports(hybridDeps, (mediaId, error) => {
      deps.emitLog?.({ level: 'error', category: { kind: 'Import' }, source: { kind: 'System' },
        message: `Import recovery failed: ${String(error)}`, details: { media_id: mediaId } })
    }, async (item) => (await poolFiles.settle(item)) === 'present').catch(error => { console.warn('[media] import recovery stopped', error) })
  }
  // Open-time relink self-heal: content identity comes from the same BLAKE3
  // napi the import hash pass uses; the report lands as a status-log row.
  const onRelink = (report: RelinkReport): void => {
    try {
      if (report.healed.length > 0) {
        deps.emitLog?.({
          level: 'info',
          category: { kind: 'Project' },
          source: { kind: 'System' },
          message: `Relinked ${report.healed.length} media file(s) by content`,
          details: { kind: 'Relink', healed: report.healed },
        })
      }
      if (report.missing.length > 0) {
        deps.emitLog?.({
          level: 'warn',
          category: { kind: 'Project' },
          source: { kind: 'System' },
          message: `${report.missing.length} media file(s) missing from the workspace`,
          details: { kind: 'Relink', missing: report.missing },
        })
      }
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (relink)', err) }
  }
  // Load-time grid repair: `parseProject` pulls legacy off-grid geometry onto its
  // lattice (and lifts a negative start) so an older project OPENS instead of
  // failing the backstop that `replaceState` shares with every mutation. The repair
  // rewrites the user's timeline, so `warn`, not `info` — the failure mode worth
  // designing against is a migration nobody was told about. Best-effort, like relink.
  const onGridRepair = (repairs: readonly GridRepair[]): void => {
    try {
      deps.emitLog?.({
        level: 'warn',
        category: { kind: 'Project' },
        source: { kind: 'System' },
        message: `Repaired ${repairs.length} off-grid timeline field(s) on load`,
        details: { kind: 'GridRepair', repairs: repairs.map((r) => ({ ...r })), summary: describeGridRepairs(repairs) },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (grid repair)', err) }
  }
  // Load-time schema upgrade: the migration chain moved an older project.json
  // forward (migrate.ts). `warn` for the same reason as the grid repair — what the
  // next save writes is no longer what was opened — and the row names the
  // verified backup and every clip whose position was baked.
  const onSchemaUpgrade = (report: SchemaUpgradeReport): void => {
    try {
      deps.emitLog?.({
        level: 'warn',
        category: { kind: 'Project' },
        source: { kind: 'System' },
        message: `Project upgraded from schema v${report.from} to v${report.to}; the original is kept as ${report.backupFile}` +
          (report.bakedPositions?.length ? `; ${report.bakedPositions.length} clip(s) converted to frame-sampled position keys. Existing frame appearance is preserved; interpolation between samples and future retiming may differ.` : ''),
        details: { kind: 'SchemaUpgrade', from: report.from, to: report.to, backup: report.backupFile,
          ...(report.bakedPositions?.length ? { bakedPositions: report.bakedPositions } : {}) },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (schema upgrade)', err) }
  }
  const relink = deps.relinkFs
    ? { fs: deps.relinkFs, join: deps.join, hashFile: (p: string) => deps.compute.hashMediaSource(p) }
    : undefined
  const migration = { motifSize: (id: string, version: number) => {
    const manifest = motifCatalog.get(id)
    return manifest?.version === version ? manifest.size : null
  } }
  const swapActor: Pick<ActorHandle, 'replaceState' | 'snapshot'> = {
    snapshot: () => actor.snapshot(),
    replaceState: (next) => {
      swapping = true
      try { actor.replaceState(next) } finally { swapping = false }
    },
  }
  const orchestratorDeps = { actor: swapActor, napi: deps.napi, fs: deps.fs, join: deps.join, idGen, enqueueDerivatives, relink, onRelink, onGridRepair, onSchemaUpgrade, migration }

  // Hybrid orchestrator deps (native-compute → TS-write). enqueueDerivatives here
  // takes the inserted ITEMS (vs the orchestrator's whole-Project variant) and
  // hands them straight to the Backend's open-time job re-fan-out napi.
  const hybridDeps: HybridDeps = {
    beginImport: deps.beginImport,
    actor,
    compute: deps.compute,
    enqueueDerivatives: async (items) => { await deps.napi.enqueueJobsForMedia(JSON.stringify(items)) },
    enqueueWorkspaceCopy: deps.enqueueWorkspaceCopy,
    workspaceDir: deps.workspaceDir,
    importGeneration: () => importGeneration,
    canImport: () => workspaceTransitions === 0,
    readFile: deps.readFile,
    statPath: deps.statPath,
    realPath: deps.realPath,
    fileKey: deps.fileKey,
    rasterizeSvg: deps.rasterizeSvg,
    snapshotComposition: () => rootComposition(actor.snapshot()),
  }
  const mediaImporter = createMediaImporter(hybridDeps)

  // What the disk holds for each pool item (ADR 0153), read once per item
  // object and cached; see poolFiles.ts for what reads it again.
  const poolFiles: PoolFiles = createPoolFiles({
    stat: (p) => deps.poolFs.stat(p),
    statAsync: (p) => deps.poolFs.statAsync(p),
    hash: (p) => deps.compute.hashMediaSource(p),
    confirmed: (item, mtimeSecs) => {
      const now = actor.snapshot().media_pool[item.id]
      if (!now || now.path_abs !== item.path_abs || now.file_hash_blake3 !== item.file_hash_blake3) return
      actor.dispatch('set_media_workspace_paths', { media: item.id, paths: {
        path_abs: now.path_abs, path_rel: now.path_rel, file_hash_blake3: now.file_hash_blake3, file_size: now.file_size, file_mtime: mtimeSecs } })
    },
    // A pool file is no longer what a summary said. Nothing in the project
    // changed, so this is a publication alone. Mid-replacement it is dropped:
    // the replacement clears the cache, so the next summary reads it anew.
    changed: () => { if (!replacing && publishedProject !== null) publishChange() },
  })
  /** `fresh` re-reads every pool file first: the view is about to be acted
   *  on (export start), not only shown. */
  function summaryOf(project: import('./model').Project, history: import('./history').HistoryStatus, fresh = false) {
    return buildProjectSummary(project, history, poolFiles.read(project.media_pool, fresh))
  }

  // Serialize all cache-root/session changes, including Save As and Close.
  let persistenceTail: Promise<unknown> = Promise.resolve()
  /** The outgoing project's flush may fail without blocking the replacement:
   *  `keepsEdits` (Save As writes the whole current state elsewhere, which is
   *  the way out the save-failure card offers), or its folder is gone (a
   *  deleted project must not block New/Open/Save As/Close; an explicit Save
   *  still reports it). */
  const flushMayFail = (error: unknown, keepsEdits: boolean): boolean => {
    if (keepsEdits) return true
    const dir = deps.workspaceDir()
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' && dir !== null && !deps.fs.exists(dir)
  }
  /** Flush, then replace. A flush that fails aborts before anything is
   *  invalidated: no service hears of a change that did not happen, and every
   *  import, job and bake of the open project goes on. */
  const replaceWorkspace = <T>(replace: () => Promise<T>, closing = false, keepsEdits = false): Promise<T> => {
    deps.exportJobs?.assertWritable()
    // Pending from here, however it ends: no import or export starts. A gate
    // only, undone when the transition settles.
    workspaceTransitions++
    // A close shuts the agents' gate at the request, not at the flush: an
    // agent write racing it is refused (NoProjectOpen) rather than saved into
    // the project the user is closing. A failed flush opens it again.
    const openAtRequest = opened
    if (closing) opened = null
    const next = persistenceTail.then(async () => {
      // LANDMINE: from `replacing = true` to onWorkspaceChanging nothing may
      // await. The flush then holds every edit made before it, none can land
      // between it and the swap, and a failed one is undone by clearing one
      // flag before anything else has run.
      replacing = true
      try { autosave.forceFlush() }
      catch (error) {
        if (!flushMayFail(error, keepsEdits)) {
          replacing = false
          if (closing && opened === null) opened = openAtRequest
          throw error
        }
      }
      importGeneration++
      deps.onWorkspaceChanging?.()
      replacementOccurred = false
      deferredChange = null
      let succeeded = false
      try {
        const value = await replace()
        succeeded = true
        return value
      }
      catch (error) {
        // A recent-list or other post-swap failure cannot roll back the actor.
        // Publish that actual replacement; failures before the swap retain the
        // old settled project.
        const dir = replacementOccurred ? deps.workspaceDir() : publishedDir
        opened = dir === null ? null : { dir }
        if (opened !== null) deps.onWorkspaceOpened?.()
        throw error
      }
      finally {
        replacing = false
        // Another folder's files, or the same files under another Cache/:
        // nothing read before the replacement is known to hold.
        poolFiles.clear()
        // Another project (or none) now: what was unsaved belonged to the old one.
        if (succeeded || replacementOccurred) autosave.beginProject()
        const pending = deferredChange as { event: ChangeEvent; traceId?: string } | null
        if (replacementOccurred || pending || (succeeded && (!closing || publishedProject !== null))) {
          publishChange(pending?.event, pending?.traceId,
            replacementOccurred || (succeeded && (!closing || publishedProject !== null)), true)
        }
        deferredChange = null
      }
    })
    const settled = next.finally(() => {
      workspaceTransitions--
      if (workspaceTransitions === 0) deps.exportJobs?.workspaceSettled()
    })
    persistenceTail = settled.catch(() => {})
    return settled
  }

  let opened: OpenedProject | null = null
  /** Set once the app starts quitting; never cleared. Nothing opens after it. */
  let quitting = false
  // Each record update runs only after its operation resolves, so a failed
  // open leaves the record as it was — and an open still in flight when the
  // quit began does not reopen the gate the quit closed.
  const opens = (dir: string): void => {
    if (!quitting) { opened = { dir }; deps.onWorkspaceOpened?.() }
  }
  const persistence: PersistenceHandlers = {
    open: (dir) => replaceWorkspace(async () => { await openProject(orchestratorDeps, dir); opens(dir) }),
    saveAs: (dir) => replaceWorkspace(async () => {
      try { await saveProjectAs(orchestratorDeps, dir) }
      finally {
        // Save As changes the workspace without replacing actor state. A
        // failure in recent-list bookkeeping after commitWorkspace still leaves
        // a real new session, just like a post-swap failure in Open.
        if (deps.workspaceDir() === dir && publishedDir !== dir) {
          replacementOccurred = true
        }
      }
      opens(dir)
    }, false, true),
    newWorkspace: (a) => replaceWorkspace(async () => { const dir = await newWorkspace(orchestratorDeps, a); opens(dir); return dir }),
    save: async () => autosave.forceFlush(),
    // A write before the flush is in it; one after is refused until the close
    // settles (`replacing`). The actor keeps the closed project until the next
    // Open / New replaces it, and the workspace slot keeps its folder; what
    // stops an agent writing into it afterwards is the MCP gate (`opened`).
    close: () => replaceWorkspace(async () => { opened = null; await deps.napi.endWorkspace?.() }, true),
  }

  /** Two spellings of one folder: resolved (`.`/`..`, trailing separators),
   *  then through the real path (symlinks, and on Windows and macOS the
   *  on-disk case) when the host can read it. */
  const sameFolder = (a: string, b: string): boolean => {
    const norm = (p: string) => resolvePath(deps.realPath ? deps.realPath(p) : p)
    return norm(a) === norm(b)
  }
  const agentProjects: TsActorHost['projects'] = {
    shuttingDown: () => quitting,
    open: async (dir) => {
      const replaced = opened?.dir ?? null
      // The folder already open is not reopened: a reload would flush and
      // drop the undo history, checkpoints, tacks and the work session of the
      // very project the caller wanted open.
      if (replaced !== null && sameFolder(replaced, dir)) return { name: actor.snapshot().metadata.name, dir: replaced, replaced: null, already_open: true }
      await persistence.open(dir)
      deps.send(PROJECT_OPENED_EVENT, { dir } satisfies ProjectOpenedPayload)
      return { name: actor.snapshot().metadata.name, dir, replaced, already_open: false }
    },
    create: async (a) => {
      const replaced = opened?.dir ?? null
      const dir = await persistence.newWorkspace(a)
      deps.send(PROJECT_OPENED_EVENT, { dir } satisfies ProjectOpenedPayload)
      return { name: actor.snapshot().metadata.name, dir, replaced }
    },
  }

  /** Best-effort refresh the actor's user motif layer from list_motifs.
   *  Called on start() and after motif-store-mutating hybrid channels
   *  (install_motif, delete_motif, open_motif_draft, update_motif_files).
   *  A refresh failure must never abort. */
  function refreshMotifCatalog(): void {
    deps.listMotifs?.().then((j) => {
      actor.setUserMotifManifests(manifestsFromList(JSON.parse(j) as unknown[]))
    }).catch(() => {})
  }

  function runMotif(name: string, args: Record<string, unknown>): unknown {
    if (!["list_motifs", "read_motif", "list_motif_proposals", "motif_staleness_report"].includes(name)) deps.exportJobs?.assertWritable()
    if (!deps.motifStore) throw new Error('motifTool: motifStore not configured')
    const motifToolDeps: MotifToolDeps = {
      store: deps.motifStore,
      builtins: deps.motifBuiltins ?? [],
      // With no project open the actor holds a placeholder or the project the
      // user closed: an update-mode install then touches only the library.
      motifLayers: () => opened === null ? [] :
        [...eachLayer(actor.snapshot())].flatMap(({ layer: l }) => {
          if (l.params.kind !== 'Motif') return []
          const p = l.params as MotifParams
          return [{ layerId: l.id, motifId: p.motif_id, version: p.motif_version, props: p.props } satisfies MotifLayerRef]
        }),
      dispatchRebind: (updates: MotifRebindEntry[]) => { const r = actor.dispatch('rebind_motif', { updates }); if (!r.ok) throw new Error(JSON.stringify(r.error)) },
      emitChanged: () => deps.send('motifs:changed', {}),
      refreshCatalog: () => refreshMotifCatalog(),
      notifyAgents: () => deps.mcpResourcesChanged?.(),
      emitLog: (entry) => { try { deps.emitLog?.(entry) } catch (err) { console.warn('[ts-actor-host] emitLog failed (motif)', err) } },
    }
    return runMotifTool(name, args, motifToolDeps)
  }

  function publishChange(e?: ChangeEvent, traceId?: string, newSession = false, settledWorkspace = false): void {
    publicationVersion = {
      session: publicationVersion.session + (newSession ? 1 : 0),
      revision: publicationVersion.revision + 1,
    }
    // `opened` doubles as an immediate write gate on Close. Only a settled
    // lifecycle operation can turn that early gate closure into a null view.
    if (settledWorkspace) publishedDir = opened?.dir ?? null
    publishedProject = publishedDir === null ? null : actor.snapshot()
    publishedHistory = actor.historyStatus()
    if (emitting) {
      try {
        deps.send('project:changed', {
          ...(e ? mapChangeEvent(e) : {}), publication: { ...publicationVersion },
          ...(traceId ? { [EDIT_TRACE_ARG]: traceId } : {}),
        })
      } catch (error) { console.warn('[ts-actor-host] project publication notification failed', error) }
    }
  }

  // What `resources/list` says of the pool: each file's id and name.
  let listedMedia = ''
  function emitChange(e: ChangeEvent): void {
    const traceId = currentEditTrace()?.id
    if (replacing) {
      replacementOccurred ||= e.replaced === true
      deferredChange = { event: e, traceId }
    } else publishChange(e, traceId, e.replaced === true)
    const listed = mediaListKey(actor.snapshot().media_pool)
    if (listed !== listedMedia) {
      listedMedia = listed
      if (emitting) deps.mcpResourcesChanged?.()
    }
  }

  function publication(): ProjectPublication<ReturnType<typeof buildProjectSummary>> {
    return { version: { ...publicationVersion }, summary: publishedProject === null ? null
      : summaryOf(publishedProject, publishedHistory) }
  }

  const answerPublication = createPublicationAnswers<ReturnType<typeof buildProjectSummary>>()

  async function published<T>(run: () => Promise<T>): Promise<PublishedResult<T>> {
    const before = publicationVersion.revision
    const value = await run()
    // A native/async operation may finish while a workspace replacement has
    // deferred its actor events. Its barrier must name the settled publication,
    // never mistake those deferred changes for a no-op.
    if (workspaceTransitions > 0) await persistenceTail
    return { value, publication: before === publicationVersion.revision ? null : { ...publicationVersion } }
  }

  /** The Review view: the actor's state now, named by the latest publication.
   *  The two can differ only while a replacement defers the actor's events —
   *  the state may then be ahead of what was published — and an approval or
   *  revert is refused then (`reviewViewCurrent`), so no view of that window is ever
   *  acted on. */
  function reviewView(includeUser = false): ReviewView {
    const s = actor.reviewState()
    const version = { ...publicationVersion, baseline_revision: s.baseline_revision }
    // Closing accepts unreviewed changes silently (ADR 0115): with no project
    // open there is nothing to review, though the actor still holds one.
    // What this reader reads: the user-only list's changes move it only when asked for.
    const content_revision = includeUser ? s.content_revision_with_user : s.content_revision
    if (publishedDir === null) return { version, content_revision, has_baseline: false, unreviewed: [], user: [], user_count: 0, decorations: [] }
    return { version, content_revision, has_baseline: s.has_baseline, unreviewed: s.unreviewed, user: includeUser ? s.user : [], user_count: s.user.length, decorations: s.decorations }
  }

  /** `review_view` for a caller holding the lists of content revision
   *  `held`: while they are still the current ones (and a project is open),
   *  only the version and counts — the lists again otherwise. */
  function reviewViewSince(includeUser: boolean, held: unknown): ReviewView | ReviewViewUnchanged {
    const view = reviewView(includeUser)
    if (publishedDir === null || held !== view.content_revision) return view
    return { unchanged: true, version: view.version, content_revision: view.content_revision, has_baseline: view.has_baseline, user_count: view.user_count }
  }

  /** Is `held` — the version of the view the user acted on — still the
   *  current view's? Any commit moves the publication revision and any
   *  baseline change its revision; mid-replacement the actor may hold
   *  changes no publication shows yet, so nothing is current then. */
  function reviewViewCurrent(version: unknown): boolean {
    if (typeof version !== 'object' || version === null || replacing || publishedDir === null) return false
    const held = version as Partial<ReviewVersion>
    return held.session === publicationVersion.session && held.revision === publicationVersion.revision
      && held.baseline_revision === actor.reviewRevision()
  }

  /** What one activity's ops did (spec Part B, per-activity highlight). Like
   *  `reviewView`, nothing to show with no project open. */
  function reviewActivityView(ids: unknown): ReviewActivityView {
    const wanted = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    if (publishedDir === null || wanted.length === 0) return { available: false, reverted: false, changes: [], decorations: [] }
    return actor.reviewOpDiff(wanted)
  }

  // Baseline changes reach the renderer as one coalesced `review:changed` per
  // microtask: attribution fires inside a commit and must not fan out into
  // several refetches.
  let reviewNotifyQueued = false
  let reviewRevision = 0
  actor.subscribeReview((revision) => {
    reviewRevision = revision
    if (reviewNotifyQueued) return
    reviewNotifyQueued = true
    queueMicrotask(() => {
      reviewNotifyQueued = false
      if (!emitting) return
      try { deps.send(REVIEW_CHANGED_EVENT, { baseline_revision: reviewRevision } satisfies ReviewChangedPayload) }
      catch (error) { console.warn('[ts-actor-host] review notification failed', error) }
    })
  })

  function reject(reason: string): never { throw new Error(reason) }

  // ── LogBus pin-row helpers ──────────────────────────────────────────────────
  // All pin-rows: level 'info', category {kind:'Project'}.

  function emitRestoreLog(id: string, label: string | null, source: { kind: 'User' } | { kind: 'Agent'; client: string }): void {
    agent.checkpoint('restore', id, label ?? id)
    try {
      deps.emitLog?.({
        level: 'info',
        category: { kind: 'Project' },
        source,
        message: label != null ? `Restored to checkpoint: ${label}` : `Restored to checkpoint: ${id}`,
        details: { kind: 'Restore', checkpoint_id: id, label: label ?? null },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (restore)', err) }
  }

  /** Checkpoint activity and diagnostic pin-row, for either caller surface. */
  function emitCheckpointLog(
    id: string, label: string,
    source: { kind: 'User' } | { kind: 'Agent'; client: string },
  ): void {
    agent.checkpoint('checkpoint', id, label)
    try {
      deps.emitLog?.({
        level: 'info',
        category: { kind: 'Project' },
        source,
        message: `Checkpoint: ${label}`,
        details: { kind: 'Checkpoint', id, label },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (checkpoint)', err) }
  }

  /** Refresh recovery availability and retain a diagnostic deletion record. */
  function emitCheckpointDeletedLog(
    id: string, label: string | null,
    source: { kind: 'User' } | { kind: 'Agent'; client: string },
  ): void {
    agent.refresh()
    try {
      deps.emitLog?.({
        level: 'info',
        category: { kind: 'Project' },
        source,
        message: label != null ? `Checkpoint deleted: ${label}` : `Checkpoint deleted: ${id}`,
        details: { kind: 'CheckpointDeleted', id, label: label ?? null },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (checkpoint delete)', err) }
  }

  /** See TsActorHost.mcpCall. */
  function mcpCall(name: string, argsJson: string, client?: string): import('./mcp-commands.js').McpCallResult {
    const result = actor.mcpCall(name, argsJson, client)
    if (!result.ok) return result
    try {
      const a = JSON.parse(argsJson) as Record<string, unknown>
      if (name === 'restore_checkpoint') {
        const cpId = (a.checkpoint_id as string | undefined) ?? ''
        const label = actor.listCheckpoints().find((c) => c.id === cpId)?.label ?? null
        emitRestoreLog(cpId, label, mcpActor(client))
      } else if (name === 'create_checkpoint') {
        const label = ((a.label as string | undefined) ?? '').trim()
        const cpId = String((result.result.structuredContent as { checkpoint_id?: unknown } | undefined)?.checkpoint_id ?? '')
        emitCheckpointLog(cpId, label, mcpActor(client))
      } else if (name === 'begin_agent_session') {
        const reason = ((a.reason as string | undefined) ?? '').trim()
        const label = `Pre-agent: ${reason}`
        const payload = JSON.parse(result.result.content[0]?.text ?? '{}') as { checkpoint_id?: string }
        const cpId = payload.checkpoint_id ?? ''
        emitCheckpointLog(cpId, label, mcpActor(client))
      }
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (mcpCall post-hook)', err) }
    return result
  }

  async function handleInvoke(channel: string, args: Record<string, unknown>): Promise<unknown> {
    if (channel === 'project_publication') return runEditTrace(editTraceId(args[EDIT_TRACE_ARG]), 'main.summary',
      () => answerPublication(publication(), (args[PUBLICATION_BASE_ARG] as number | undefined) ?? null))
    if (channel === 'agent_activity_snapshot') return agent.snapshot()
    if (channel === 'agent_session_get') return agent.snapshot().session
    if (channel === 'agent_unlock_history') { agent.unlock(); return null }
    const route = routeChannel(channel)
    switch (route.kind) {
      case 'command': {
        // Read BEFORE the command runs: delete destroys the row, so afterwards
        // there is nothing left to name it with.
        const doomedLabel = channel === 'project_delete_checkpoint'
          ? actor.listCheckpoints().find((c) => c.id === (args.checkpointId as string | undefined))?.label ?? null
          : null
        const { [EDIT_TRACE_ARG]: traceInput, ...commandArgs } = args
        const r = runEditTrace(editTraceId(traceInput), `main.command.${channel}`,
          () => {
            const result = actor.command(channel, commandArgs)
            currentEditTrace()?.fact('commandAccepted', result.ok)
            return result
          })
        // The renderer surfaces an IPC rejection as `Error.message` (bridge/ipc.ts),
        // so serialize the CommandError as JSON to keep it structured.
        if (!r.ok) throw new Error(JSON.stringify(r.error))
        // Keep local checkpoint actions visible in activity and diagnostics.
        if (channel === 'project_restore_checkpoint') {
          // Emit the Restore pin-row (User source). The checkpoint is kept on restore,
          // so listCheckpoints() still resolves the id → label after the call.
          const cpId = (args.checkpointId as string | undefined) ?? ''
          const label = actor.listCheckpoints().find((c) => c.id === cpId)?.label ?? null
          emitRestoreLog(cpId, label, { kind: 'User' })
        } else if (channel === 'project_create_checkpoint') {
          emitCheckpointLog(
            typeof r.value === 'string' ? r.value : '',
            typeof args.label === 'string' ? args.label.trim() : '',
            { kind: 'User' },
          )
        } else if (channel === 'project_delete_checkpoint') {
          emitCheckpointDeletedLog((args.checkpointId as string | undefined) ?? '', doomedLabel, { kind: 'User' })
        }
        return r.value
      }
      case 'summary':
        return runEditTrace(editTraceId(args[EDIT_TRACE_ARG]), 'main.summary',
          () => summaryOf(actor.snapshot(), actor.historyStatus(), true))
      case 'historyView':
        // The panel wants the WHOLE stack, so the limit is the cap itself — asked
        // of the actor rather than restated here. MCP's `project://history`
        // (resource-views.ts) keeps its own view(100): different consumer, different need.
        return actor.historyView(actor.historyCapacity())
      case 'projectSettings':
        return actor.snapshot().settings
      case 'saveStatus':
        return saveStatus
      case 'review': {
        if (channel === 'review_activity_view') return reviewActivityView((args as Partial<ReviewActivityArgs>).history_ids)
        const includeUser = (args as ReviewViewArgs).include_user === true
        if (channel === 'review_view') return reviewViewSince(includeUser, (args as ReviewViewArgs).held_content)
        // Approve all and revert all apply only to the view the user acted
        // on; a stale one does nothing. Either way it answers with the fresh
        // view: the surface that acted is the one reading it, so the
        // recompute is wanted, not speculative. A refused revert (history
        // lock) rejects as a command does.
        const applied = reviewViewCurrent((args as Partial<ReviewActionArgs>).version)
        if (applied && channel === 'review_approve_all') actor.approveReviewAll()
        else if (applied && channel === 'review_revert_all') {
          try { actor.revertReviewAll() }
          catch (e) { if (e instanceof CommandFailure) throw new Error(JSON.stringify(e.err)); throw e }
        }
        return { applied, view: reviewView(includeUser) } satisfies ReviewActionResult
      }
      case 'open': return persistence.open((args as { path: string }).path)
      case 'saveAs': return persistence.saveAs((args as { path: string }).path)
      case 'newWorkspace': return persistence.newWorkspace(args as never)
      case 'save': return persistence.save()
      case 'close': return persistence.close()
      case 'tacks': return runTackIpc(agent.tacks, channel, args)
      case 'agentSessionEnd': agent.end('user'); return null
      // Compatibility for the old local channel: it now requests a view only.
      case 'agentSessionBegin': deps.send(AGENT_VIEW_EVENT, { workspace_id: agent.snapshot().workspace_id }); return null
      case 'hybrid': {
        deps.exportJobs?.assertWritable()
        // The renderer's import answers the media id alone.
        if (route.tool === 'import_media') return (await mediaImporter.ensureImported(args.path as string)).mediaId
        return runHybrid(route.tool, args, hybridDeps)
      }
      case 'motif':
        return runMotif(route.tool, args)
      case 'appSettings': {
        const store = deps.appSettings
        if (!store) return reject('app_settings: store not configured')
        if (channel === 'app_settings_get') return store.get()
        const patch = (args as { patch?: AppSettingsPatch }).patch ?? {}
        const after = store.apply(patch)
        deps.send('app_settings:changed', after)
        return after
      }
      case 'workspace': {
        const store = deps.workspace
        if (!store) return reject('workspace: store not configured')
        // Every workspace op is opaque to the Project actor, so none of these can
        // dirty the Project or enter undo history. Layout slots stay opaque — the
        // renderer validates them.
        switch (channel) {
          case 'workspace_get': return store.get()
          case 'workspace_set_current':
            // Buffer + debounce; flushed on quit (index.ts).
            store.setCurrent((args as { current?: unknown }).current ?? null)
            return null
          case 'workspace_set_active':
            return store.setActive((args as { id: string }).id)
          case 'workspace_save_baseline':
            return store.saveBaseline()
          case 'workspace_create_profile': {
            const a = args as { name: string; current?: unknown }
            return store.createProfile(a.name, a.current ?? null)
          }
          case 'workspace_rename_profile': {
            const a = args as { id: string; name: string }
            return store.renameProfile(a.id, a.name)
          }
          case 'workspace_delete_profile':
            return store.deleteProfile((args as { id: string }).id)
        }
        return reject(`workspace: unhandled channel ${channel}`)
      }
      case 'viewState': {
        const store = deps.viewState
        if (!store) return reject('view_state: store not configured')
        const ws = deps.workspaceDir()
        if (channel === 'view_state_get') return ws ? store.load(ws) : viewStateDefaults()
        // view_state_set: pre-workspace (ws null) silently drops — the next
        // debounced write lands after Save As.
        const state = (args as { state?: ViewState }).state
        if (ws && state) store.save(ws, state)
        return null
      }
      case 'exportSettings': {
        const store = deps.exportSettings
        if (!store) return reject('export_settings: store not configured')
        const ws = deps.workspaceDir()
        if (channel === 'export_settings_get') return ws ? store.load(ws) : null
        // export_settings_set: pre-workspace (ws null) silently drops — the next
        // write lands after the workspace is open.
        const settings = (args as { settings?: unknown }).settings
        if (ws && settings !== undefined) store.save(ws, settings)
        return null
      }
      case 'keybindings': {
        const store = deps.keybindings
        if (!store) return reject('keybindings: store not configured')
        switch (channel) {
          case 'keybindings_get': return store.get()
          case 'keybindings_set': { const a = args as { action: string; keys: string[] }; store.set(a.action, a.keys); return null }
          case 'keybindings_reset_all': store.resetAll(); return null
          case 'keybindings_export': { const a = args as { dest: string }; store.exportTo(a.dest); return null }
          case 'keybindings_import': { const a = args as { src: string }; return store.importFrom(a.src) }
        }
        return reject(`keybindings: unhandled channel ${channel}`)
      }
      case 'recents': {
        const store = deps.recents
        if (!store) return reject('recents: store not configured')
        switch (channel) {
          case 'recents_list': return store.list()
          case 'recents_remove': { const a = args as { path: string }; store.remove(a.path); return null }
          case 'recents_get_reopen_on_launch': return store.getReopenOnLaunch()
          case 'recents_set_reopen_on_launch': { const a = args as { value: boolean }; store.setReopenOnLaunch(a.value); return null }
          case 'recents_most_recent': return store.mostRecent()
          case 'recents_last_new_project_parent': return store.lastNewProjectParent()
        }
        return reject(`recents: unhandled channel ${channel}`)
      }
      case 'reject': return reject(route.reason)
      // Both served upstream of this host — `clipCompute` by index.ts (which
      // owns the engine-selection closures), `rust` by the backend dispatcher.
      // Loud rather than a silent `undefined`, because an intercept dropped
      // during a refactor would otherwise read as "the tool returned nothing".
      case 'clipCompute': return reject(`router bug: ${channel} reached the TS host but is a clip-compute channel`)
      case 'rust': return reject(`router bug: ${channel} reached the TS host but is a Rust channel`)
      case 'audioFx': return reject(`router bug: ${channel} reached the TS host but is served by the audio-fx baker in main`)
    }
  }

  // Observation belongs to the host lifetime, not to renderer connectivity.
  // Stopping outbound notifications must not reset or lose the version clock.
  actor.subscribe(emitChange)
  return {
    actor,
    agent,
    ...(deps.exportJobs ? { exportJobs: deps.exportJobs } : {}),
    ...(deps.computeJobs ? { computeJobs: deps.computeJobs } : {}),
    projectOperationPending: () => workspaceTransitions > 0 || quitting,
    openedProject: () => opened,
    projects: agentProjects,
    shutdown: async () => {
      quitting = true
      // A failed close leaves the project open (replaceWorkspace); the quit's
      // Cancel and a failed update restart rely on it.
      try { await persistence.close() }
      catch (error) { quitting = false; throw error }
    },
    abandon: () => {
      quitting = true
      opened = null
      autosave.stop()
    },
    hasUnsavedEdits: () => autosave.unsaved(),
    saveNow: () => {
      if (opened === null || replacing || !autosave.unsaved()) return
      autosave.forceFlush()
    },
    ...(deps.styleDirs ? { taste: () => tasteView(deps.styleDirs!, opened?.dir ?? null, { motif: (id) => motifCatalog.get(id) ?? null, fonts: deps.installedFonts?.() ?? null }) } : {}),
    audits: new AuditStore((id) => motifCatalog.get(id) ?? null),
    projectStatus: () => ({
      project: opened === null ? null : { name: actor.snapshot().metadata.name, dir: opened.dir },
      recent_projects: (deps.recents?.list() ?? []).map((e) => ({ name: e.name, path: e.path })),
      default_parent_folder: deps.recents?.lastNewProjectParent() ?? null,
    }),
    handleInvoke,
    publication,
    reviewView,
    published,
    mcpCall,
    hybridDeps,
    mediaImporter,
    poolFiles,
    motifTool: runMotif,
    refreshMotifCatalog,
    start() {
      agent.start()
      emitting = true
      autosave.start()
      refreshMotifCatalog()
    },
    stop() {
      importGeneration++
      agent.stop()
      autosave.stop()
      emitting = false
    },
  }
}
