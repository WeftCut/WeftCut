import { describe, expect, it, vi } from "vitest";
import type { ExportState } from "../panels/ExportPanel";
import { DEFAULT_EXPORT_SETTINGS } from "../render/exportSettings";
import type { ExportOutcome } from "./runExportPipeline";
import { createExportJobController, type ExportRunRequest } from "./exportJobController";

const request: ExportRunRequest = {
  job_id: "export-test",
  settings: DEFAULT_EXPORT_SETTINGS,
  output_path: "/output/.render-partial.mp4",
  range: { startUs: 0, endUs: 1_000_000 },
  agent: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(run: (request: ExportRunRequest, signal: AbortSignal, onState: (state: ExportState) => void) => Promise<ExportOutcome>) {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const states: Array<ExportState | null> = [];
  const order: string[] = [];
  const publish = deferred<void>();
  let holdPublication = false;
  let failPublication = false;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    order.push(command);
    if (command === "export_job_start") {
      handlers.get("export:run")?.({ payload: request });
      return { job_id: request.job_id, state: "preparing", output_path: "/output/render.mp4" };
    }
    if (command === "export_job_update") {
      if (args?.state === "completed" && holdPublication) await publish.promise;
      return {
        ...args,
        output_path: "/output/render.mp4",
        ...(args?.state === "completed" && failPublication ? { state: "failed", error: "Destination exists." } : {}),
      };
    }
    if (command === "export_job_cancel") handlers.get("export:cancel")?.({ payload: { job_id: request.job_id } });
    return undefined;
  });
  const controller = createExportJobController({
    invoke: invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    listen: async <T>(event: string, handler: (event: { payload: T }) => void) => {
      order.push(`listen ${event}`);
      handlers.set(event, handler as (event: { payload: unknown }) => void);
      return () => { if (handlers.get(event) === handler) handlers.delete(event); };
    },
    run,
    onState: (state) => states.push(state),
    onBegin: vi.fn(),
  });
  return { controller, states, order, handlers, invoke, publish,
    holdPublication: () => { holdPublication = true; },
    failPublication: () => { failPublication = true; },
  };
}

describe("export job renderer bridge", () => {
  it("registers run and cancel listeners before declaring the renderer ready", async () => {
    const h = harness(async () => ({ state: "cancelled" }));
    await h.controller.mount();
    expect(h.order).toEqual(["listen export:run", "listen export:cancel", "export_job_ready"]);
    await h.controller.dispose();
    expect(h.handlers.size).toBe(0);
    expect(h.invoke).toHaveBeenLastCalledWith("export_job_ready", { ready: false });
  });

  it("waits for publication and displays its final path, including early run delivery", async () => {
    const h = harness(async () => ({ state: "completed", outputPath: request.output_path, durationUs: 1_000_000 }));
    h.holdPublication();
    await h.controller.mount();
    const starting = h.controller.start({ settings: DEFAULT_EXPORT_SETTINGS });
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("export_job_update", expect.objectContaining({ state: "completed" })));
    expect(h.states.some((state) => state?.kind === "complete")).toBe(false);
    h.publish.resolve();
    await starting;
    expect(h.states.at(-1)).toEqual({ kind: "complete", payload: { outputPath: "/output/render.mp4", durationUs: 1_000_000 } });
    await h.controller.dispose();
  });

  it("reports publication failure instead of promising a file that was not published", async () => {
    const h = harness(async () => ({ state: "completed", outputPath: request.output_path, durationUs: 1_000_000 }));
    h.failPublication();
    await h.controller.mount();
    await h.controller.start({});
    expect(h.states.at(-1)).toEqual({ kind: "error", detail: "Destination exists." });
    await h.controller.dispose();
  });

  it("lets the UI cancel a finalizing agent job and aborts the shared runner signal", async () => {
    let aborted = false;
    const h = harness(async (_request, signal, onState) => {
      onState({ kind: "finalizing", step: "audio" });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return { state: "cancelled" };
    });
    await h.controller.mount();
    const starting = h.controller.start({});
    await vi.waitFor(() => expect(h.states.at(-1)?.kind).toBe("finalizing"));
    const state = h.states.at(-1);
    if (state?.kind !== "finalizing") throw new Error("Expected finalizing state.");
    state.onCancel?.();
    await starting;
    expect(aborted).toBe(true);
    expect(h.states.at(-1)).toBeNull();
    expect(h.invoke).toHaveBeenCalledWith("export_job_update", expect.objectContaining({ state: "cancelled" }));
    await h.controller.dispose();
  });

  it("propagates runner exceptions to main and clears renderer admission", async () => {
    const h = harness(async () => { throw new Error("Worker stopped."); });
    await h.controller.mount();
    await h.controller.start({});
    expect(h.invoke).toHaveBeenCalledWith("export_job_update", expect.objectContaining({ state: "failed", error: "Worker stopped." }));
    expect(h.states.at(-1)).toEqual({ kind: "error", detail: "Worker stopped." });
    await h.controller.dispose();
  });

  it("settles an admission failure that never delivers a run event", async () => {
    const run = vi.fn(async (): Promise<ExportOutcome> => ({ state: "cancelled" }));
    const h = harness(run);
    await h.controller.mount();
    h.invoke.mockImplementationOnce(async () => ({ job_id: request.job_id, state: "failed", output_path: "/output/render.mp4", error: "Native engine unavailable." }));
    const status = await h.controller.start({});
    expect(status.state).toBe("failed");
    expect(run).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ kind: "error", detail: "Native engine unavailable." });
    await h.controller.dispose();
  });

  it("remounts during React StrictMode without leaving readiness unresolved", async () => {
    const h = harness(async () => ({ state: "cancelled" }));
    const firstMount = h.controller.mount();
    const disposal = h.controller.dispose();
    const secondMount = h.controller.mount();
    await Promise.all([firstMount, disposal, secondMount]);
    await h.controller.ready;
    await h.controller.start({});
    expect(h.states.at(-1)).toBeNull();
    await h.controller.dispose();
  });
});
