import type { ExportSettings } from "../render/exportSettings";
import type { ListenLike } from "../render/exportReadiness";
import type { ExportState } from "../panels/ExportPanel";
import type { ExportOutcome } from "./runExportPipeline";

export interface ExportRunRequest {
  job_id: string;
  settings: ExportSettings;
  output_path: string;
  range: { startUs: number; endUs: number };
  agent: boolean;
}

export interface ExportJobStatus {
  job_id: string;
  state: "preparing" | "rendering" | "finalizing" | "completed" | "failed" | "cancelled";
  output_path: string;
  duration_us?: number;
  error?: string;
}

interface ControllerDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: ListenLike;
  run: (request: ExportRunRequest, signal: AbortSignal, onState: (state: ExportState) => void) => Promise<ExportOutcome>;
  onState: (state: ExportState | null) => void;
  onBegin: (request: ExportRunRequest) => void;
}

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/// Main admits both UI and agent requests. This bridge owns exactly one renderer
/// run, mirrors its phases to main, and waits for output publication before
/// displaying success. It has no React dependency and never opens dialogs.
export function createExportJobController(deps: ControllerDeps) {
  let mounted = false;
  let generation = 0;
  let unsubscribers: Array<() => void> = [];
  let ready = completion();
  let active: { id: string; controller: AbortController } | undefined;
  let displayedJobId: string | undefined;
  const completions = new Map<string, ReturnType<typeof completion>>();
  const outcomes = new Map<string, ExportJobStatus>();

  const doneFor = (id: string) => {
    let done = completions.get(id);
    if (!done) { done = completion(); completions.set(id, done); }
    return done;
  };
  const cancel = (id: string) => {
    void deps.invoke("export_job_cancel", { job_id: id }).catch((error: unknown) => {
      deps.onState({ kind: "error", detail: error instanceof Error ? error.message : String(error) });
    });
  };
  const displayTerminal = (status: ExportJobStatus) => {
    if (!mounted) return;
    if (status.state === "completed") {
      deps.onState({ kind: "complete", payload: { outputPath: status.output_path, durationUs: status.duration_us ?? 0 } });
    } else if (status.state === "cancelled") {
      deps.onState(null);
    } else {
      deps.onState({ kind: "error", detail: status.error ?? "Export failed." });
    }
  };

  async function run(request: ExportRunRequest) {
    if (active?.id === request.job_id || outcomes.has(request.job_id)) return;
    if (active) {
      const status = await deps.invoke<ExportJobStatus>("export_job_update", { job_id: request.job_id, state: "failed", error: "Renderer is already exporting." });
      outcomes.set(request.job_id, status);
      doneFor(request.job_id).resolve();
      return;
    }
    const controller = new AbortController();
    active = { id: request.job_id, controller };
    displayedJobId = request.job_id;
    doneFor(request.job_id);
    deps.onBegin(request);
    let updates = Promise.resolve<unknown>(undefined);
    let lastProgressAt = -Infinity;
    const update = (record: Record<string, unknown>) => {
      // Keep progress in order; a terminal state can never overtake queued frames.
      updates = updates.then(() => deps.invoke("export_job_update", { job_id: request.job_id, ...record }));
      // Attach immediately, even while render is still running, to avoid an
      // unhandled rejection if main disappears during a long export.
      void updates.catch(() => {});
      return updates;
    };
    const onCancel = () => cancel(request.job_id);
    const onState = (state: ExportState) => {
      if (!mounted || displayedJobId !== request.job_id) return;
      switch (state.kind) {
        case "starting":
          deps.onState({ ...state, onCancel });
          void update({ state: "preparing", phase: "starting" });
          break;
        case "preparing":
          deps.onState({ ...state, onCancel });
          void update({ state: "preparing", phase: "readiness" });
          break;
        case "progress": {
          deps.onState({ ...state, onCancel });
          const now = performance.now();
          if (now - lastProgressAt >= 100 || state.progress.progress >= 1) {
            lastProgressAt = now;
            void update({ state: "rendering", phase: "frames", progress: state.progress.progress });
          }
          break;
        }
        case "finalizing":
          deps.onState({ ...state, onCancel });
          void update({ state: "finalizing", phase: state.step });
          break;
        default: break; // the runner reports terminal outcome through its return
      }
    };
    try {
      onState({ kind: "starting" });
      const outcome = await deps.run(request, controller.signal, onState);
      // The runner has finished cleanup. Main still reserves admission while it
      // publishes, but can admit the next run before this IPC reply is delivered.
      active = undefined;
      const status = await update({
        state: outcome.state,
        ...(outcome.state === "completed" ? { duration_us: outcome.durationUs } : {}),
        ...(outcome.state === "failed" ? { error: outcome.error } : {}),
      }) as ExportJobStatus;
      outcomes.set(request.job_id, status);
      if (displayedJobId === request.job_id) displayTerminal(status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const fallback: ExportJobStatus = {
        job_id: request.job_id,
        state: controller.signal.aborted ? "cancelled" : "failed",
        output_path: request.output_path,
        error: detail,
      };
      const status = await deps.invoke<ExportJobStatus>("export_job_update", { ...fallback }).catch(() => fallback);
      outcomes.set(request.job_id, status);
      if (displayedJobId === request.job_id) displayTerminal(status);
    } finally {
      if (active?.id === request.job_id) active = undefined;
      doneFor(request.job_id).resolve();
      // Only finished jobs are evicted; retain an early completion until the
      // start IPC reply arrives (run events can arrive before that reply).
      if (completions.size > 32) {
        const oldest = completions.keys().next().value!;
        completions.delete(oldest);
        outcomes.delete(oldest);
      }
    }
  }

  return {
    get ready() { return ready.promise; },
    async mount() {
      if (mounted) return;
      mounted = true;
      const current = ++generation;
      const readyForMount = ready;
      try {
        const subscriptions = await Promise.all([
          deps.listen<ExportRunRequest>("export:run", (event) => { void run(event.payload); }),
          deps.listen<{ job_id: string }>("export:cancel", (event) => {
            if (active?.id === event.payload.job_id) active.controller.abort();
          }),
        ]);
        if (!mounted || current !== generation) {
          subscriptions.forEach((unsubscribe) => unsubscribe());
          return;
        }
        unsubscribers = subscriptions;
        await deps.invoke("export_job_ready", { ready: true });
        if (mounted && current === generation) readyForMount.resolve();
      } catch (error) {
        readyForMount.resolve(); // start then gets the main service's unavailable error
        throw error;
      }
    },
    async start(args: Record<string, unknown>) {
      if (!mounted) throw new Error("Export renderer is unavailable.");
      await ready.promise;
      if (!mounted) throw new Error("Export renderer is unavailable.");
      const status = await deps.invoke<ExportJobStatus>("export_job_start", args);
      if (status.state === "completed" || status.state === "failed" || status.state === "cancelled") {
        displayTerminal(status);
        return status;
      }
      await doneFor(status.job_id).promise;
      return outcomes.get(status.job_id) ?? status;
    },
    async dispose() {
      mounted = false;
      ++generation;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      unsubscribers = [];
      active?.controller.abort();
      ready.resolve();
      ready = completion();
      await deps.invoke("export_job_ready", { ready: false }).catch(() => {});
    },
  };
}
