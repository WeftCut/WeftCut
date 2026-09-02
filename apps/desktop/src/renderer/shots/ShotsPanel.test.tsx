// @vitest-environment jsdom
//
// The Panel's three states, its one deliberate scan, and where a row click
// seeks. Real stores throughout — the subject is resolved from the selection,
// the project summary and the composition anchor, and mocking those away would
// leave the resolution itself untested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Partial, for `MarkerPanel.test.tsx`'s reason: the composition switch under
// test runs the REAL `openComposition`, which calls back into navigation.
vi.mock("../state/navigation", async (importActual) => ({
  ...(await importActual<typeof import("../state/navigation")>()),
  jumpToTimeUs: vi.fn(),
}));

const shots = vi.hoisted(() => ({
  shotFloorReportCached: vi.fn<(id: string) => Promise<boolean>>(),
  analyzeShotsFloor: vi.fn(),
  applyShotCuts: vi.fn(),
  reduceShotReport: vi.fn(),
  shotDefaultOpts: vi.fn(),
  shotFloorSensitivity: vi.fn(),
  getMediaFrame: vi.fn<(id: string, tUs: number) => Promise<string>>(),
  // Both halves of the description column, so the file can assert the one that
  // matters: opening the Panel reads the cache and never spends a model.
  getMediaDescription: vi.fn<(id: string) => Promise<DescriptionCache | null>>(),
  describeClip: vi.fn(),
  getProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  logEmit: vi.fn<(input: LogEntryInput) => Promise<void>>(),
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
  DescriptionCache,
  LayerSummary,
  LogEntryInput,
  ProjectSummary,
  Shot,
  ShotReport,
  TrackSummary,
} from "../ipc";
import { resetDescriptionsStore } from "../describe/descriptionsStore";
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

/// The same project after a split of `l1` — the two segments stand where the
/// reviewed clip was, and the clip's own id is gone. What `project:changed`
/// delivers once the apply commits.
function fixtureAfterSplit(): ProjectSummary {
  return summaryFixture({
    root: {
      duration_us: 20_000_000,
      tracks: [
        track("t1", [
          clip({ id: "s1", mediaId: "m1", tStartUs: 1_000_000, srcOutUs: 2_000_000 }),
          clip({
            id: "s2",
            mediaId: "m1",
            tStartUs: 3_000_000,
            srcInUs: 2_000_000,
            srcOutUs: 6_000_000,
          }),
        ]),
        track("t2", [textLayer()]),
      ],
    },
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
  shots.applyShotCuts.mockResolvedValue({ mode: "split", layer_ids: ["s1", "s2"] });
  shots.logEmit.mockResolvedValue(undefined);
  shots.getMediaFrame.mockResolvedValue("data:image/jpeg;base64,AA==");
  shots.getMediaDescription.mockResolvedValue(null);
  shots.getProjectSettings.mockResolvedValue({
    prefer_proxies: false,
    proxy_overrides: {},
    shot_review: null,
  });
  shots.updateProjectSettings.mockResolvedValue(undefined);
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
  resetDescriptionsStore();
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

// The correlation the column exists for: where the clip cuts, beside what is in
// it. `REPORT` puts the boundary at 2 s, so a segment ending after it and a
// segment starting before it are the two interesting cases.
describe("ShotsPanel — the description column", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
  });

  it("says a shot is not described rather than leaving the cell blank", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
    for (const row of rows) expect(row.textContent).toContain("Not described");
  });

  // The rule this file exists to keep: clicking a clip must never start a
  // ~20 s model run.
  it("reads the cache on selection and spends no model", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() =>
      expect(shots.getMediaDescription).toHaveBeenCalledWith("m1"),
    );
    expect(shots.describeClip).not.toHaveBeenCalled();
  });

  it("shows each row's own prose and tags", async () => {
    shots.getMediaDescription.mockResolvedValue({
      covered_ranges: [[0, 6_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: ["interior"] },
        { t_start_us: 2_000_000, t_end_us: 6_000_000, text: "a street", tags: ["exterior", "wide"] },
      ],
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found[0]?.textContent).toContain("a hallway");
      return found;
    });
    expect(rows[0]?.textContent).toContain("interior");
    expect(rows[0]?.textContent).not.toContain("a street");
    expect(rows[1]?.textContent).toContain("a street");
    expect(rows[1]?.textContent).toContain("exterior");
    expect(rows[1]?.textContent).toContain("wide");
    // Neither row falls back to the empty state once it has prose.
    for (const row of rows) expect(row.textContent).not.toContain("Not described");
  });

  // The acceptance: a segment sampled ACROSS the boundary belongs to both rows.
  // The model and the detector disagreeing about where the content changes is
  // exactly what a reviewer is here to see.
  it("puts a segment that straddles the cut on both rows", async () => {
    shots.getMediaDescription.mockResolvedValue({
      covered_ranges: [[0, 6_000_000]],
      segments: [
        {
          t_start_us: 1_500_000,
          t_end_us: 2_500_000,
          text: "she turns to the window",
          tags: [],
        },
      ],
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found[0]?.textContent).toContain("she turns to the window");
      return found;
    });
    expect(rows[1]?.textContent).toContain("she turns to the window");
  });

  it("leaves a row the described ranges never reached saying so", async () => {
    shots.getMediaDescription.mockResolvedValue({
      covered_ranges: [[0, 2_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: [] },
      ],
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found[0]?.textContent).toContain("a hallway");
      return found;
    });
    expect(rows[1]?.textContent).toContain("Not described");
  });
});

describe("ShotsPanel — the apply bar", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
  });

  /// Mount over the reviewed clip and wait for its two rows.
  async function review(): Promise<void> {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  }

  function verb(id: "split" | "mark" | "discard"): HTMLButtonElement {
    return screen.getByTestId(`shots-apply-${id}`) as HTMLButtonElement;
  }

  it("sends the reviewed list, under the name the rest of the app shows", async () => {
    await review();

    fireEvent.click(verb("split"));

    await waitFor(() =>
      expect(shots.applyShotCuts).toHaveBeenCalledWith({
        layer_id: "l1",
        mode: "split",
        cuts_src_us: [2_000_000],
      }),
    );
    // `layerDisplayName`, the same name the timeline and the log rows use.
    expect(shots.logEmit.mock.calls[0]?.[0]).toMatchObject({
      i18n_key: "log.shots_apply_split_started",
      i18n_args: { clip: "shot reel", cuts: 1 },
    });
  });

  it("marks the boundaries a split would cut at", async () => {
    shots.applyShotCuts.mockResolvedValue({ mode: "mark", marker_ids: ["m1"] });
    await review();

    fireEvent.click(verb("mark"));

    await waitFor(() =>
      expect(shots.applyShotCuts).toHaveBeenCalledWith({
        layer_id: "l1",
        mode: "mark",
        cuts_src_us: [2_000_000],
      }),
    );
  });

  it("sends the unchecked row's index and cuts at its boundary anyway", async () => {
    shots.applyShotCuts.mockResolvedValue({ mode: "discard", layer_ids: ["s1"] });
    await review();

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep shot 2" }));
    await waitFor(() => expect(verb("discard").disabled).toBe(false));
    fireEvent.click(verb("discard"));

    await waitFor(() =>
      expect(shots.applyShotCuts).toHaveBeenCalledWith({
        layer_id: "l1",
        mode: "discard",
        cuts_src_us: [2_000_000],
        discard_segments: [1],
      }),
    );
  });

  it("greys the discard until a shot is unchecked, and says which", async () => {
    await review();

    expect(verb("discard").disabled).toBe(true);
    // The precondition, not the label it cannot act on.
    expect(verb("discard").getAttribute("title")).toBe(
      "Uncheck the shots you want discarded first",
    );
    expect(verb("split").disabled).toBe(false);
    expect(verb("split").getAttribute("title")).toBe("Split at cuts");
  });

  it("greys both cutting verbs when the last boundary is cleared", async () => {
    await review();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Cut at the start of shot 2" }),
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));

    // With no interior boundary the channel answers with the unchanged layer
    // id, which on screen is indistinguishable from a dead button — so the
    // remedy is what the greyed pair says instead.
    for (const id of ["split", "mark"] as const) {
      expect(verb(id).disabled).toBe(true);
      expect(verb(id).getAttribute("title")).toBe(
        "Lower the threshold, or restore a cleared cut — this clip is one shot",
      );
    }
    expect(shots.applyShotCuts).not.toHaveBeenCalled();
  });

  it("locks all three while one apply is in flight", async () => {
    let land!: (r: { mode: "split"; layer_ids: string[] }) => void;
    shots.applyShotCuts.mockReturnValue(
      new Promise((res) => {
        land = res;
      }),
    );
    await review();
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep shot 2" }));
    await waitFor(() => expect(verb("discard").disabled).toBe(false));

    fireEvent.click(verb("split"));
    await waitFor(() => expect(verb("split").disabled).toBe(true));
    expect(verb("mark").disabled).toBe(true);
    expect(verb("discard").disabled).toBe(true);
    expect(verb("mark").getAttribute("title")).toBe("An apply is already running");
    // A second press cannot even be delivered, but the assertion is about the
    // count either way: two commits over one reviewed list is the failure.
    fireEvent.click(verb("split"));
    expect(shots.applyShotCuts).toHaveBeenCalledTimes(1);

    land({ mode: "split", layer_ids: ["s1", "s2"] });
    await waitFor(() => expect(verb("mark").disabled).toBe(false));
  });

  it("shows the channel's own refusal inline rather than pre-empting it", async () => {
    shots.applyShotCuts.mockRejectedValue(
      new Error(
        JSON.stringify({
          error: "InvalidArgument",
          field: "discard_segments",
          detail:
            "discard_segments names all 2 segment(s) — discarding every segment is a delete, not an apply",
        }),
      ),
    );
    await review();

    // Every row unchecked — the one case the buttons do NOT grey, so that the
    // rule has exactly one statement of itself and it is the wire's.
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep shot 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep shot 2" }));
    await waitFor(() => expect(verb("discard").disabled).toBe(false));
    fireEvent.click(verb("discard"));

    expect(
      await screen.findByText(/discarding every segment is a delete/),
    ).toBeTruthy();
    // No toast and no dialog: destructive-but-undoable is house style, and the
    // record is the paired Err row.
    expect(shots.logEmit.mock.calls[1]?.[0]).toMatchObject({
      op_state: { state: "Err" },
    });
  });

  it("falls to the select-a-clip state once the split's summary lands", async () => {
    await review();

    fireEvent.click(verb("split"));
    await waitFor(() => expect(shots.applyShotCuts).toHaveBeenCalled());
    // What `project:changed` delivers: `l1` is gone and two segments stand in
    // its place. `retainLayerSelection` drops the vanished primary, which is
    // the only thing that has to happen for the Panel to land somewhere sane.
    act(() => {
      useProjectStore.getState().apply(fixtureAfterSplit());
    });

    expect(
      await screen.findByText("Select a video clip to review its shot cuts."),
    ).toBeTruthy();
    // No rows for a layer that no longer exists, and no apply bar over them.
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByTestId("shots-apply")).toBeNull();
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

// ── The score strip and its threshold line ───────────────────────────────────
//
// Every reduced report below is verbatim `Backend.reduceShotReport` output over
// FLOOR at the stated parameters, obtained from a plain Node script. The addon
// is NOT loaded here: `new Backend(...)` spins a tokio runtime with no shutdown
// entry point, so a vitest worker that constructed one would never exit. The
// mock refuses any parameter pair that was not measured, which is what keeps a
// row expectation from quietly becoming a TypeScript re-implementation of the
// reduce.

/// A shot the way `reduce` returns one for a span the floor scan never sampled:
/// cover frame at the midpoint, stats absent, no flags.
function reducedShot(index: number, tStartUs: number, tEndUs: number): Shot {
  return {
    index,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    keyframe_t_us: tStartUs + Math.floor((tEndUs - tStartUs) / 2),
    brightness: null,
    motion: null,
    sharpness: null,
    flags: [],
  };
}

function reducedReport(
  spans: readonly (readonly [number, number])[],
  cuts: readonly (readonly [number, number])[],
): ShotReport {
  return {
    shots: spans.map(([a, b], i) => reducedShot(i, a, b)),
    cut_scores: cuts.map(([t_us, score]) => ({ t_us, score })),
  };
}

/// Four candidates over a six-second source, scores spread so a line has
/// somewhere to sit between them, and the pair at 1.0 s / 1.2 s close enough
/// that the minimum shot length has something to merge.
const FLOOR_CANDIDATES: readonly (readonly [number, number])[] = [
  [1_000_000, 0.9],
  [1_200_000, 0.8],
  [3_000_000, 0.3],
  [4_500_000, 0.6],
];

const FLOOR: ShotReport = reducedReport(
  [
    [0, 1_000_000],
    [1_000_000, 1_200_000],
    [1_200_000, 3_000_000],
    [3_000_000, 4_500_000],
    [4_500_000, 6_000_000],
  ],
  FLOOR_CANDIDATES,
);

const ABOVE_0_4: readonly (readonly [number, number])[] = [
  [1_000_000, 0.9],
  [1_200_000, 0.8],
  [4_500_000, 0.6],
];
const ABOVE_0_6: readonly (readonly [number, number])[] = [
  [1_000_000, 0.9],
  [1_200_000, 0.8],
];

/// `sensitivity@minShotUs` → the measured answer.
const MEASURED = new Map<string, ShotReport>([
  [
    "0.4@200000",
    reducedReport(
      [
        [0, 1_000_000],
        [1_000_000, 1_200_000],
        [1_200_000, 4_500_000],
        [4_500_000, 6_000_000],
      ],
      ABOVE_0_4,
    ),
  ],
  [
    "0.5@200000",
    reducedReport(
      [
        [0, 1_000_000],
        [1_000_000, 1_200_000],
        [1_200_000, 4_500_000],
        [4_500_000, 6_000_000],
      ],
      ABOVE_0_4,
    ),
  ],
  [
    "0.6@200000",
    reducedReport(
      [
        [0, 1_000_000],
        [1_000_000, 1_200_000],
        [1_200_000, 6_000_000],
      ],
      ABOVE_0_6,
    ),
  ],
  // The SAME threshold, one step of the length knob further: two spans merge
  // and the candidates above the line are untouched.
  [
    "0.4@300000",
    reducedReport(
      [
        [0, 1_000_000],
        [1_000_000, 4_500_000],
        [4_500_000, 6_000_000],
      ],
      ABOVE_0_4,
    ),
  ],
]);

/// A scanned source whose window holds no candidate at all.
const NO_CANDIDATES: ShotReport = reducedReport([[0, 6_000_000]], []);

function reviewOf(container: HTMLElement): {
  ticks: () => { srcUs: string | null; accepted: string | null }[];
  rowStarts: () => (string | null)[];
} {
  return {
    ticks: () =>
      [...container.querySelectorAll(".shots-tick")].map((el) => ({
        srcUs: el.getAttribute("data-src-us"),
        accepted: el.getAttribute("data-accepted"),
      })),
    rowStarts: () =>
      [...container.querySelectorAll(".shots-timecode")].map(
        (el) => el.textContent,
      ),
  };
}

describe("ShotsPanel — the score strip and its line", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
    shots.analyzeShotsFloor.mockResolvedValue(FLOOR);
    shots.shotDefaultOpts.mockResolvedValue({
      sensitivity: 0.4,
      min_shot_us: 200_000,
    });
    shots.reduceShotReport.mockImplementation(
      (_report: ShotReport, p: { sensitivity: number; minShotUs: number }) => {
        const key = `${p.sensitivity}@${p.minShotUs}`;
        const answer = MEASURED.get(key);
        if (answer === undefined) {
          return Promise.reject(
            new Error(`no measured reduce for ${key} — add one from the addon`),
          );
        }
        return Promise.resolve(answer);
      },
    );
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
  });

  it("draws one tick per FLOOR candidate, above the row list", async () => {
    const { container } = render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    const review = reviewOf(container);

    // Four ticks from a reduce that answered with three candidates: the strip
    // reads the FLOOR report, because showing what the line excludes is half of
    // what it is for.
    expect(review.ticks()).toEqual([
      { srcUs: "1000000", accepted: "true" },
      { srcUs: "1200000", accepted: "true" },
      { srcUs: "3000000", accepted: "false" },
      { srcUs: "4500000", accepted: "true" },
    ]);
    const strip = screen.getByTestId("shots-score-strip");
    const list = screen.getByTestId("shots-list");
    expect(
      strip.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("nudges the line, and the rows become the reduce's answer at that threshold", async () => {
    const { container } = render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    shots.analyzeShotsFloor.mockClear();
    const review = reviewOf(container);

    const line = screen.getByRole("slider");
    fireEvent.keyDown(line, { key: "PageUp" }); // 0.4 → 0.5
    fireEvent.keyDown(line, { key: "PageUp" }); // 0.5 → 0.6

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(line.getAttribute("aria-valuenow")).toBe("0.6");
    // The clip sits at 1 s with `src_in_us` 0, so the measured spans read as
    // 1 s / 2 s / 2.2 s on the composition clock.
    expect(review.rowStarts()).toEqual([
      "00:00:01:00",
      "00:00:02:00",
      "00:00:02:06",
    ]);
    // The 0.6 candidate has fallen below the line; the 0.3 one was never above
    // it.
    expect(review.ticks().map((tick) => tick.accepted)).toEqual([
      "true",
      "true",
      "false",
      "false",
    ]);
    // Free by construction: every threshold at or above the floor comes out of
    // the scan already in hand.
    expect(shots.analyzeShotsFloor).not.toHaveBeenCalled();
  });

  it("persists on the gesture's release and not on its presses", async () => {
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));

    const line = screen.getByRole("slider");
    fireEvent.keyDown(line, { key: "PageUp" });
    fireEvent.keyDown(line, { key: "PageUp" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(shots.updateProjectSettings).not.toHaveBeenCalled();

    fireEvent.keyUp(line, { key: "PageUp" });
    await waitFor(() =>
      expect(shots.updateProjectSettings).toHaveBeenCalledWith({
        shot_review: { sensitivity: 0.6, min_shot_us: 200_000 },
      }),
    );
    expect(shots.updateProjectSettings).toHaveBeenCalledTimes(1);
  });

  it("raising the minimum shot length merges spans and leaves the line alone", async () => {
    const user = userEvent.setup();
    const { container } = render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    const review = reviewOf(container);
    const before = review.ticks();

    const length = screen.getByLabelText("Minimum shot length") as HTMLInputElement;
    expect(length.value).toBe("200");
    await user.click(length);
    await user.keyboard("{ArrowUp}"); // 200 ms → 300 ms
    await user.keyboard("{Enter}");

    // 1.0 s and 1.2 s are now closer together than the minimum, so the pair
    // becomes one span — while the reduce's own candidate list is unchanged,
    // which is what "the line did not move" means.
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(review.rowStarts()).toEqual([
      "00:00:01:00",
      "00:00:02:00",
      "00:00:05:15",
    ]);
    expect(review.ticks()).toEqual(before);
    const params = shots.reduceShotReport.mock.calls.map(([, p]) => p);
    expect(params[params.length - 1]).toEqual({
      sensitivity: 0.4,
      minShotUs: 300_000,
      inUs: 0,
      outUs: 6_000_000,
    });
    await waitFor(() =>
      expect(shots.updateProjectSettings).toHaveBeenCalledWith({
        shot_review: { sensitivity: 0.4, min_shot_us: 300_000 },
      }),
    );
  });

  it("seeds the line from the project's threshold, not the detector's default", async () => {
    shots.getProjectSettings.mockResolvedValue({
      prefer_proxies: false,
      proxy_overrides: {},
      shot_review: { sensitivity: 0.6, min_shot_us: 200_000 },
    });
    render(<ShotsPanel />);

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0.6");
  });

  it("says so when the floor scan found no candidate in the window", async () => {
    shots.analyzeShotsFloor.mockResolvedValue(NO_CANDIDATES);
    // Measured too: with no candidate to filter, the reduce answers the whole
    // window as one shot at every parameter pair.
    shots.reduceShotReport.mockResolvedValue(NO_CANDIDATES);
    render(<ShotsPanel />);

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByTestId("shots-no-candidates").textContent).toContain(
      "No candidate cuts in this clip's range",
    );
    // No line to drag over an empty plot.
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
