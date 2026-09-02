// @vitest-environment jsdom
//
// The Panel's three states, its one deliberate scan, and where a row click
// seeks. Real stores throughout — the subject is resolved from the selection,
// the project summary and the composition anchor, and mocking those away would
// leave the resolution itself untested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Partial, for `MarkerPanel.test.tsx`'s reason: the composition switch under
// test runs the REAL `openComposition`, which calls back into navigation.
vi.mock("../state/navigation", async (importActual) => ({
  ...(await importActual<typeof import("../state/navigation")>()),
  jumpToTimeUs: vi.fn(),
}));

const shots = vi.hoisted(() => ({
  shotFloorReportCached: vi.fn<(id: string) => Promise<boolean>>(),
  analyzeShotsFloor: vi.fn(),
  reduceShotReport: vi.fn(),
  shotDefaultOpts: vi.fn(),
  shotFloorSensitivity: vi.fn(),
  getMediaFrame: vi.fn<(id: string, tUs: number) => Promise<string>>(),
  logEmit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  ...shots,
}));

import "../i18n"; // side effect: init global i18next (en-US fallback)
import i18n from "../i18n";
import { jumpToTimeUs } from "../state/navigation";
import {
  focusedCompositionId,
  openComposition,
  useCompositionAnchorStore,
} from "../state/compositionAnchorStore";
import { useProjectStore } from "../state/projectStore";
import { setLayerSelection } from "../state/selectionStore";
import { registerTimelinePanels } from "../workspace/timelinePanels";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
  ROOT_ID,
} from "../testing/summaryFixture";
import type {
  AnimTrack,
  LayerSummary,
  ProjectSummary,
  ShotReport,
  TrackSummary,
} from "../ipc";
import { resetShotsStore } from "./shotsStore";
import { ShotsPanel } from "./ShotsPanel";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });

function clip(over: {
  id: string;
  mediaId: string;
  tStartUs: number;
  srcInUs?: number;
  srcOutUs?: number;
}): LayerSummary {
  const srcInUs = over.srcInUs ?? 0;
  const srcOutUs = over.srcOutUs ?? 6_000_000;
  return {
    id: over.id,
    label: "shot reel",
    t_start_us: over.tStartUs,
    t_end_us: over.tStartUs + (srcOutUs - srcInUs),
    kind: "VideoClip",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: over.mediaId,
      media_label: "reel.mp4",
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      x: num(0), y: num(0), scale_x: num(1), scale_y: num(1), scale_linked: true,
      rotation_deg: num(0), anchor_x: num(0.5), anchor_y: num(0.5), opacity: num(1),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    },
  };
}

function textLayer(): LayerSummary {
  return {
    id: "text-1",
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "Text",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Text",
      content: "title",
      font_family: "sans",
      font_size_px: 48,
      weight: 400,
      italic: false,
      align: "Left",
      anchor_x: num(0.5), anchor_y: num(0.5),
      color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
      x: num(0), y: num(0), scale_x: num(1), scale_y: num(1), scale_linked: true,
      rotation_deg: num(0), opacity: num(1),
      box_w: null, box_h: null,
      outline_width_px: 0,
      outline_color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
      shadow_dx_px: 0, shadow_dy_px: 0, shadow_blur_px: 0,
      shadow_color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
      line_height: 1.2, letter_spacing_px: 0,
      fade_in_us: 0, fade_out_us: 0,
    },
  } as unknown as LayerSummary;
}

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

/// Root at 30 fps holding the reviewed clip and a Text layer, plus a Group whose
/// clip starts at 2 s. The Group's `src_in_us` is 0, so Group-local time is root
/// time MINUS 2 s — which is what makes the "seeks on the Group's clock" test
/// about the routing rather than an arithmetic coincidence.
function fixture(): ProjectSummary {
  return summaryFixture({
    root: {
      duration_us: 20_000_000,
      tracks: [
        track("t1", [clip({ id: "l1", mediaId: "m1", tStartUs: 1_000_000 })]),
        track("t2", [textLayer()]),
        track("t3", [
          groupLayerFixture({
            id: "lg",
            compositionId: "g1",
            tStartUs: 2_000_000,
            tEndUs: 8_000_000,
            srcOutUs: 6_000_000,
          }),
        ]),
      ],
    },
    groups: [
      compositionFixture({
        id: "g1",
        duration_us: 6_000_000,
        tracks: [track("gt1", [clip({ id: "lg1", mediaId: "m2", tStartUs: 0 })])],
      }),
    ],
  });
}

/// A scanned source with one interior candidate at 2 s.
const REPORT: ShotReport = {
  shots: [
    {
      index: 0,
      t_start_us: 0,
      t_end_us: 2_000_000,
      keyframe_t_us: 1_000_000,
      brightness: 0.5,
      motion: 0.2,
      sharpness: 0.01,
      flags: [],
    },
    {
      index: 1,
      t_start_us: 2_000_000,
      t_end_us: 6_000_000,
      keyframe_t_us: 4_000_000,
      flags: ["freeze"],
    },
  ],
  cut_scores: [{ t_us: 2_000_000, score: 0.87 }],
};

let unregisterTimelinePanels = () => {};

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  for (const fn of Object.values(shots)) fn.mockReset();
  shots.shotDefaultOpts.mockResolvedValue({ sensitivity: 0.4, min_shot_us: 500_000 });
  shots.shotFloorSensitivity.mockResolvedValue(0.05);
  shots.reduceShotReport.mockResolvedValue(REPORT);
  shots.analyzeShotsFloor.mockResolvedValue(REPORT);
  shots.logEmit.mockResolvedValue(undefined);
  shots.getMediaFrame.mockResolvedValue("data:image/jpeg;base64,AA==");
  // The anchor store is module state and outlives a `cleanup()`, so a file that
  // inherits another file's focus would assert the wrong seek branch.
  useCompositionAnchorStore.setState({ anchors: new Map(), focusedId: null });
  unregisterTimelinePanels = registerTimelinePanels({ open: () => {}, close: () => {} });
  useProjectStore.getState().apply(fixture());
  resetShotsStore();
  vi.mocked(jumpToTimeUs).mockClear();
});

afterEach(() => {
  cleanup();
  unregisterTimelinePanels();
  setLayerSelection(null, []);
  resetShotsStore();
});

describe("ShotsPanel — the three states", () => {
  it("names the kind to select when nothing is selected", async () => {
    render(<ShotsPanel />);
    expect(
      await screen.findByText("Select a video clip to review its shot cuts."),
    ).toBeTruthy();
    expect(shots.shotFloorReportCached).not.toHaveBeenCalled();
  });

  it("names the kind to select when the selection is not a video clip", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("text-1", ["text-1"]);
    render(<ShotsPanel />);
    expect(
      await screen.findByText("Select a video clip to review its shot cuts."),
    ).toBeTruthy();
    // An Audio or Text clip IS selected, which is why the sentence names the
    // kind rather than saying "nothing selected".
    expect(shots.shotFloorReportCached).not.toHaveBeenCalled();
  });

  it("offers Analyze — and issues NO scan — for a source with no cached report", async () => {
    shots.shotFloorReportCached.mockResolvedValue(false);
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);

    expect(
      await screen.findByText(/has not been analyzed for shot cuts yet/),
    ).toBeTruthy();
    expect(shots.shotFloorReportCached).toHaveBeenCalledWith("m1");
    // The whole rule the Panel exists under: selecting a clip probes and never
    // scans.
    expect(shots.analyzeShotsFloor).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });

  it("says it is looking, not that the source was never scanned, while the reduce lands", async () => {
    shots.shotFloorReportCached.mockResolvedValue(true);
    let landReduce!: (r: ShotReport) => void;
    shots.reduceShotReport.mockReturnValue(
      new Promise<ShotReport>((res) => {
        landReduce = res;
      }),
    );
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);

    expect(await screen.findByText("Checking for a shot analysis…")).toBeTruthy();
    // Claiming "not analyzed" here and filling the list a frame later is a
    // flash that reads as a bug — the source WAS scanned.
    expect(
      screen.queryByText(/has not been analyzed for shot cuts yet/),
    ).toBeNull();

    landReduce(REPORT);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  });

  it("renders rows on a cache hit", async () => {
    shots.shotFloorReportCached.mockResolvedValue(true);
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);

    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
    // The clip sits at 1 s, so shot 2 (source 2 s) reads 00:00:03:00.
    expect(rows[1]?.textContent).toContain("00:00:03:00");
    // The scan was a cache read, not a decode: the probe said yes first.
    expect(shots.shotFloorReportCached).toHaveBeenCalledWith("m1");
  });
});

describe("ShotsPanel — Analyze", () => {
  it("runs the floor scan and pairs its log rows", async () => {
    shots.shotFloorReportCached.mockResolvedValue(false);
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(shots.analyzeShotsFloor).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(shots.logEmit).toHaveBeenCalledTimes(2);
  });

  it("shows the tool's own refusal inline and keeps the Panel usable", async () => {
    shots.shotFloorReportCached.mockResolvedValue(false);
    shots.analyzeShotsFloor.mockRejectedValue(
      new Error("shot cuts: source has no probed duration — re-import it"),
    );
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    // The re-import instruction is the only actionable half of the failure.
    expect(await screen.findByText(/re-import it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });
});

describe("ShotsPanel — rows", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
  });

  it("holds a pending frame's space instead of collapsing the row", async () => {
    // A frame that never resolves: the slot is what holds the height, so the
    // list does not reflow as extracts land one by one.
    shots.getMediaFrame.mockReturnValue(new Promise<string>(() => {}));
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    const { container } = render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    const covers = container.querySelectorAll(".shots-cover");
    expect(covers).toHaveLength(2);
    for (const cover of covers) {
      expect(cover.getAttribute("data-state")).toBe("pending");
      expect(cover.querySelector("img")).toBeNull();
    }
  });

  it("asks for the cover frame at the shot's keyframe time and the pair around the cut", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    const asked = shots.getMediaFrame.mock.calls.map(([, tUs]) => tUs);
    expect(asked).toContain(1_000_000); // shot 1's cover
    expect(asked).toContain(4_000_000); // shot 2's cover
    expect(asked).toContain(2_000_000); // the frame AT the cut
    expect(asked).toContain(2_000_000 - 33_333); // and the one before it
  });

  it("renders absent stats as absent and never as zero", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows[0]?.textContent).toContain("B 0.50");
    expect(rows[1]?.textContent).toContain("not measured");
    expect(rows[1]?.textContent).not.toContain("0.00");
  });

  it("gives the first row no candidate control and the second one", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    expect(
      screen.queryByRole("checkbox", { name: "Cut at the start of shot 1" }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Cut at the start of shot 2" }),
    ).toBeTruthy();
  });

  it("merges a shot into its predecessor when its candidate is cleared, reversibly", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Cut at the start of shot 2" }),
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    // The cleared boundary stays on the row it merged into, or the merge would
    // be a one-way door.
    const restore = screen.getByRole("checkbox", {
      name: "Restore the cut at 00:00:02:00",
    });
    fireEvent.click(restore);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  });

  it("marks a row for discard without removing it", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep shot 2" }));
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[1]?.getAttribute("data-kept")).toBe(
        "false",
      ),
    );
    // Still on screen: the reviewer has to see what an apply would delete.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("ShotsPanel — a row click seeks in the layer's own composition", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
  });

  it("seeks on the root's clock for a clip in the root", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    fireEvent.click(screen.getAllByRole("button", { name: /Go to/ })[1]!);
    // Source 2 s in a clip that starts at 1 s.
    expect(jumpToTimeUs).toHaveBeenCalledWith(3_000_000);
    expect(focusedCompositionId()).toBe(ROOT_ID);
  });

  it("seeks on the GROUP's clock for a clip inside a Group", async () => {
    // Enter the Group, then select the clip inside it: the Panel's subject is
    // the primary selection of the FOCUSED timeline.
    openComposition("g1", null);
    setLayerSelection("lg1", ["lg1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    fireEvent.click(screen.getAllByRole("button", { name: /Go to/ })[1]!);
    // Group-local 2 s, projected up through the Group clip at 2 s in the root.
    // The root's own clock would have said 2 s, so this asserts the projection
    // and not merely that a seek happened.
    expect(jumpToTimeUs).toHaveBeenCalledWith(4_000_000);
    expect(focusedCompositionId()).toBe("g1");
  });
});
