import { describe, expect, it } from "vitest";
import {
  anyRunning,
  ENDED_CAPACITY,
  jobForLayer,
  jobForRequest,
  jobIdForRequest,
  jobsForMedia,
  reduceComputeJobs,
  type ComputeJobsState,
} from "./computeJobsStore";
import type { ComputeJob, ComputeJobEnded } from "../ipc";

const EMPTY: ComputeJobsState = { revision: -1, jobs: {}, ended: [], requests: {} };

function job(id: string, over: Partial<ComputeJob> = {}): ComputeJob {
  return {
    job_id: id, tool: "transcribe_clip", layer_id: "l1", media_id: "m1",
    window: { t_start_us: 0, t_end_us: 1_000_000 },
    phase: { kind: "queued", reason: null }, phase_since: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z", origin: { kind: "user" },
    callers: 1, caller_disconnected: false, request_ids: [], ...over,
  };
}
const ended = (j: ComputeJob, outcome: ComputeJobEnded["outcome"] = "ok"): ComputeJobEnded =>
  ({ job: j, outcome, error: null, ended_at: "2026-01-01T00:00:09.000Z" });

describe("reduceComputeJobs", () => {
  it("replaces the running set with each newer update and ignores a stale one", () => {
    const one = reduceComputeJobs(EMPTY, { revision: 3, jobs: [job("a"), job("b")] });
    expect(Object.keys(one.jobs)).toEqual(["a", "b"]);
    const two = reduceComputeJobs(one, { revision: 4, jobs: [job("b")], ended: [ended(job("a"))] });
    expect(Object.keys(two.jobs)).toEqual(["b"]);
    expect(two.ended.map((e) => e.job.job_id)).toEqual(["a"]);
    // A late snapshot older than what is held changes nothing.
    expect(reduceComputeJobs(two, { revision: 3, jobs: [job("a"), job("b")] })).toBe(two);
  });

  it("indexes request tags and keeps them past the job's end", () => {
    const running = reduceComputeJobs(EMPTY, { revision: 1, jobs: [job("a", { request_ids: ["r1"] })] });
    expect(jobForRequest(running, "r1")?.job_id).toBe("a");
    // A human press that JOINED an agent's job finds that job too.
    const joined = reduceComputeJobs(running, { revision: 2, jobs: [job("a", { request_ids: ["r1", "r2"], origin: { kind: "agent", client: "claude" } })] });
    expect(jobForRequest(joined, "r2")?.job_id).toBe("a");
    const done = reduceComputeJobs(joined, { revision: 3, jobs: [], ended: [ended(joined.jobs.a!, "cancelled")] });
    expect(jobForRequest(done, "r1")).toBeNull();
    expect(jobIdForRequest(done, "r1")).toBe("a");
    expect(jobIdForRequest(done, "nope")).toBeNull();
  });

  it("bounds the ended list and drops request tags of jobs it no longer holds", () => {
    let s = reduceComputeJobs(EMPTY, { revision: 0, jobs: [], ended: [ended(job("first", { request_ids: ["r-first"] }))] });
    for (let i = 0; i < ENDED_CAPACITY; i++) s = reduceComputeJobs(s, { revision: i + 1, jobs: [], ended: [ended(job(`j${i}`))] });
    expect(s.ended).toHaveLength(ENDED_CAPACITY);
    expect(s.ended[0]!.job.job_id).toBe("j0");
    expect(jobIdForRequest(s, "r-first")).toBeNull();
  });
});

describe("selectors", () => {
  const s = reduceComputeJobs(EMPTY, {
    revision: 1,
    jobs: [
      job("t", { started_at: "2026-01-01T00:00:02.000Z" }),
      job("d", { tool: "describe_clip", window: { t_start_us: 2_000_000, t_end_us: 3_000_000 }, started_at: "2026-01-01T00:00:01.000Z" }),
      job("x", { layer_id: "l2", media_id: "m2" }),
    ],
  });

  it("finds a layer's job by tool and by overlapping window", () => {
    expect(jobForLayer(s, "l1", { tool: "describe_clip" })?.job_id).toBe("d");
    expect(jobForLayer(s, "l1", { window: { t_start_us: 2_500_000, t_end_us: 4_000_000 } })?.job_id).toBe("d");
    expect(jobForLayer(s, "l1", { tool: "transcribe_clip", window: { t_start_us: 5_000_000, t_end_us: 6_000_000 } })).toBeNull();
    expect(jobForLayer(s, "nope")).toBeNull();
  });

  it("lists a media's jobs oldest first and answers whether a tool is running", () => {
    expect(jobsForMedia(s, "m1").map((j) => j.job_id)).toEqual(["d", "t"]);
    expect(anyRunning(s, "describe_clip")).toBe(true);
    expect(anyRunning(reduceComputeJobs(s, { revision: 2, jobs: [] }), "transcribe_clip")).toBe(false);
  });
});
