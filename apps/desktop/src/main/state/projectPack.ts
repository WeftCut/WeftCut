// apps/desktop/src/main/state/projectPack.ts
//
// Pack project and Open packed project (ADR 0178): the one run at a time,
// its progress for the work pill, and its cancel. Which files a pack holds is
// `packFiles` (projectContent.ts); the archive bytes are the native
// `project_pack*` commands (native/src/commands/project_pack.rs).
import { PROJECT_FILE, schemaGate } from './persistence'
import { PACK_TOP_LEVEL, type PackEntry } from './projectContent'
import { WorkspaceFailure } from '../../shared/workspaceErrors'
import { portableFileName } from '../../shared/projectPath'
import { PACK_EXTENSION, PackFailure, type PackInspection, type PackJobProgress, type PackOutcome, type PackPlan } from '../../shared/projectPack'

/** The backend calls a run makes. */
export interface PackNative {
  invoke(cmd: string, argsJson: string): Promise<string>
  /** True when a live job of that id was found and stopped. */
  cancelComputeJob(jobId: string): boolean
}

/** The project a pack is made of. */
export interface PackSource { dir: string; name: string; motifIds: string[] }

export interface ProjectPackDeps {
  native: PackNative
  /** The open project as it stands, without writing anything; null with none
   *  open. */
  current(): PackSource | null
  /** Resolves once the imports into the open project have each landed their
   *  copy in Media/ or failed; rejects with the signal's reason when `signal`
   *  aborts first. */
  importsSettled(signal: AbortSignal): Promise<void>
  /** Writes what Save As writes before it copies (project.json, the font
   *  copies, the style TASTE.md extends), then answers the project as it
   *  stands; null with none open. */
  settle(): Promise<PackSource | null>
  list(dir: string, motifIds: readonly string[]): Promise<PackEntry[]>
  /** node:fs readFileSync (utf8). */
  readFile(path: string): string
  /** Bytes free for new files in the folder `dir`. */
  freeBytes(dir: string): Promise<number>
  /** The names in the folder `dir`; null when nothing is at `dir`. */
  readdir(dir: string): Promise<string[] | null>
  /** `ensureGitignore` (projectContent.ts) on the folder `dir`. */
  ensureGitignore(dir: string): void
  /** The app's open of a project folder, as Open… runs it. */
  open(dir: string): Promise<void>
  /** `PROJECT_PACK_PROGRESS_EVENT`. */
  progress(progress: PackJobProgress | null): void
  appVersion: string
  join(...parts: string[]): string
  basename(path: string): string
  newJobId(): string
}

/** The native reason a run stopped on a cancel (`PackError::Cancelled`, and
 *  the registry's own stop). */
const CANCELLED = 'cancelled'

const isCancelled = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error)).trim().endsWith(CANCELLED)

/** The schema version the project.json `text` declares; the open's own
 *  refusal (WorkspaceFailure) for text it cannot read or a version newer
 *  than this app. */
function schemaOf(text: string): number {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (error) {
    throw new WorkspaceFailure({ error: 'ProjectFileUnreadable', detail: String(error) })
  }
  return schemaGate(parsed)
}

interface Running {
  progress: PackJobProgress
  /** The native call is in flight, so a cancel goes to the registry. */
  native: boolean
  /** The registry took the cancel. */
  stopped: boolean
  /** Aborted by Cancel: ends a wait before the native call. */
  abort: AbortController
}

export interface ProjectPacker {
  plan(): Promise<PackPlan>
  pack(archive: string): Promise<PackOutcome<{ archive: string; files: number }>>
  inspect(archive: string): Promise<PackInspection>
  unpack(archive: string, parent: string): Promise<PackOutcome<{ dir: string }>>
  /** Stops the run; false when none runs. */
  cancel(): boolean
  /** A native `project_pack:progress` event. */
  nativeProgress(payload: unknown): void
}

export function createProjectPacker(deps: ProjectPackDeps): ProjectPacker {
  let running: Running | null = null

  const publish = () => deps.progress(running ? { ...running.progress } : null)

  /** Claims the one run, or refuses while another holds it. */
  function begin(kind: PackJobProgress['kind'], archive: string): Running {
    if (running) throw new PackFailure({ refusal: 'PackBusy' })
    running = {
      progress: { job_id: deps.newJobId(), kind, file: deps.basename(archive), done: 0, total: 0, cancelling: false },
      native: false,
      stopped: false,
      abort: new AbortController(),
    }
    publish()
    return running
  }

  function end(run: Running): void {
    if (running !== run) return
    running = null
    publish()
  }

  // LANDMINE: the registry learns the job id once the native call is running
  // on its thread, a moment after `invoke` returns. A cancel in that moment
  // finds no job, so it is sent again with each progress event until the
  // registry takes it.
  function stop(run: Running): void {
    if (run.native && !run.stopped) run.stopped = deps.native.cancelComputeJob(run.progress.job_id)
  }

  /** Runs the native command of `run`, or answers cancelled when Cancel came
   *  first or stopped it. */
  async function runNative(run: Running, cmd: string, args: Record<string, unknown>): Promise<PackOutcome<{ files: number }>> {
    if (run.progress.cancelling) return { outcome: 'cancelled' }
    run.native = true
    try {
      const answer = JSON.parse(await deps.native.invoke(cmd, JSON.stringify({ jobId: run.progress.job_id, ...args }))) as { files: number }
      return { outcome: 'done', files: answer.files }
    } catch (error) {
      if (run.progress.cancelling && isCancelled(error)) return { outcome: 'cancelled' }
      throw error
    } finally {
      run.native = false
    }
  }

  /** The pack's manifest and project.json, refusing what this app cannot
   *  open before anything is written. */
  async function read(archive: string) {
    let seen: { manifest: { files: unknown[] }; project_json: string; total_bytes: number }
    try {
      seen = JSON.parse(await deps.native.invoke('project_pack_inspect', JSON.stringify({ archive, allowedTop: PACK_TOP_LEVEL })))
    } catch (error) {
      throw new PackFailure({ refusal: 'NotAPack', detail: error instanceof Error ? error.message : String(error) })
    }
    schemaOf(seen.project_json)
    const name = (JSON.parse(seen.project_json) as { metadata?: { name?: unknown } }).metadata?.name
    return { files: seen.manifest.files.length, bytes: seen.total_bytes, name: typeof name === 'string' ? name : '' }
  }

  /** The folder an unpack of `archive` creates: the file's name without the
   *  pack extension, as a name every OS takes. */
  function folderName(archive: string): string {
    const base = deps.basename(archive)
    const stem = base.toLowerCase().endsWith(`.${PACK_EXTENSION}`) ? base.slice(0, -PACK_EXTENSION.length - 1) : base
    return portableFileName(stem, () => false)
  }

  return {
    async plan() {
      const project = deps.current()
      if (!project) throw new PackFailure({ refusal: 'NoProjectOpen' })
      const files = await deps.list(project.dir, project.motifIds)
      return {
        files: files.length,
        bytes: files.reduce((sum, f) => sum + f.size, 0),
        file_name: portableFileName(`${project.name}.${PACK_EXTENSION}`, () => false),
      }
    },

    async pack(chosen) {
      // Some save dialogs (GTK) keep a typed name as it is.
      const archive = chosen.toLowerCase().endsWith(`.${PACK_EXTENSION}`) ? chosen : `${chosen}.${PACK_EXTENSION}`
      const run = begin('pack', archive)
      try {
        const asked = deps.current()
        if (!asked) throw new PackFailure({ refusal: 'NoProjectOpen' })
        // A pack holds the folder only, so a file still on its way into
        // Media/ would be left out, its record naming the source outside.
        try { await deps.importsSettled(run.abort.signal) } catch (error) {
          if (run.abort.signal.aborted) return { outcome: 'cancelled' }
          throw error
        }
        const project = await deps.settle()
        if (!project) throw new PackFailure({ refusal: 'NoProjectOpen' })
        // The wait can be long, and another project may have opened meanwhile.
        if (project.dir !== asked.dir) return { outcome: 'cancelled' }
        const schemaVersion = schemaOf(deps.readFile(deps.join(project.dir, PROJECT_FILE)))
        const files = await deps.list(project.dir, project.motifIds)
        run.progress.total = files.reduce((sum, f) => sum + f.size, 0)
        publish()
        const done = await runNative(run, 'project_pack', {
          folder: project.dir, archive, files: files.map((f) => f.path), appVersion: deps.appVersion, schemaVersion,
        })
        return done.outcome === 'done' ? { outcome: 'done', archive, files: done.files } : done
      } finally {
        end(run)
      }
    },

    async inspect(archive) {
      const seen = await read(archive)
      return { name: seen.name, folder_name: folderName(archive), files: seen.files, bytes: seen.bytes }
    },

    async unpack(archive, parent) {
      const folder = folderName(archive)
      const dir = deps.join(parent, folder)
      const run = begin('unpack', archive)
      try {
        const seen = await read(archive)
        const names = await deps.readdir(dir)
        if (names !== null && names.length > 0) throw new PackFailure({ refusal: 'FolderNotEmpty', folder })
        const available = await deps.freeBytes(parent)
        if (available < seen.bytes) throw new PackFailure({ refusal: 'NotEnoughSpace', needed: seen.bytes, available })
        run.progress.total = seen.bytes
        publish()
        const done = await runNative(run, 'project_unpack', { folder: dir, archive, allowedTop: PACK_TOP_LEVEL })
        if (done.outcome === 'cancelled') return done
      } finally {
        end(run)
      }
      // A pack made before projects carried a .gitignore holds none.
      deps.ensureGitignore(dir)
      await deps.open(dir)
      return { outcome: 'done', dir }
    },

    cancel() {
      const run = running
      if (!run) return false
      if (!run.progress.cancelling) {
        run.progress.cancelling = true
        publish()
      }
      run.abort.abort()
      stop(run)
      return true
    },

    nativeProgress(payload) {
      const p = payload as { jobId?: unknown; done?: unknown; total?: unknown } | null
      const run = running
      if (!run || !p || p.jobId !== run.progress.job_id || typeof p.done !== 'number' || typeof p.total !== 'number') return
      if (run.progress.cancelling) stop(run)
      run.progress.done = p.done
      run.progress.total = p.total
      publish()
    },
  }
}
