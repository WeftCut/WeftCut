import { phaseText, type ComputeJob } from '../../shared/compute-jobs'
import type { ComputeCaller } from '../compute/jobs'

/** The slice of the SDK's `RequestHandlerExtra` a clip-compute call reads. */
interface HandlerExtra {
  signal?: AbortSignal
  sendNotification?: (n: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>
  _meta?: { progressToken?: string | number }
}

/** Split the SDK's one handler signal into the two the registry needs.
 *
 *  The SDK aborts every in-flight handler when the transport closes, as well
 *  as on the client's `notifications/cancelled`, and only the second is a
 *  cancel: a client that went away leaves its job running so a retry can join
 *  it (ADR 0121). The close clears the server's transport right after
 *  aborting, so an abort is a cancel only if the transport is still there once
 *  that has had its turn — the shim's own rule (`cli/shim.ts` `explicitCancel`). */
export function splitAbort(signal: AbortSignal | undefined, closed: () => boolean): { cancel: AbortSignal; disconnected: AbortSignal } {
  const cancel = new AbortController(), disconnected = new AbortController()
  const classify = (): void => {
    queueMicrotask(() => { if (closed()) disconnected.abort(signal?.reason); else cancel.abort(signal?.reason) })
  }
  if (signal?.aborted) classify()
  else signal?.addEventListener('abort', classify, { once: true })
  return { cancel: cancel.signal, disconnected: disconnected.signal }
}

/** One agent tool call as a registry caller: explicit cancel vs disconnect,
 *  and — when the request carried a `progressToken` — a progress notification
 *  on attach, on every phase change and on every heartbeat. `progress` counts
 *  notifications, so it only grows; `message` is the phase in English.
 *  `onPhase` is the host's own hook (the Activity row). */
export function mcpComputeCaller(opts: {
  extra: unknown
  closed: () => boolean
  client: string
  onPhase?: ComputeCaller['onPhase']
}): ComputeCaller {
  const extra = (opts.extra ?? {}) as HandlerExtra
  const { cancel, disconnected } = splitAbort(extra.signal, opts.closed)
  const token = extra._meta?.progressToken
  let progress = 0
  const notify = (job: ComputeJob): void => {
    if (token === undefined || !extra.sendNotification) return
    progress++
    const params = { progressToken: token, progress, message: phaseText(job.phase) }
    Promise.resolve().then(() => extra.sendNotification!({ method: 'notifications/progress', params }))
      .catch(() => { /* the stream may have gone; the job does not care */ })
  }
  return {
    signal: cancel, disconnected, client: opts.client,
    onPhase: (job, cause) => {
      notify(job)
      opts.onPhase?.(job, cause)
    },
  }
}
