// The two things only this surface does, neither of which the run itself can be
// asked about: it reveals the Shots Panel BEFORE the model starts, and it acts
// on the one refusal that has a remedy.
//
// Both replaced a dialog. The reveal used to happen on success, because a modal
// held the window until then; the remedy used to be a button inside that modal.
// With no dialog, an unrevealed Panel means a run nobody can see, and a
// `LogEntry` cannot carry an action — so these are the assertions that keep the
// deletion honest.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  describeTarget: vi.fn(),
  runDescribe: vi.fn(),
}));

vi.mock("../describe/describeEligibility", async (importActual) => ({
  ...(await importActual<typeof import("../describe/describeEligibility")>()),
  describeTarget: mocks.describeTarget,
}));
vi.mock("../describe/describeRun", () => ({ runDescribe: mocks.runDescribe }));

import type { LayerSummary } from "../ipc";
import { describeSelected } from "./describeCommands";

const num = (value: number) => ({ mode: "Static" as const, value });

/// The trimmed clip the command answers for — `src_in_us` is not zero, so the
/// window assertion is about the layer's own source span and not about a
/// duration measured from the start of the file.
const LAYER = {
  id: "l-1",
  label: null,
  t_start_us: 5_000_000,
  t_end_us: 7_000_000,
  kind: "VideoClip",
  color_hint: "#4c8dd8",
  enabled: true,
  locked: false,
  effects: [],
  params: {
    kind: "VideoClip",
    media_id: "m-1",
    media_label: "reel.mp4",
    src_in_us: 3_000_000,
    src_out_us: 5_000_000,
    speed: 1,
    x: num(0),
    y: num(0),
    scale_x: num(1),
    scale_y: num(1),
    scale_linked: true,
    rotation_deg: num(0),
    opacity: num(1),
    anchor_x: num(0.5),
    anchor_y: num(0.5),
  },
} as unknown as LayerSummary;

function deps() {
  const order: string[] = [];
  return {
    order,
    revealShots: vi.fn(() => void order.push("reveal")),
    openSettings: vi.fn(() => void order.push("settings")),
  };
}

describe("describeSelected", () => {
  beforeEach(() => {
    mocks.describeTarget.mockReset().mockReturnValue(LAYER);
    mocks.runDescribe.mockReset().mockResolvedValue("");
  });

  // The ordering IS the feature. A reveal after the run would leave the twenty
  // rows that go busy hidden for the whole of it, and a run with no cancel on
  // the wire that shows nothing is a run nobody can tell from a dead app.
  it("reveals the Shots Panel before the run starts", async () => {
    const d = deps();
    mocks.runDescribe.mockImplementation(async () => {
      d.order.push("run");
      return "";
    });
    await describeSelected(d);
    expect(d.order).toEqual(["reveal", "run"]);
  });

  it("runs over the layer's whole SOURCE span and sends no window", async () => {
    const d = deps();
    await describeSelected(d);
    expect(mocks.runDescribe).toHaveBeenCalledWith({
      layerId: "l-1",
      mediaId: "m-1",
      srcStartUs: 3_000_000,
      srcEndUs: 5_000_000,
      window: null,
      label: expect.any(String),
    });
  });

  it("opens Settings on the one refusal that has a remedy", async () => {
    const d = deps();
    mocks.runDescribe.mockResolvedValue(
      "no video-understanding backend configured — configure one, then call describe_clip",
    );
    await describeSelected(d);
    expect(d.openSettings).toHaveBeenCalledTimes(1);
  });

  // Every other refusal already names what to go and do, and the status log
  // carries it verbatim. Opening a panel for one would be answering a question
  // the user did not ask.
  it("opens nothing for a refusal that names its own fix", async () => {
    const d = deps();
    mocks.runDescribe.mockResolvedValue(
      "layer l-1 has speed 2 — split a speed-1 segment off it first",
    );
    await describeSelected(d);
    expect(d.openSettings).not.toHaveBeenCalled();
  });

  it("does nothing at all with no target", async () => {
    const d = deps();
    mocks.describeTarget.mockReturnValue(null);
    await describeSelected(d);
    expect(d.revealShots).not.toHaveBeenCalled();
    expect(mocks.runDescribe).not.toHaveBeenCalled();
  });
});
