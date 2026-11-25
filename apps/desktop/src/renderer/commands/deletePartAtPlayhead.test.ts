// The renderer half of Delete start to playhead / Delete end from playhead:
// which layers it hands the actor, and where the playhead goes after. The
// edit itself is the actor's (`main/state/__tests__/ripple-delete-part.test.ts`);
// the IPC call is intercepted here and answers as the actor would.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { frameGrid, snapOnGrid } from "../grid";
import type { LayerSummary, TrackSummary } from "../ipc";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection } from "../state/selectionStore";
import { summaryFixture } from "../testing/summaryFixture";
import { deleteEndFromPlayhead, deleteStartToPlayhead } from "./deletePartAtPlayhead";

const sent = vi.fn(
  async (_args: { layerIds: string[]; atTUs: number; part: "start" | "end"; escapeLink: boolean }) => ({ at_t_us: 0 }),
);
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, rippleDeletePart: (args: Parameters<typeof sent>[0]) => sent(args) };
});

const S = 1_000_000;

function layer(id: string, tStartUs: number, tEndUs: number): LayerSummary {
  return {
    id, kind: "Color", label: id, t_start_us: tStartUs, t_end_us: tEndUs, enabled: true, locked: false,
    color_hint: "#888", params: { kind: "Color" } as LayerSummary["params"], effects: [],
  };
}

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return { id, kind: "Video", label: id, enabled: true, locked: false, muted: false, solo: false, role: "a-roll", transient: false, layers };
}

/// One lane: `before` on [0, 2 s), `clip` on [2 s, 6 s).
beforeEach(() => {
  useProjectStore.getState().apply(summaryFixture({
    root: { duration_us: 10 * S, tracks: [track("t", [layer("before", 0, 2 * S), layer("clip", 2 * S, 6 * S)])] },
  }));
});

afterEach(() => {
  sent.mockClear();
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

describe("delete start / end at the playhead", () => {
  it("sends the clip under the playhead and the cut, and after the start goes moves the playhead to where the actor says the cut now is", async () => {
    setPlayheadTimeUs(3 * S);
    sent.mockResolvedValueOnce({ at_t_us: 2 * S });
    await deleteStartToPlayhead();
    expect(sent.mock.calls.map(([args]) => args)).toEqual([{ layerIds: ["clip"], atTUs: 3 * S, part: "start", escapeLink: false }]);
    expect(playheadTimeUs()).toBe(2 * S);
  });

  it("leaves the playhead at the cut after the end goes", async () => {
    setPlayheadTimeUs(3 * S);
    sent.mockResolvedValueOnce({ at_t_us: 3 * S });
    await deleteEndFromPlayhead();
    expect(sent.mock.calls.map(([args]) => args.part)).toEqual(["end"]);
    expect(playheadTimeUs()).toBe(3 * S);
  });

  // Under playback the playhead runs between frames. The composition reads it
  // on its frame grid with the actor's rounding, so targets and cut agree: a
  // playhead that rounds onto the clip's edge cuts nothing there.
  it("cuts on the frame the playhead rounds to, and does nothing when that frame is the clip's edge", async () => {
    const frame = S / 30;
    setPlayheadTimeUs(2 * S + frame / 3);
    await deleteStartToPlayhead();
    await deleteEndFromPlayhead();
    expect(sent).not.toHaveBeenCalled();

    setPlayheadTimeUs(6 * S - frame / 3);
    await deleteStartToPlayhead();
    expect(sent).not.toHaveBeenCalled();

    setPlayheadTimeUs(2 * S + (2 * frame) / 3);
    sent.mockResolvedValueOnce({ at_t_us: 2 * S });
    await deleteStartToPlayhead();
    expect(sent.mock.calls.map(([args]) => args.atTUs)).toEqual([snapOnGrid(2 * S + frame, frameGrid({ num: 30, den: 1 }))]);
  });

  it.each([
    ["on a clip's edge", 2 * S],
    ["over nothing", 8 * S],
  ])("does nothing %s", async (_case, tUs) => {
    setPlayheadTimeUs(tUs);
    await deleteStartToPlayhead();
    await deleteEndFromPlayhead();
    expect(sent).not.toHaveBeenCalled();
    expect(playheadTimeUs()).toBe(tUs);
  });
});
