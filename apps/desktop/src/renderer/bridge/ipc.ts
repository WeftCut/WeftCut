// Core IPC bridge to the Electron main process (window.api). The renderer's
// backend calls in src/renderer/ipc/index.ts import { invoke } from here, which
// fronts the napi/Rust command dispatcher via `window.api.backend.invoke`.
// Specific main-process operations (fs/window/dialog/path/mcp/win/media) are
// named methods on window.api (see src/preload/index.ts) and have their own
// bridge wrappers (bridge/fs.ts, bridge/window.ts, …).
//
// convertFileSrc maps a filesystem path to a URL the renderer can load (the
// weftcut-media:// protocol served by main).

import type { WeftcutApi } from '../../shared/ipc'
import { EDIT_TRACE_ARG, EditTrace, editTraceId } from '../../shared/editTrace'
import { newEditTraceId, observeEditFrames } from '../diagnostics/editTrace'
import type { PublishedResult } from '../../shared/projectPublication'
import { awaitProjectPublication } from '../state/projectPublication'

declare global {
  interface Window {
    api: WeftcutApi
  }
}

type BackendInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>

type E2EInvokeInterceptor = <T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  next: BackendInvoke,
) => Promise<T>

/** Send a command to the napi/Rust backend dispatcher. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const traceId = newEditTraceId(cmd)
  if (traceId) {
    const trace = new EditTrace(traceId, `renderer.invoke.${cmd}`)
    observeEditFrames(traceId)
    return invokeBackend<T>(cmd, { ...args, [EDIT_TRACE_ARG]: traceId }).then(
      result => { trace.report(); return result },
      error => { trace.report(false); throw error },
    )
  }
  return invokeBackend<T>(cmd, args)
}

/** The edit succeeded in main; only its view barrier failed. Never retry the
 * command automatically: refresh the view instead. */
export class CommandPublicationError extends Error {
  readonly accepted = true
  constructor(readonly command: string, cause: unknown) {
    super('Edit accepted, but the view could not synchronize. Refresh the view before continuing; do not repeat the edit.', { cause })
    this.name = 'CommandPublicationError'
  }
}

function invokeBackend<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return intercept<T>(cmd, args, async <Result>(nextCmd: string, nextArgs?: Record<string, unknown>) => {
    const result = await window.api.backend.invokePublished(nextCmd, nextArgs) as PublishedResult<Result>
    if (result.publication) {
      // Startup opens the workspace before App mounts its mirror. The initial
      // seed owns readiness there; ordinary edits always require a live owner.
      const createsTimelineProject = nextCmd === 'project_import_timeline' && nextArgs?.destination != null
      try { await awaitProjectPublication(result.publication,
        nextCmd === 'project_open' || nextCmd === 'project_new_workspace' || nextCmd === 'project_startup_open' || createsTimelineProject,
        editTraceId(nextArgs?.[EDIT_TRACE_ARG])) }
      catch (error) { throw new CommandPublicationError(nextCmd, error) }
    }
    return result.value
  })
}

/** Projection reads must bypass the command barrier they are satisfying. */
export function invokeRaw<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return intercept<T>(cmd, args, <Result>(nextCmd: string, nextArgs?: Record<string, unknown>) =>
    window.api.backend.invoke(nextCmd, nextArgs) as Promise<Result>)
}

function intercept<T>(cmd: string, args: Record<string, unknown> | undefined, next: BackendInvoke): Promise<T> {
  // The E2E build may intercept a renderer → backend call to deterministically
  // hold/reorder responses. Production builds fold this branch away.
  if (import.meta.env.VITE_WEFTCUT_E2E === '1') {
    const interceptor = (
      globalThis as typeof globalThis & {
        __weftcutE2EBackendInvokeInterceptor?: E2EInvokeInterceptor
      }
    ).__weftcutE2EBackendInvokeInterceptor
    if (interceptor) return interceptor<T>(cmd, args, next)
  }

  return next<T>(cmd, args)
}

export function convertFileSrc(filePath: string): string {
  // Electron custom protocol served by protocol.handle('weftcut-media') in main,
  // with HTTP Range support.
  return `weftcut-media://localhost/${encodeURIComponent(filePath)}`
}
