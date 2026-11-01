import { resourceBlockError, type ExportAdmission, type ExportPlanRequest, type ExportResourceBlock } from '../shared/export-resources';

/** Owns one cancellable admission attempt. Native revisions close the lost-wake
 * race. A busy budget is waited out for as long as it takes: only the signal
 * ends the wait, and only `budget-too-small`, which no wait admits, refuses.
 * While it waits, the export is queued in the governor (`queue`), so no new
 * background work takes the capacity it waits for. */
export async function admitExport(request: ExportPlanRequest, deps: {
  tryPlan(options: number[], nativeEncoder: boolean): ExportAdmission;
  wait(revision: number): Promise<void>;
  release(id: number): void;
  waiting(block: ExportResourceBlock): void;
  /** Enter the governor's export queue; the returned function leaves it. */
  queue(): () => void;
}, signal: AbortSignal): Promise<{ id: number; index: number }> {
  let leave: (() => void) | undefined;
  let onAbort: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Export cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Abort can race a synchronous successful admission; release before returning.
  interrupted.catch(() => {});
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = deps.tryPlan(request.options, request.nativeEncoder);
      if (result.kind === 'admitted') {
        if (signal.aborted) { deps.release(result.id); signal.throwIfAborted(); }
        return result;
      }
      if (result.reason === 'budget-too-small') throw resourceBlockError(result);
      leave ??= deps.queue();
      deps.waiting(result);
      await Promise.race([deps.wait(result.revision), interrupted]);
    }
  } finally {
    leave?.();
    signal.removeEventListener('abort', onAbort!);
  }
}
