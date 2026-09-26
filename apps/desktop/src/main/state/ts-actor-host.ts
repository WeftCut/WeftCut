// apps/desktop/src/main/state/ts-actor-host.ts
import { createActor, type ActorHandle, type ChangeEvent } from './actor'
import type { EntityRef } from './history'
import { uuidV7Gen } from './ids'
import { blankProject, eachLayer, rootComposition } from './model'
import { buildProjectSummary } from './summary'
import { routeChannel } from './router'
import { createAutosave, type AutosaveController, type AutosaveFs } from './autosave'
import { openProject, saveProjectAs, newWorkspace, makeEnqueueDerivatives, type WorkspaceNapi, type OrchestratorFs, type SchemaUpgradeReport } from './workspace-orchestrator'
import type { RelinkFs, RelinkReport } from './relink'
import { serializeProjectToJson } from './persistence'
import { describeGridRepairs, type GridRepair } from './serialize'
import { AgentActivityService } from '../agent/activity'
import { mcpActor } from './mcp-actor'
import { AGENT_VIEW_EVENT } from '../../shared/agent-activity'
import { PROJECT_OPENED_EVENT, type ProjectOpenedPayload } from '../../shared/project-events'
import { runHybrid, type ComputeNapi, type HybridDeps } from './hybrids'
import { MotifCatalog, type Manifest } from '../../shared/motifs/catalog'
import type { UserMotifStore } from '../motif/store'
import { runMotifTool, type MotifToolDeps } from '../motif/motifTools'
import type { BuiltinMotif, MotifLayerRef } from '../motif/authoring'
import type { MotifParams, MotifRebindEntry } from './model'
import type { AppSettingsStore } from '../app-settings'
import type { AppSettingsPatch } from '../../shared/app-settings'
import type { ViewStateStore } from '../view-state'
import { viewStateDefaults, type ViewState } from '../../shared/view-state'
import type { ExportSettingsStore } from '../export-settings'
import type { KeybindingsStore } from '../keybindings'
import type { RecentsStore } from '../recents'
import type { WorkspaceStore } from '../workspace'

export interface TsActorHostDeps {
  /** mainWindow.webContents.send('evt:'+event, payload) */
  send: (event: string, payload: unknown) => void
  /** mcpHost.notifyChange(payload) — the mcp:change relay. */
  mcpNotify: (payload: unknown) => void
  /** fs.existsSync, for buildProjectSummary's media-availability checks. */
  fileExists: (absPath: string) => boolean
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
  enqueueWorkspaceCopy: (mediaId: string, sourcePath: string) => Promise<void>
  /** node:fs readFile (utf8) — for the subtitle hybrid. */
  readFile: (p: string) => string
  /** node:fs stat folded to `PathFacts` — `import_media` refuses on it before any write. */
  statPath: HybridDeps['statPath']
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
export interface ProjectOpened { name: string; dir: string; replaced: string | null }

export interface TsActorHost {
  actor: ActorHandle
  agent: AgentActivityService
  /** The project the user has open, or null on the start screen. What the MCP
   *  surface gates project work on (`server.ts`). */
  openedProject: () => OpenedProject | null
  projectStatus: () => ProjectStatus
  /** MCP's `open_project` / `create_project`: the start screen's Open and New,
   *  plus the event that brings the editor along. A `WorkspaceFailure` throws
   *  through untouched, leaving the open record as it was. */
  projects: {
    open: (dir: string) => Promise<ProjectOpened>
    create: (args: { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }) => Promise<ProjectOpened>
  }
  handleInvoke: (channel: string, args: Record<string, unknown>) => Promise<unknown>
  /** Host-level MCP call: delegates to actor.mcpCall, then emits the appropriate
   *  LogBus pin-row for restore_checkpoint / create_checkpoint / begin_agent_session on success.
   *  The emit is best-effort (try/catch) and never blocks or fails the call.
   *  server.ts calls this instead of actor.mcpCall directly for the 'ts' route. */
  mcpCall: (name: string, argsJson: string, client?: string) => import('./mcp-commands.js').McpCallResult
  /** Hybrid deps (native-compute → TS-write). Exposed so the MCP host's hybrid
   *  branch can `runHybrid(name, args, tsHost.hybridDeps)` (server.ts). */
  hybridDeps: HybridDeps
  /** Host-level Motif tool dispatch (catalog read + authoring + install). Both
   *  the renderer `handleInvoke('motif')` and the MCP `route==='motif'` path use it. */
  motifTool: (name: string, args: Record<string, unknown>) => unknown
  /** Re-pull list_motifs → actor.setUserMotifManifests. Exposed so the file
   *  watcher can refresh the actor catalog when a Motif appears on disk with no
   *  store-mutating tool call (otherwise add_motif rejects it). */
  refreshMotifCatalog: () => void
  start: () => void
  stop: () => void
}

/** Mints the `project:changed` wire payload — the shape the renderer event and
 *  the `notifications/weftcut/change` relay both see. `affected` carries the
 *  refs themselves: an agent watching the feed decides from the ids whether an
 *  edit touched its own work, which a count cannot tell it. */
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

export function createTsActorHost(deps: TsActorHostDeps): TsActorHost {
  // Single shared idGen: used for blankProject, createActor, and orchestratorDeps.
  const idGen = uuidV7Gen()
  // The actor catalog's user layer is a watcher-refreshed cache. Back it with a
  // store fallback so add_motif resolves a disk-written Motif the instant
  // list_motifs (disk-backed) sees it, without waiting for the debounced refresh.
  const store = deps.motifStore
  const motifCatalog = new MotifCatalog(store ? (id) => store.getMotif(id)?.manifest ?? null : undefined)
  const actor = createActor({
    initial: blankProject(idGen, 'untitled'), idGen, clock: () => new Date().toISOString(), motifCatalog,
    // Reconcile-dropped-transition rows ride the same log_emit seam as the
    // relink/checkpoint pin-rows.
    emitLog: (entry) => { try { deps.emitLog?.(entry) } catch (err) { console.warn('[ts-actor-host] emitLog failed (actor)', err) } },
  })
  let unsub: (() => void) | null = null
  const agent = new AgentActivityService(actor, deps.send)

  const autosave: AutosaveController = createAutosave({
    actor,
    fs: deps.fs,
    workspaceDir: deps.workspaceDir,
    join: deps.join,
    serialize: serializeProjectToJson,
  })

  const enqueueDerivatives = makeEnqueueDerivatives(deps.napi)
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
  // preserved original, or says plainly that there isn't one.
  const onSchemaUpgrade = (report: SchemaUpgradeReport): void => {
    try {
      deps.emitLog?.({
        level: 'warn',
        category: { kind: 'Project' },
        source: { kind: 'System' },
        message: report.backupFile
          ? `Project upgraded from schema v${report.from} to v${report.to}; the original is kept as ${report.backupFile}`
          : `Project upgraded from schema v${report.from} to v${report.to}; the original could NOT be preserved`,
        details: { kind: 'SchemaUpgrade', from: report.from, to: report.to, backup: report.backupFile },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (schema upgrade)', err) }
  }
  const relink = deps.relinkFs
    ? { fs: deps.relinkFs, join: deps.join, hashFile: (p: string) => deps.compute.hashMediaSource(p) }
    : undefined
  const orchestratorDeps = { actor, napi: deps.napi, fs: deps.fs, join: deps.join, idGen, enqueueDerivatives, relink, onRelink, onGridRepair, onSchemaUpgrade }

  // Hybrid orchestrator deps (native-compute → TS-write). enqueueDerivatives here
  // takes the inserted ITEMS (vs the orchestrator's whole-Project variant) and
  // hands them straight to the Backend's open-time job re-fan-out napi.
  const hybridDeps: HybridDeps = {
    actor,
    compute: deps.compute,
    enqueueDerivatives: async (items) => { await deps.napi.enqueueJobsForMedia(JSON.stringify(items)) },
    enqueueWorkspaceCopy: deps.enqueueWorkspaceCopy,
    workspaceDir: deps.workspaceDir,
    readFile: deps.readFile,
    statPath: deps.statPath,
    snapshotComposition: () => rootComposition(actor.snapshot()),
  }

  // Only state-replacing routes cross this gate. Save As preserves the current
  // actor snapshot and writes it directly to its new destination.
  const replaceWorkspace = async <T>(replace: () => Promise<T>): Promise<T> => {
    await autosave.forceFlush()
    return replace()
  }

  let opened: OpenedProject | null = null
  // Each record update runs only after its operation resolves, so a failed
  // open leaves the record as it was.
  const persistence: PersistenceHandlers = {
    open: async (dir) => { await replaceWorkspace(() => openProject(orchestratorDeps, dir)); opened = { dir } },
    saveAs: async (dir) => { await saveProjectAs(orchestratorDeps, dir); opened = { dir } },
    newWorkspace: async (a) => { const dir = await replaceWorkspace(() => newWorkspace(orchestratorDeps, a)); opened = { dir }; return dir },
    save: () => autosave.forceFlush(),
    // The actor keeps the closed project until the next Open / New replaces
    // it, and the workspace slot keeps its folder; what stops an agent writing
    // into it is the MCP gate reading `opened`.
    close: async () => { await autosave.forceFlush(); opened = null },
  }

  const agentProjects: TsActorHost['projects'] = {
    open: async (dir) => {
      const replaced = opened?.dir ?? null
      await persistence.open(dir)
      deps.send(PROJECT_OPENED_EVENT, { dir } satisfies ProjectOpenedPayload)
      return { name: actor.snapshot().metadata.name, dir, replaced }
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
   *  (install_motif, delete_motif, write_motif_draft, amend_motif_draft,
   *  create_edit_draft, import_motif). A refresh failure must never abort. */
  function refreshMotifCatalog(): void {
    deps.listMotifs?.().then((j) => {
      actor.setUserMotifManifests(manifestsFromList(JSON.parse(j) as unknown[]))
    }).catch(() => {})
  }

  function runMotif(name: string, args: Record<string, unknown>): unknown {
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
      readFile: deps.readFile,
      emitLog: (entry) => { try { deps.emitLog?.(entry) } catch (err) { console.warn('[ts-actor-host] emitLog failed (motif)', err) } },
    }
    return runMotifTool(name, args, motifToolDeps)
  }

  function emitChange(e: ChangeEvent): void {
    const payload = mapChangeEvent(e)
    deps.send('project:changed', payload)
    deps.mcpNotify(payload)
  }

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
        const r = actor.command(channel, args)
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
        return buildProjectSummary(actor.snapshot(), actor.historyStatus(), deps.fileExists)
      case 'historyView':
        // The panel wants the WHOLE stack, so the limit is the cap itself — asked
        // of the actor rather than restated here. MCP's `project://history`
        // (resource-views.ts) keeps its own view(100): different consumer, different need.
        return actor.historyView(actor.historyCapacity())
      case 'projectSettings':
        return actor.snapshot().settings
      case 'open': return persistence.open((args as { path: string }).path)
      case 'saveAs': return persistence.saveAs((args as { path: string }).path)
      case 'newWorkspace': return persistence.newWorkspace(args as never)
      case 'save': return persistence.save()
      case 'close': return persistence.close()
      case 'agentSessionEnd': agent.end('user'); return null
      // Compatibility for the old local channel: it now requests a view only.
      case 'agentSessionBegin': deps.send(AGENT_VIEW_EVENT, { workspace_id: agent.snapshot().workspace_id }); return null
      case 'hybrid': {
        const hybridResult = await runHybrid(route.tool, args, hybridDeps)
        return hybridResult
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

  return {
    actor,
    agent,
    openedProject: () => opened,
    projects: agentProjects,
    projectStatus: () => ({
      project: opened === null ? null : { name: actor.snapshot().metadata.name, dir: opened.dir },
      recent_projects: (deps.recents?.list() ?? []).map((e) => ({ name: e.name, path: e.path })),
      default_parent_folder: deps.recents?.lastNewProjectParent() ?? null,
    }),
    handleInvoke,
    mcpCall,
    hybridDeps,
    motifTool: runMotif,
    refreshMotifCatalog,
    start() {
      agent.start()
      if (!unsub) unsub = actor.subscribe(emitChange)
      autosave.start()
      refreshMotifCatalog()
    },
    stop() {
      agent.stop()
      autosave.stop()
      if (unsub) { unsub(); unsub = null }
    },
  }
}
