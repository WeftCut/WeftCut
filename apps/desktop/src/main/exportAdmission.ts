import { resourceBlockError, type ExportAdmission, type ExportPlanRequest, type ExportResourceBlock } from '../shared/export-resources';

/** Owns one cancellable admission attempt. Native revisions close the lost-wake
 * race; the deadline is a recoverable busy result, not an encoder failure. */
export async function admitExport(request: ExportPlanRequest, deps: {
  tryPlan(options: number[], nativeEncoder: boolean): ExportAdmission;
  wait(revision: number): Promise<void>;
  release(id: number): void;
  waiting(block: ExportResourceBlock): void;
}, signal: AbortSignal, timeoutMs = 15_000): Promise<{ id: number; index: number }> {
  let last: ExportResourceBlock | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Export cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(last ? resourceBlockError(last) : new Error('Export admission timed out')), timeoutMs);
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
      last = result;
      if (result.reason === 'budget-too-small') throw resourceBlockError(result);
      deps.waiting(result);
      await Promise.race([deps.wait(result.revision), interrupted]);
    }
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', onAbort!);
  }
}
