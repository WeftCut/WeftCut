import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { TFunction } from "i18next";
import type { ComputeJob, LayerSummary } from "../ipc";
import { reduceComputeJobs, type ComputeJobsState } from "./computeJobsStore";
import { jobOverSourceSpan, jobSourceSpan } from "./jobSourceSpan";
import { runPhaseHint } from "./runPhaseHint";

const layer = (id: string, tStartUs: number, srcInUs: number, rate?: number): LayerSummary =>
  ({
    id,
    t_start_us: tStartUs,
    t_end_us: tStartUs + 10_000_000,
    kind: "VideoClip",
    params: {
      kind: "VideoClip",
      media_id: "m1",
      src_in_us: srcInUs,
      src_out_us: srcInUs + 10_000_000,
      ...(rate === undefined ? {} : { time_map: { kind: "Affine", rate: { num: rate, den: 1 } } }),
    },
  }) as unknown as LayerSummary;

const job = (id: string, over: Partial<ComputeJob>): ComputeJob => ({
  job_id: id,
  tool: "describe_clip",
  layer_id: "L1",
  media_id: "m1",
  window: { t_start_us: 0, t_end_us: 0 },
  phase: { kind: "loading_model" },
  phase_since: "2026-10-19T00:00:00Z",
  started_at: `2026-10-19T00:00:0${id.length}Z`,
  origin: { kind: "user" },
  callers: 1,
  caller_disconnected: false,
  request_ids: [],
  ...over,
});

const state = (jobs: ComputeJob[]): ComputeJobsState =>
  reduceComputeJobs({ revision: -1, jobs: {}, ended: [], requests: {} }, { revision: 1, jobs });

describe("jobSourceSpan", () => {
  it("maps a timeline window through the layer's head and in-point", () => {
    expect(jobSourceSpan({ window: { t_start_us: 3_000_000, t_end_us: 5_000_000 } }, layer("L1", 1_000_000, 2_000_000)))
      .toEqual({ srcStartUs: 4_000_000, srcEndUs: 6_000_000 });
  });

  it("follows a re-timed layer's rate", () => {
    expect(jobSourceSpan({ window: { t_start_us: 2_000_000, t_end_us: 3_000_000 } }, layer("L1", 1_000_000, 0, 2)))
      .toEqual({ srcStartUs: 2_000_000, srcEndUs: 4_000_000 });
  });
});

describe("jobOverSourceSpan", () => {
  const layers = new Map([
    ["L1", layer("L1", 1_000_000, 0)],
    // Another clip of the same source, later on the timeline and later in it.
    ["L2", layer("L2", 20_000_000, 5_000_000)],
  ]);
  const q = { tool: "describe_clip" as const, mediaId: "m1", srcStartUs: 6_000_000, srcEndUs: 8_000_000 };

  it("finds a job on another clip of the same source by its source span", () => {
    const s = state([job("a", { layer_id: "L2", window: { t_start_us: 21_000_000, t_end_us: 22_000_000 } })]);
    // L2's 21–22 s is source 6–7 s.
    expect(jobOverSourceSpan(s, layers, q)?.job_id).toBe("a");
  });

  it("ignores a job that does not reach the span, another source, another tool, or a layer gone", () => {
    const s = state([
      job("a", { window: { t_start_us: 1_000_000, t_end_us: 7_000_000 } }), // source 0–6 s: touches, not overlaps
      job("bb", { media_id: "m2", window: { t_start_us: 0, t_end_us: 20_000_000 } }),
      job("ccc", { tool: "transcribe_clip", window: { t_start_us: 0, t_end_us: 20_000_000 } }),
      job("dddd", { layer_id: "gone", window: { t_start_us: 0, t_end_us: 20_000_000 } }),
    ]);
    expect(jobOverSourceSpan(s, layers, q)).toBeNull();
  });

  it("answers the oldest of several overlapping jobs", () => {
    const s = state([
      job("later", { window: { t_start_us: 0, t_end_us: 20_000_000 } }),
      job("a", { layer_id: "L2", window: { t_start_us: 20_000_000, t_end_us: 25_000_000 } }),
    ]);
    expect(jobOverSourceSpan(s, layers, q)?.job_id).toBe("a");
  });
});

describe("runPhaseHint", () => {
  const t = i18n.t.bind(i18n) as TFunction;
  it("says the job's phase in full, the write-back after it, and nothing between", async () => {
    await i18n.changeLanguage("en-US");
    expect(runPhaseHint(t, "transcribe_clip", { phase: { kind: "queued", reason: "memory" } })).toBe("Waiting for memory to free up");
    expect(runPhaseHint(t, "describe_clip", { phase: { kind: "queued", reason: "budget" } }))
      .toBe("Waiting for processing capacity — background work such as proxy generation is using it");
    expect(runPhaseHint(t, "transcribe_clip", null, true)).toBe("Adding captions");
    expect(runPhaseHint(t, "transcribe_clip", null)).toBeNull();
  });
});
