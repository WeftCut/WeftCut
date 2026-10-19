// @vitest-environment jsdom
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";

const mocks = vi.hoisted(() => ({ cancelComputeJob: vi.fn<(id: string) => Promise<boolean>>() }));
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  cancelComputeJob: mocks.cancelComputeJob,
}));

import { receiveComputeJobs } from "../compute/computeJobsStore";
import { useTranscribeRunStore } from "../speech/transcribeRun";
import type { ComputeJob, ComputePhase, ComputeTool } from "../ipc";
import { ComputeJobBands, jobBandRect } from "./ComputeJobBands";

let revision = 9_000_000;
const job = (over: Partial<ComputeJob> & { phase: ComputePhase; tool?: ComputeTool }): ComputeJob => ({
  job_id: "job-1",
  tool: "transcribe_clip",
  layer_id: "L1",
  media_id: "m1",
  window: { t_start_us: 2_000_000, t_end_us: 4_000_000 },
  phase_since: new Date().toISOString(),
  started_at: new Date().toISOString(),
  origin: { kind: "user" },
  callers: 1,
  caller_disconnected: false,
  request_ids: [],
  ...over,
});
const publish = (jobs: ComputeJob[]) => act(() => receiveComputeJobs({ revision: ++revision, jobs }));

/// A clip on [1 s, 9 s) of the composition at 100 px/s, 56 px tall: its left
/// edge is x = 0 and one pixel is 10 ms.
const renderBands = (over: { layerId?: string; loUs?: number; hiUs?: number; heightPx?: number; pxPerSec?: number } = {}) =>
  render(
    <ComputeJobBands
      layerId={over.layerId ?? "L1"}
      pxPerSec={over.pxPerSec ?? 100}
      blockLoUs={over.loUs ?? 1_000_000}
      blockHiUs={over.hiUs ?? 9_000_000}
      heightPx={over.heightPx ?? 56}
    />,
  );
const bands = () => screen.queryAllByTestId("compute-job-band");
const rect = (el: HTMLElement) => [Number.parseFloat(el.style.left), Number.parseFloat(el.style.width)];

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.cancelComputeJob.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  publish([]);
  useTranscribeRunStore.setState({ applying: null });
});

describe("jobBandRect", () => {
  it("places a window inside the clip relative to the clip's left edge", () => {
    expect(jobBandRect({ t_start_us: 2_000_000, t_end_us: 4_000_000 }, 1_000_000, 9_000_000, 100)).toEqual({ left: 100, width: 200 });
  });

  it("clips a window that overhangs either end to the clip as drawn", () => {
    expect(jobBandRect({ t_start_us: 0, t_end_us: 3_000_000 }, 1_000_000, 9_000_000, 100)).toEqual({ left: 0, width: 200 });
    expect(jobBandRect({ t_start_us: 8_000_000, t_end_us: 20_000_000 }, 1_000_000, 9_000_000, 100)).toEqual({ left: 700, width: 100 });
  });

  it("draws nothing for a window off the clip, and at least a pixel for a sliver", () => {
    expect(jobBandRect({ t_start_us: 9_000_000, t_end_us: 10_000_000 }, 1_000_000, 9_000_000, 100)).toBeNull();
    expect(jobBandRect({ t_start_us: 2_000_000, t_end_us: 2_001_000 }, 1_000_000, 9_000_000, 100)).toEqual({ left: 100, width: 1 });
  });
});

describe("ComputeJobBands", () => {
  it("draws nothing on a clip without a job", () => {
    publish([job({ layer_id: "other", phase: { kind: "loading_model" } })]);
    renderBands();
    expect(bands()).toHaveLength(0);
  });

  it("draws a working job over exactly its window, with the compact status and an icon Cancel", async () => {
    renderBands();
    publish([job({ phase: { kind: "inferring", done: 1, total: 4 } })]);
    const [band] = bands();
    expect(rect(band!)).toEqual([100, 200]);
    expect(band!.dataset.state).toBe("working");
    expect(band!.classList.contains("state-working")).toBe(true);
    const status = band!.querySelector<HTMLElement>(".compute-job-status")!;
    expect(status.classList.contains("variant-compact")).toBe(true);
    expect(status.textContent).toContain("Transcribing 25%");
    expect(status.querySelector(".compute-job-spin")).not.toBeNull();
    const cancel = screen.getByRole("button", { name: "Cancel transcription" });
    // Icon-only in the compact variant.
    expect(cancel.textContent).toBe("");
  });

  it("draws a queued job in the waiting style: muted, hourglass, no spinner", () => {
    renderBands();
    publish([job({ phase: { kind: "queued", reason: "budget" } })]);
    const [band] = bands();
    expect(band!.dataset.state).toBe("waiting");
    expect(band!.classList.contains("state-waiting")).toBe(true);
    expect(band!.querySelector(".lucide-hourglass")).not.toBeNull();
    expect(band!.querySelector(".compute-job-spin")).toBeNull();
    expect(band!.textContent).toContain("Waiting for resources");
  });

  it("puts the phase in a glyph's tooltip when the band is too narrow for the chip", () => {
    renderBands();
    // 0.5 s at 100 px/s = 50 px: under the chip's minimum.
    publish([job({ tool: "describe_clip", window: { t_start_us: 2_000_000, t_end_us: 2_500_000 }, phase: { kind: "extracting", done: 2, total: 8 } })]);
    const [band] = bands();
    expect(band!.querySelector(".compute-job-status")).toBeNull();
    const glyph = screen.getByTestId("compute-job-band-glyph");
    expect(glyph.title).toBe("Describing this range…\nSampling frames 2/8");
  });

  it("drops the chip on a half-height slice, keeping the tooltip", () => {
    renderBands({ heightPx: 28 });
    publish([job({ phase: { kind: "loading_model" } })]);
    expect(bands()[0]!.querySelector(".compute-job-status")).toBeNull();
    expect(screen.getByTestId("compute-job-band-glyph").title).toBe("Transcribing this range…\nLoading model");
  });

  it("cancels the job without the press reaching the clip", async () => {
    const onClipPointerDown = vi.fn();
    render(
      <div onPointerDown={onClipPointerDown}>
        <ComputeJobBands layerId="L1" pxPerSec={100} blockLoUs={1_000_000} blockHiUs={9_000_000} heightPx={56} />
      </div>,
    );
    publish([job({ phase: { kind: "normalizing" } })]);
    const cancel = screen.getByRole("button", { name: "Cancel transcription" });
    fireEvent.pointerDown(cancel);
    expect(onClipPointerDown).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    await act(async () => {});
    expect(mocks.cancelComputeJob).toHaveBeenCalledWith("job-1");
    // A press on the band itself is the clip's.
    fireEvent.pointerDown(bands()[0]!);
    expect(onClipPointerDown).toHaveBeenCalledTimes(1);
  });

  it("draws a clip whose captions are being written as Adding captions, over the whole clip, with no Cancel", () => {
    renderBands();
    act(() => useTranscribeRunStore.setState({ applying: ["L1"] }));
    const [band] = bands();
    expect(rect(band!)).toEqual([0, 800]);
    expect(band!.dataset.phase).toBe("applying");
    expect(band!.textContent).toContain("Adding captions");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not re-render a clip without a job when another clip's job changes phase", () => {
    const commits = { L1: 0, L2: 0 };
    render(
      <>
        <Profiler id="L1" onRender={() => { commits.L1 += 1; }}>
          <ComputeJobBands layerId="L1" pxPerSec={100} blockLoUs={1_000_000} blockHiUs={9_000_000} heightPx={56} />
        </Profiler>
        <Profiler id="L2" onRender={() => { commits.L2 += 1; }}>
          <ComputeJobBands layerId="L2" pxPerSec={100} blockLoUs={0} blockHiUs={1_000_000} heightPx={56} />
        </Profiler>
      </>,
    );
    const quiet = commits.L2;
    publish([job({ phase: { kind: "queued", reason: null } })]);
    publish([job({ phase: { kind: "loading_model" } })]);
    expect(commits.L1).toBeGreaterThan(1);
    expect(commits.L2).toBe(quiet);
  });
});
