// Packed projects (ADR 0178): the wire shapes of the pack and unpack channels
// between main (`main/state/projectPack.ts`) and the renderer
// (`renderer/pack/`). One pack or unpack runs at a time.

/** The extension of a pack file, without its dot. */
export const PACK_EXTENSION = 'weftcut'

/** The running pack or unpack, or null once it ended: bytes written of the
 *  run's total. */
export const PROJECT_PACK_PROGRESS_EVENT = 'project-pack:progress'

export interface PackJobProgress {
  job_id: string
  kind: 'pack' | 'unpack'
  /** The pack file's name, as the pill names the work. */
  file: string
  done: number
  total: number
  /** Cancel was pressed; the run is removing what it wrote. */
  cancelling: boolean
}

/** What a pack of the open project would hold now (`project_pack_plan`). */
export interface PackPlan {
  files: number
  bytes: number
  /** `<project name>.weftcut`, a name every OS takes. */
  file_name: string
}

/** What a pack file holds, read before anything is written
 *  (`project_unpack_inspect`). */
export interface PackInspection {
  /** The project's own name, from its project.json. */
  name: string
  /** The folder an unpack creates in the parent the user picks. */
  folder_name: string
  files: number
  bytes: number
}

/** How a pack or unpack ended. A cancel is the user's own and not a failure. */
export type PackOutcome<T> = ({ outcome: 'done' } & T) | { outcome: 'cancelled' }

/** Why a pack or unpack did not start, or failed on what it read. A schema
 *  newer than the app is the open's own refusal (`ProjectSchemaTooNew`,
 *  shared/workspaceErrors.ts), raised as that. */
export type PackRefusal =
  /** Another pack or unpack is running. */
  | { refusal: 'PackBusy' }
  | { refusal: 'NoProjectOpen' }
  /** The file is not a pack this app reads; `detail` is the reader's English
   *  reason. */
  | { refusal: 'NotAPack'; detail: string }
  /** The parent folder already holds a non-empty `folder`. */
  | { refusal: 'FolderNotEmpty'; folder: string }
  | { refusal: 'NotEnoughSpace'; needed: number; available: number }

/** Thrown by main to refuse; the message is the JSON, the only part of an
 *  Error that crosses IPC. */
export class PackFailure extends Error {
  constructor(readonly err: PackRefusal) {
    super(JSON.stringify(err))
    this.name = 'PackFailure'
  }
}

const REFUSALS: ReadonlySet<string> = new Set<PackRefusal['refusal']>(['PackBusy', 'NoProjectOpen', 'NotAPack', 'FolderNotEmpty', 'NotEnoughSpace'])

/** The refusal in an IPC rejection, read from the first `{` (Electron only
 *  prefixes the message); null for anything else. */
export function parsePackRefusal(err: unknown): PackRefusal | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : null
  const start = raw?.indexOf('{') ?? -1
  if (raw === null || start < 0) return null
  try {
    const parsed = JSON.parse(raw.slice(start)) as { refusal?: unknown }
    return typeof parsed?.refusal === 'string' && REFUSALS.has(parsed.refusal) ? parsed as PackRefusal : null
  } catch { return null }
}
