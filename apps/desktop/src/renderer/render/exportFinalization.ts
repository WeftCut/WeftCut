/** A completed encode is immutable. Retrying only consumes these files; it
 * never consults the current project or starts an encoder again. */
export function createExportFinalization(deps: {
  mux: () => Promise<void>;
  cleanup: () => Promise<void>;
  onRunning: () => void;
  onFailure: (detail: string) => void;
  onComplete: () => void;
}) {
  let busy = false;
  let discarded = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await deps.cleanup();
  };
  return {
    async retry() {
      if (busy || discarded || cleaned) return;
      busy = true;
      deps.onRunning();
      try {
        await deps.mux();
        await cleanup();
        if (!discarded) deps.onComplete();
      } catch (error) {
        if (!discarded) deps.onFailure(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        if (discarded) await cleanup();
      }
    },
    async discard() {
      discarded = true;
      // A running ffmpeg still reads the files. Cleanup follows its settlement.
      if (!busy) await cleanup();
    },
  };
}
