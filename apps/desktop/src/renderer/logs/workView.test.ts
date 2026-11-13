import { describe, expect, it } from "vitest";
import type { AgentActivity } from "../../shared/agent-activity";
import type { ComputeJob, ComputePhase } from "../../shared/compute-jobs";
import type { DerivativeJob } from "../state/derivativeJobsStore";
import { WORK_SHOW_AFTER_MS, workView } from "./workView";

const T0 = Date.parse("2026-01-02T03:04:05.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const LONG_AGO = T0 - 60_000;

const job = (id: string, phase: ComputePhase = { kind: "inferring", done: 1, total: 2 }, startedAt = LONG_AGO): ComputeJob => ({
  job_id: id, tool: "transcribe_clip", layer_id: `layer-${id}`, media_id: "m", window: { t_start_us: 0, t_end_us: 1 },
  phase, phase_since: iso(startedAt), started_at: iso(startedAt), origin: { kind: "user" },
  callers: 1, caller_disconnected: false, request_ids: [],
});

const call = (id: string, opts: { startedAt?: number; state?: AgentActivity["state"]; jobId?: string } = {}): AgentActivity => ({
  id, session_id: null, connection_id: null, client: "Claude", tool: "read_project", kind: "read",
  started_at: iso(opts.startedAt ?? LONG_AGO), ended_at: null, state: opts.state ?? "running", duration_ms: null,
  message: "read_project", affected: [], entity_labels: [], history_ids: [], effect: null, args: {}, error: null,
  ...(opts.jobId ? { compute: { job_id: opts.jobId, phase: { kind: "loading_model" }, phase_since: iso(LONG_AGO) } } : {}),
});

const derivative = (media_id: string, kind: string, since = LONG_AGO): DerivativeJob => ({ media_id, kind, since });

const view = (input: { jobs?: ComputeJob[]; activities?: AgentActivity[]; derivatives?: DerivativeJob[]; now?: number }) =>
  workView({ jobs: input.jobs ?? [], activities: input.activities ?? [], derivatives: input.derivatives ?? [], now: input.now ?? T0 });

describe("workView", () => {
  it("is empty with nothing running", () => {
    expect(view({})).toMatchObject({ count: 0, waiting: false, nextDueAt: null });
  });

  it("shows an agent call that runs a clip job once, as that job's row", () => {
    const v = view({ jobs: [job("j1")], activities: [call("a1", { jobId: "j1" })] });
    expect(v.compute.map((j) => j.job_id)).toEqual(["j1"]);
    expect(v.agent).toEqual([]);
    expect(v.count).toBe(1);
  });

  it("keeps an agent call whose job is not held back by the show delay under the job, not the agent", () => {
    const fresh = job("j1", undefined, T0);
    const v = view({ jobs: [fresh], activities: [call("a1", { jobId: "j1" })] });
    expect(v.count).toBe(0);
    expect(v.nextDueAt).toBe(T0 + WORK_SHOW_AFTER_MS);
  });

  it("lists an agent call whose job has ended under the agent while the call finishes", () => {
    expect(view({ activities: [call("a1", { jobId: "gone" })] }).agent.map((a) => a.id)).toEqual(["a1"]);
  });

  it("counts only running agent calls", () => {
    const v = view({ activities: [call("done", { state: "done" }), call("live")] });
    expect(v.agent.map((a) => a.id)).toEqual(["live"]);
  });

  it("holds back work until it has run for the show delay, and says when it comes due", () => {
    const quick = call("quick", { startedAt: T0 - 100 });
    const held = view({ activities: [quick] });
    expect(held.count).toBe(0);
    expect(held.nextDueAt).toBe(T0 - 100 + WORK_SHOW_AFTER_MS);
    expect(view({ activities: [quick], now: held.nextDueAt! }).count).toBe(1);
  });

  it("groups derivative jobs into one row per media item, shown once its oldest job is due", () => {
    const v = view({ derivatives: [
      derivative("a", "waveform", LONG_AGO + 10),
      derivative("b", "thumbnails", T0),
      derivative("a", "proxy", LONG_AGO),
    ] });
    expect(v.derivatives).toEqual([{ media_id: "a", kinds: ["proxy", "waveform"] }]);
    expect(v.count).toBe(1);
    expect(v.nextDueAt).toBe(T0 + WORK_SHOW_AFTER_MS);
  });

  it("is waiting only when every row is a queued clip job", () => {
    const queued = job("q", { kind: "queued", reason: "budget" });
    expect(view({ jobs: [queued] }).waiting).toBe(true);
    expect(view({ jobs: [queued, job("w")] }).waiting).toBe(false);
    expect(view({ jobs: [queued], derivatives: [derivative("a", "proxy")] }).waiting).toBe(false);
    expect(view({ jobs: [queued], activities: [call("a1")] }).waiting).toBe(false);
  });

  it("orders each group by start", () => {
    const v = view({ jobs: [job("late", undefined, LONG_AGO + 2), job("early", undefined, LONG_AGO + 1)] });
    expect(v.compute.map((j) => j.job_id)).toEqual(["early", "late"]);
  });
});
