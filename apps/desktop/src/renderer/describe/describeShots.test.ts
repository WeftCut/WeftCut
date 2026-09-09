// The sweep's three properties, none of which a Panel render can drive: the
// runs go out one at a time, the pass stops at the first refusal, and the stop
// button takes effect after the shot in flight.
//
// Serial-ness is the one worth a test of its own. `runDescribe` already refuses
// a second concurrent run, so a `Promise.all` version of this would not fail
// loudly — it would silently describe the first shot and drop the rest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  describeClip: vi.fn(),
  getMediaDescription: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  ...mocks,
}));

import i18n from "../i18n";
import {
  cancelDescribeShots,
  describeOneShot,
  describeShotRows,
  type DescribableShot,
} from "./describeShots";
import {
  resetDescriptionsStore,
  useDescriptionsStore,
} from "./descriptionsStore";

const SUBJECT = { layerId: "l-1", mediaId: "m-1", clipName: "reel.mp4" };

/// Shot `n`, one second long, on a clip whose source window starts at the
/// timeline's own zero — so the two clocks coincide and the assertions are
/// about the sweep rather than about a projection `shotRows` already pins.
function shot(index: number): DescribableShot {
  const start = index * 1_000_000;
  return {
    index,
    srcStartUs: start,
    srcEndUs: start + 1_000_000,
    tStartUs: start,
    tEndUs: start + 1_000_000,
  };
}

function answer(text: string) {
  return { backend: "qwen3_vl", model: "Qwen3VL-4B", segments: [{ t_start_us: 0, t_end_us: 1_000_000, text, tags: [] }] };
}

describe("describeShotRows", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    mocks.describeClip.mockReset().mockResolvedValue(answer("a hallway"));
    mocks.getMediaDescription.mockReset().mockResolvedValue(null);
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    resetDescriptionsStore();
  });
  afterEach(resetDescriptionsStore);

  it("runs one shot at a time, in order", async () => {
    // Each call resolves only once the next tick runs, and every call records
    // how many were in flight when it started. Anything but a run of 1s means
    // two spawns of a 2.5 GB local model were contending.
    let live = 0;
    const peak: number[] = [];
    mocks.describeClip.mockImplementation(async () => {
      live += 1;
      peak.push(live);
      await Promise.resolve();
      live -= 1;
      return answer("a hallway");
    });
    await describeShotRows([shot(0), shot(1), shot(2)], SUBJECT);
    expect(mocks.describeClip).toHaveBeenCalledTimes(3);
    expect(peak).toEqual([1, 1, 1]);
    expect(mocks.describeClip.mock.calls.map((c) => c[0].tStartUs)).toEqual([
      0, 1_000_000, 2_000_000,
    ]);
  });

  // The failures this path has are properties of the SETUP, not of a shot: run
  // two of thirty would fail for the same reason as run one, and the reviewer
  // would have to read the same sentence thirty times to find out.
  it("stops at the first refusal and keeps its sentence", async () => {
    mocks.describeClip
      .mockResolvedValueOnce(answer("a hallway"))
      .mockRejectedValueOnce(new Error("no video-understanding backend available"));
    await describeShotRows([shot(0), shot(1), shot(2)], SUBJECT);
    expect(mocks.describeClip).toHaveBeenCalledTimes(2);
    expect(useDescriptionsStore.getState().error).toContain(
      "no video-understanding backend available",
    );
    // The prose the first run landed stays — a stopped sweep is not a rollback.
    expect(useDescriptionsStore.getState().segments.get("m-1")).toHaveLength(1);
  });

  it("reports progress and clears it when the pass ends", async () => {
    const seen: Array<{ done: number; total: number } | null> = [];
    mocks.describeClip.mockImplementation(async () => {
      seen.push(useDescriptionsStore.getState().batch);
      return answer("a hallway");
    });
    await describeShotRows([shot(0), shot(1)], SUBJECT);
    // `done` counts FINISHED runs, so the first one sees 0 of 2.
    expect(seen).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
    ]);
    expect(useDescriptionsStore.getState().batch).toBeNull();
  });

  // The stop takes effect AFTER the shot in flight: the model run is a child
  // process with no cancel on the wire, so abandoning it would leave the engine
  // running and the row it answers for blank.
  it("stops after the shot in flight when cancelled", async () => {
    mocks.describeClip.mockImplementation(async () => {
      cancelDescribeShots();
      return answer("a hallway");
    });
    await describeShotRows([shot(0), shot(1), shot(2)], SUBJECT);
    expect(mocks.describeClip).toHaveBeenCalledTimes(1);
    expect(useDescriptionsStore.getState().batch).toBeNull();
  });

  // A cancel that outlived its sweep would silently kill the next one's first
  // shot — which is why the request is cleared on the way out AND on the way in.
  it("does not carry a cancel into the next pass", async () => {
    mocks.describeClip.mockImplementationOnce(async () => {
      cancelDescribeShots();
      return answer("a hallway");
    });
    await describeShotRows([shot(0), shot(1)], SUBJECT);
    expect(mocks.describeClip).toHaveBeenCalledTimes(1);
    await describeShotRows([shot(0), shot(1)], SUBJECT);
    expect(mocks.describeClip).toHaveBeenCalledTimes(3);
  });

  it("refuses a second pass while one is running", async () => {
    let second: Promise<void> | null = null;
    mocks.describeClip.mockImplementationOnce(async () => {
      second = describeShotRows([shot(5)], SUBJECT);
      return answer("a hallway");
    });
    await describeShotRows([shot(0)], SUBJECT);
    await second;
    expect(mocks.describeClip).toHaveBeenCalledTimes(1);
  });

  it("does nothing when handed no shots", async () => {
    await describeShotRows([], SUBJECT);
    expect(mocks.describeClip).not.toHaveBeenCalled();
    expect(useDescriptionsStore.getState().batch).toBeNull();
  });
});

describe("describeOneShot", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    mocks.describeClip.mockReset().mockResolvedValue(answer("a hallway"));
    mocks.getMediaDescription.mockReset().mockResolvedValue(null);
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    resetDescriptionsStore();
  });
  afterEach(resetDescriptionsStore);

  // The window is the ONLY thing a run states. Sampling, focus and language are
  // main's to inject from Settings → Video understanding, so a renderer that
  // sent any of them would be a second statement of a setting it does not own —
  // and the two surfaces could then disagree about which view was written.
  it("sends the window and no view parameters", async () => {
    await describeOneShot(shot(2), SUBJECT);
    expect(mocks.describeClip).toHaveBeenCalledWith({
      layerId: "l-1",
      tStartUs: 2_000_000,
      tEndUs: 3_000_000,
    });
  });

  it("names the shot in the log rows", async () => {
    await describeOneShot(shot(2), SUBJECT);
    expect(mocks.logEmit.mock.calls[0]?.[0]).toMatchObject({
      i18n_key: "log.describe_started",
      i18n_args: { clip: "reel.mp4 · shot 3" },
    });
  });

  it("answers the refusal's own sentence", async () => {
    mocks.describeClip.mockRejectedValue(new Error("layer l-1 not found"));
    expect(await describeOneShot(shot(0), SUBJECT)).toContain("layer l-1 not found");
  });
});
