// @vitest-environment jsdom
//
// The Panel's three states, its one deliberate scan, and where a row click
// seeks. Real stores throughout — the subject is resolved from the selection,
// the project summary and the composition anchor, and mocking those away would
// leave the resolution itself untested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  attachShotStats: vi.fn(),
  getMediaFrame: vi.fn<(id: string, tUs: number) => Promise<string>>(),
  // Both halves of the description column, so the file can assert the one that
  // matters: opening the Panel reads the cache and never spends a model.
  getMediaDescription: vi.fn<(id: string, purpose?: "clip" | "shot") => Promise<DescriptionCache | null>>(),
  describeClip: vi.fn(),
  getProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  logEmit: vi.fn<(input: LogEntryInput) => Promise<void>>(),
  cancelComputeJob: vi.fn<(jobId: string) => Promise<boolean>>(),
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
import {
  currentSelection,
  primaryLayerIdOf,
  setLayerSelection,
} from "../state/selectionStore";
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
  SpanStats,
  TrackSummary,
} from "../ipc";
import { resetDescriptionsStore, setDescribing, setDescribeError, useDescriptionsStore } from "../describe/descriptionsStore";
import { receiveComputeJobs } from "../compute/computeJobsStore";
import type { ComputeJob, ComputePhase } from "../ipc";
import { resetShotsStore } from "./shotsStore";
import { ShotsPanel, cutConfidence, shotDescribeBlocker } from "./ShotsPanel";

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

/// The same project after a plain split of `l1` at 2 s. A split keeps the
/// original id on the LEFT half (`mutations/split.ts` `splitSingleLayer`), so
/// `l1` is still there — shorter — and a fresh `s2` stands after it. What
/// `project:changed` delivers once a split commits.
function fixtureAfterSplit(): ProjectSummary {
  return summaryFixture({
    root: {
      duration_us: 20_000_000,
      tracks: [
        track("t1", [
          clip({ id: "l1", mediaId: "m1", tStartUs: 1_000_000, srcOutUs: 2_000_000 }),
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

/// The same project after a discard that threw the FIRST segment away: the id
/// the review was about is gone, and only the second segment remains. The one
/// apply outcome where the selection survives only because the store adopted
/// the answer's first survivor.
function fixtureAfterDiscardOfFirst(): ProjectSummary {
  return summaryFixture({
    root: {
      duration_us: 20_000_000,
      tracks: [
        track("t1", [
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
  shots.attachShotStats.mockResolvedValue([]);
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
    // Hover text says the action, in both states.
    expect(restore.getAttribute("title")).toBe("Split here");
    fireEvent.click(restore);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  });

  it("leaves the cut alone when the meter or the score is clicked", async () => {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    const toggle = screen.getByRole("checkbox", {
      name: "Cut at the start of shot 2",
    });
    expect(toggle.getAttribute("title")).toBe(
      "Clear the cut and merge into the previous shot",
    );
    const row = toggle.closest(".shots-cut");
    expect(row).not.toBeNull();
    const meter = row!.querySelector(".shots-cut-meter");
    const score = row!.querySelector(".shots-score");
    expect(meter).not.toBeNull();
    expect(score).not.toBeNull();
    // The reading sits BESIDE the control, not inside it — a click there can
    // never bubble into the checkbox, which is what makes the rest of this
    // test hold rather than merely pass.
    expect(toggle.contains(meter)).toBe(false);
    expect(toggle.contains(score)).toBe(false);

    await act(async () => {
      fireEvent.click(meter!);
      fireEvent.click(score!);
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
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

// The opt-in stats pass. `REPORT`'s first shot was sampled by a scan and its
// second was not, so one row is measured and one is not from the first paint —
// which is what makes both the gating and the in-place flip observable.
describe("ShotsPanel — Measure shots", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
  });

  /// The boundary's answer for the one unmeasured span, `[2s, 6s]`. Its
  /// `freeze` flag is the same one the report already carries for that span:
  /// both come from `measure_span` over the same three frames, so a fixture
  /// where they disagreed would be describing a bug.
  const MEASURED_TAIL: SpanStats[] = [
    {
      t_start_us: 2_000_000,
      t_end_us: 6_000_000,
      brightness: 0.31,
      motion: 0.42,
      sharpness: 0.017,
      flags: ["freeze"],
    },
  ];

  async function review(): Promise<HTMLElement[]> {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    return await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
  }

  function measureButton(): HTMLButtonElement {
    return screen.getByTestId("shots-measure") as HTMLButtonElement;
  }

  it("sits on the parameters row, above the apply verbs", async () => {
    await review();
    // Not among the apply verbs: those write to the project, this writes only a
    // cache sidecar — it changes what the rows SAY, like the threshold line and
    // the length field it shares a row with.
    const params = measureButton().parentElement;
    expect(params?.className).toContain("shots-params");
    expect(screen.getByLabelText("Minimum shot length")).toBeTruthy();
    const bar = screen.getByTestId("shots-apply");
    expect(
      measureButton().compareDocumentPosition(bar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("measures only the unmeasured span and flips its cells in place", async () => {
    shots.attachShotStats.mockResolvedValue(MEASURED_TAIL);
    const before = await review();
    expect(before[1]?.textContent).toContain("not measured");

    fireEvent.click(measureButton());

    await waitFor(() =>
      expect(shots.attachShotStats).toHaveBeenCalledWith("m1", [
        // Row 1's span was sampled by the scan, so it is not re-measured.
        { t_start_us: 2_000_000, t_end_us: 6_000_000 },
      ]),
    );
    const after = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found[1]?.textContent).toContain("B 0.31");
      return found;
    });
    expect(after[1]?.textContent).not.toContain("not measured");
    expect(after[1]?.textContent).toContain("M 0.42");
    expect(after[1]?.textContent).toContain("S 0.017");
    // The acceptance: the row list did not re-render its boundaries. Keying on
    // the span's source start is what keeps these the SAME nodes, so the cells
    // fill without the list flashing or losing scroll.
    expect(after[0]?.isSameNode(before[0]!)).toBe(true);
    expect(after[1]?.isSameNode(before[1]!)).toBe(true);
    expect(after[1]?.getAttribute("data-index")).toBe("1");
  });

  it("greys itself once every row is measured, and says why", async () => {
    shots.attachShotStats.mockResolvedValue(MEASURED_TAIL);
    await review();
    expect(measureButton().disabled).toBe(false);
    expect(measureButton().getAttribute("title")).toBe(
      "Measure shot brightness, motion and sharpness",
    );

    fireEvent.click(measureButton());
    await waitFor(() => expect(measureButton().disabled).toBe(true));
    expect(measureButton().getAttribute("title")).toBe(
      "Every shot in this list is already measured",
    );
    // A second press cannot be delivered, and would send nothing anyway.
    expect(shots.attachShotStats).toHaveBeenCalledTimes(1);
  });

  it("locks itself while the pass runs, and the apply verbs while it does", async () => {
    let land!: (stats: SpanStats[]) => void;
    shots.attachShotStats.mockReturnValue(
      new Promise<SpanStats[]>((res) => {
        land = res;
      }),
    );
    await review();

    fireEvent.click(measureButton());
    await waitFor(() => expect(measureButton().disabled).toBe(true));
    expect(measureButton().getAttribute("title")).toBe("Measuring…");

    land(MEASURED_TAIL);
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[1]?.textContent).toContain("B 0.31"),
    );
  });

  it("greys itself while an apply is running, naming that instead", async () => {
    shots.applyShotCuts.mockReturnValue(new Promise(() => {}));
    await review();

    fireEvent.click(screen.getByTestId("shots-apply-split"));
    // An apply reshapes the very rows a measurement would be taken over, and
    // the two share the one inline error slot.
    await waitFor(() => expect(measureButton().disabled).toBe(true));
    expect(measureButton().getAttribute("title")).toBe(
      "An apply is already running",
    );
    expect(shots.attachShotStats).not.toHaveBeenCalled();
  });

  it("shows the boundary's own refusal inline", async () => {
    shots.attachShotStats.mockRejectedValue(
      new Error("spans[0].t_end_us 9000000 is past the source's 6000000 µs duration"),
    );
    await review();

    fireEvent.click(measureButton());

    expect(await screen.findByText(/spans\[0\]/)).toBeTruthy();
    // Still pressable: nothing was measured, so the offer stands.
    expect(measureButton().disabled).toBe(false);
    expect(shots.logEmit.mock.calls[1]?.[0]).toMatchObject({
      op_state: { state: "Err" },
    });
  });
});

// The correlation the column exists for: where the clip cuts, beside what is in
// it. `REPORT` puts the boundary at 2 s, so a segment ending after it and a
// segment starting before it are the two interesting cases.
describe("ShotsPanel — the description column", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
  });

  it("shows clip content separately and still offers every undescribed shot", async () => {
    shots.getMediaDescription.mockImplementation(async (_id, purpose) => purpose === "shot" ? null : {
      covered_ranges: [[0, 6_000_000]],
      segments: [{ t_start_us: 0, t_end_us: 6_000_000, text: "whole clip content", tags: [] }],
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    expect((await screen.findByTestId("shots-clip-content")).textContent).toContain("whole clip content");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    for (const row of screen.getAllByRole("listitem")) {
      expect(row.textContent).toContain("Not described");
      expect(row.textContent).not.toContain("whole clip content");
    }
    expect(screen.getByTestId("shots-describe-all").textContent).toContain("Describe 2 shots");
  });

  it("leads clip content with its summary and keeps the segments behind a closed disclosure", async () => {
    shots.getMediaDescription.mockImplementation(async (_id, purpose) => purpose === "shot" ? null : {
      covered_ranges: [[0, 6_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 3_000_000, text: "a hallway", tags: [] },
        { t_start_us: 3_000_000, t_end_us: 6_000_000, text: "a door opens", tags: [] },
      ],
      summaries: [{ window: [0, 6_000_000], text: "Someone walks a hallway to a door." }],
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    expect((await screen.findByTestId("shots-clip-summary")).textContent).toBe(
      "Someone walks a hallway to a door.",
    );
    const details = screen.getByTestId("shots-clip-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Details (2 segments)");
    expect(screen.queryByTestId("shots-clip-more")).toBeNull();
  });

  it("caps a long clip-content list without a summary and expands it on request", async () => {
    const segments = Array.from({ length: 12 }, (_, i) => ({
      t_start_us: i * 500_000,
      t_end_us: (i + 1) * 500_000,
      text: `moment ${i}`,
      tags: [],
    }));
    shots.getMediaDescription.mockImplementation(async (_id, purpose) => purpose === "shot" ? null : {
      covered_ranges: [[0, 6_000_000]],
      segments,
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await screen.findByTestId("shots-clip-content");
    // The rows land after the first paint; the section is the one above them.
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    const lines = () =>
      screen.getByTestId("shots-clip-content").querySelectorAll(".shots-description-span").length;
    expect(lines()).toBe(8);
    expect(screen.queryByTestId("shots-clip-summary")).toBeNull();
    const more = screen.getByTestId("shots-clip-more");
    expect(more.textContent).toBe("Show all 12");
    fireEvent.click(more);
    expect(lines()).toBe(12);
    expect(screen.getByTestId("shots-clip-more").textContent).toBe("Show fewer");
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

// The per-row press and the sweep beside it. `REPORT`'s boundary at 2 s and the
// clip's 0–6 s source window give two rows: shot 1 over [0, 2 s) and shot 2 over
// [2 s, 6 s). The clip sits at `t_start_us` 1 s (see `SUMMARY`), so the TIMELINE
// window a row sends is its source span shifted by one second — which is the
// projection worth pinning, since `describe_clip` validates against the layer's
// timeline range and would refuse a source-time window outright.
describe("ShotsPanel — describing one shot", () => {
  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
    shots.describeClip.mockResolvedValue({
      backend: "qwen3_vl",
      model: "Qwen3VL-4B",
      segments: [
        { t_start_us: 2_000_000, t_end_us: 6_000_000, text: "a kitchen", tags: ["interior"] },
      ],
    });
  });

  /// Mount over the reviewed clip and wait for its two rows.
  async function review(): Promise<HTMLElement[]> {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    return await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
  }

  it("sends the row's own window in timeline time", async () => {
    await review();
    fireEvent.click(screen.getByTestId("shots-describe-1"));
    await waitFor(() => expect(shots.describeClip).toHaveBeenCalled());
    // The window, and NO view arguments: sampling, focus and language are
    // Settings, injected by main, so every describe gesture lands in the one
    // view these rows read back.
    expect(shots.describeClip).toHaveBeenCalledWith({
      layerId: "l1",
      purpose: "shot",
      tStartUs: 3_000_000,
      tEndUs: 7_000_000,
      // The call's job tag (ADR 0121) — host plumbing, not a view argument.
      requestId: expect.any(String),
    });
  });

  it.each(["shots-describe-1", "shots-describe-all"])(
    "bounds %s requests when the source endpoint projects past the clip by one microsecond",
    async (buttonId) => {
      const layer = clip({ id: "l1", mediaId: "m1", tStartUs: 1_000_000 });
      layer.t_end_us -= 1;
      useProjectStore.getState().apply(
        summaryFixture({ root: { duration_us: 20_000_000, tracks: [track("t1", [layer])] } }),
      );
      shots.describeClip.mockImplementation(async (args: { tStartUs: number; tEndUs: number }) => {
        if (args.tStartUs < layer.t_start_us || args.tEndUs > layer.t_end_us) {
          throw new Error(
            `description window [${args.tStartUs}, ${args.tEndUs}] is outside layer range [${layer.t_start_us}, ${layer.t_end_us}]`,
          );
        }
        return {
          backend: "qwen3_vl", model: "Qwen3VL-4B",
          segments: [{
            t_start_us: args.tStartUs - layer.t_start_us,
            t_end_us: args.tEndUs - layer.t_start_us,
            text: "a kitchen", tags: [],
          }],
        };
      });
      const rows = await review();
      fireEvent.click(screen.getByTestId(buttonId));
      await waitFor(() => expect(rows[1]?.textContent).toContain("a kitchen"));
      expect(screen.queryByTestId("shots-describe-error")).toBeNull();
      expect(shots.describeClip).toHaveBeenLastCalledWith(expect.objectContaining({
        tStartUs: 3_000_000,
        tEndUs: layer.t_end_us,
      }));
    },
  );

  it("shows the run's prose on the row that asked for it", async () => {
    const rows = await review();
    fireEvent.click(screen.getByTestId("shots-describe-1"));
    await waitFor(() => expect(rows[1]?.textContent).toContain("a kitchen"));
    // …and on no other row: the run answered for one window, and the optimistic
    // publish is merged over exactly that window.
    expect(rows[0]?.textContent).toContain("Not described");
  });

  it("logs the run as a Started/Ok pair naming the shot", async () => {
    await review();
    shots.logEmit.mockClear();
    fireEvent.click(screen.getByTestId("shots-describe-0"));
    await waitFor(() => expect(shots.logEmit).toHaveBeenCalledTimes(2));
    const [started, done] = shots.logEmit.mock.calls.map((c) => c[0]);
    expect(started).toMatchObject({
      i18n_key: "log.describe_started",
      op_state: { state: "Started" },
    });
    expect(done).toMatchObject({
      i18n_key: "log.describe_done",
      op_state: { state: "Ok" },
    });
    // One `op_id` across the pair, or the status badge keeps spinning.
    expect(started?.op_id).toBe(done?.op_id);
    // The shot's ordinal is in the subject, so a sweep's rows say which run
    // each one was.
    expect(started?.i18n_args).toMatchObject({ clip: "shot reel · shot 1" });
  });

  // The engine's own sentence, in the Panel's describe slot — not the apply
  // bar's, which is documented as exclusive between the scan, a measurement
  // and an apply.
  it("shows a refusal inline without touching the apply slot", async () => {
    shots.describeClip.mockRejectedValue(
      new Error("no video-understanding backend available — configure a local engine"),
    );
    await review();
    fireEvent.click(screen.getByTestId("shots-describe-1"));
    await waitFor(() =>
      expect(screen.getByTestId("shots-describe-error").textContent).toContain(
        "no video-understanding backend available",
      ),
    );
  });

  it("summarizes a resource refusal and offers Performance settings, the native sentence folded away", async () => {
    const raw =
      "frame sample: resource-capacity-exceeded: Waited 60 s before sampling clip frames: the CPU and memory budget is held by 2 other lease(s), 1 of them background processing such as proxy generation. Retry when it finishes, or raise Processing effort or the Memory target in Settings";
    shots.describeClip.mockRejectedValue(new Error(raw));
    await review();
    fireEvent.click(screen.getByTestId("shots-describe-1"));
    const refusal = await screen.findByTestId("shots-describe-error");
    expect(refusal.dataset.reason).toBe("budget");
    expect(within(refusal).getByText(/could not start within 60 s/).tagName).toBe("P");
    expect(within(refusal).getByRole("button", { name: "Open Performance settings" })).toBeTruthy();
    expect(within(refusal).getByText(/resource-capacity-exceeded/).closest("details")).not.toBeNull();
  });

  it("keeps description controls available on a retimed clip", async () => {
    // A speed != 1 clip is refused by the tool itself, so the gate says so
    // before the press rather than after the run.
    const retimed = clip({ id: "l1", mediaId: "m1", tStartUs: 1_000_000 });
    Object.assign(retimed.params, { time_map: { kind: "Affine", rate: { num: 2, den: 1 } } });
    act(() => {
      useProjectStore.getState().apply(
        summaryFixture({
          root: { duration_us: 20_000_000, tracks: [track("t1", [retimed])] },
        }),
      );
    });
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    const button = await waitFor(() => screen.getByTestId("shots-describe-0"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("shots-describe-all") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sweeps only the rows that have nothing, one run at a time", async () => {
    shots.getMediaDescription.mockResolvedValue({
      covered_ranges: [[0, 2_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: [] },
      ],
    });
    await review();
    const sweep = screen.getByTestId("shots-describe-all");
    // Shot 1 already has prose, so the count names the one that does not.
    expect(sweep.textContent).toContain("Describe 1 shot");
    fireEvent.click(sweep);
    await waitFor(() => expect(shots.describeClip).toHaveBeenCalledTimes(1));
    expect(shots.describeClip).toHaveBeenCalledWith({
      layerId: "l1",
      purpose: "shot",
      tStartUs: 3_000_000,
      tEndUs: 7_000_000,
      // The call's job tag (ADR 0121) — host plumbing, not a view argument.
      requestId: expect.any(String),
    });
  });

  // A refusal is about the clip it was raised on. `shotsStore` clears its own
  // slot when the subject changes, and this one has to do the same or the
  // sentence reads as a fresh failure on the newly selected clip.
  it("drops the refusal when the subject changes", async () => {
    shots.describeClip.mockRejectedValue(new Error("no video-understanding backend"));
    await review();
    fireEvent.click(screen.getByTestId("shots-describe-1"));
    await waitFor(() => screen.getByTestId("shots-describe-error"));
    act(() => {
      useProjectStore.getState().apply(fixtureAfterSplit());
    });
    setLayerSelection("s2", ["s2"]);
    await waitFor(() =>
      expect(screen.queryByTestId("shots-describe-error")).toBeNull(),
    );
  });

  it("greys the sweep once every shot has a description", async () => {
    shots.getMediaDescription.mockResolvedValue({
      covered_ranges: [[0, 6_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: [] },
        { t_start_us: 2_000_000, t_end_us: 6_000_000, text: "a kitchen", tags: [] },
      ],
    });
    await review();
    const sweep = await waitFor(() => {
      const found = screen.getByTestId("shots-describe-all") as HTMLButtonElement;
      expect(found.disabled).toBe(true);
      return found;
    });
    expect(sweep.getAttribute("title")).toContain("already has a description");
  });

  // The blocker rule direct, for the three in-flight branches a render cannot
  // reach without a real run in the air. ONE rule for the rows and the sweep, so
  // a greyed row and a refused sweep cannot disagree about the precondition.
  // The margin meter's ramp. These two numbers are the whole design decision,
  // and they are set from what the detector actually emits rather than from
  // thirds of its axis — so the reference points are pinned here beside the
  // boundaries, where a later tidy-up has to read them before moving anything.
  describe("cutConfidence", () => {
    it("bands are half-open upward", () => {
      expect(cutConfidence(0)).toBe("low");
      expect(cutConfidence(0.249)).toBe("low");
      expect(cutConfidence(0.25)).toBe("mid");
      expect(cutConfidence(0.499)).toBe("mid");
      expect(cutConfidence(0.5)).toBe("high");
    });

    it("reads the values the detector really emits", () => {
      // FLOOR_SENSITIVITY: the lowest score that can exist at all, because the
      // scan runs `select='gt(scene,0.05)'`.
      expect(cutConfidence(0.05)).toBe("low");
      // The shipped default line. Amber straddles it on purpose: a boundary
      // sitting where the line ships is the definition of marginal.
      expect(cutConfidence(0.4)).toBe("mid");
      // Measured with the bundled ffmpeg: a hard cut between wholly unrelated
      // content. Real footage scores lower, so this is near the practical top.
      expect(cutConfidence(0.688)).toBe("high");
      expect(cutConfidence(0.709)).toBe("high");
      // Measured: black to white, the maximal possible frame change.
      expect(cutConfidence(1)).toBe("high");
    });

    // The meter clamps the FILL in CSS; the band function is asked about the
    // raw number, so it must answer for one out of range rather than throw.
    // `parse_scene_score` validates no range and the `ShotDetector` seam exists
    // so a learned detector can replace ffmpeg.
    it("answers for scores outside the axis", () => {
      expect(cutConfidence(1.6)).toBe("high");
      expect(cutConfidence(-0.4)).toBe("low");
      // Unknown is not confident: NaN reads as the low band, never green.
      expect(cutConfidence(Number.NaN)).toBe("low");
    });
  });

  describe("shotDescribeBlocker", () => {
    const span = { mediaId: "m1", srcStartUs: 0, srcEndUs: 1 };
    const batch = { done: 0, total: 2 };
    it("is null when the gate is live and nothing is running", () => {
      expect(shotDescribeBlocker("describe", null, null, null)).toBeNull();
    });
    it("falls back to the kind sentence for the unreachable gate states", () => {
      expect(shotDescribeBlocker("needs_selection", null, null, null)).toBe(
        "shots_panel.needs_video_clip",
      );
      expect(shotDescribeBlocker("needs_video_kind", null, null, null)).toBe(
        "shots_panel.needs_video_clip",
      );
    });
    // A sweep outranks a lone run in the reason it gives, because a sweep IS a
    // run: naming the lone one would tell the reviewer to wait for a model run
    // when the real wait is thirty of them.
    it("reports a sweep ahead of the run it is running", () => {
      expect(shotDescribeBlocker("describe", span, batch, null)).toBe(
        "shots_panel.describe_sweep_running",
      );
      expect(shotDescribeBlocker("describe", span, null, null)).toBe(
        "shots_panel.describe_running",
      );
    });
    // An apply reshapes the very rows a description is taken over, so the
    // window a press would send may not be a span any more by the time the
    // model answers.
    it("waits for an apply to finish", () => {
      expect(shotDescribeBlocker("describe", null, null, "split")).toBe(
        "shots_panel.measure_busy",
      );
    });
  });

  // A described row keeps its button: a model's answer is not a fact, and
  // asking again is a normal thing to want.
  it("offers a second run on a row that already has prose", async () => {
    shots.getMediaDescription.mockResolvedValue({
      covered_ranges: [[0, 6_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: [] },
      ],
    });
    await review();
    const button = await waitFor(() => {
      const found = screen.getByTestId("shots-describe-0");
      // The words are the glyph's accessible name, not its label: the press is
      // one icon in the card's action gutter (`ShotDescribeAction`).
      expect(found.getAttribute("aria-label")).toBe("Describe again");
      return found;
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
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
    // Shot 1 stays checked, so the reviewed id is itself the first survivor.
    shots.applyShotCuts.mockResolvedValue({ mode: "discard", layer_ids: ["l1"] });
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

  it("keeps reviewing the first segment after a split, because the split kept its id", async () => {
    await review();

    fireEvent.click(verb("split"));
    await waitFor(() => expect(shots.applyShotCuts).toHaveBeenCalled());
    // What `project:changed` delivers: `l1` survives as the left half, so the
    // selection keeps it and the Panel follows — the subject is now that
    // segment, reviewed on its own (shorter) window. Nothing here re-selects
    // and nothing clears: the Panel follows the selection, and that is all.
    act(() => {
      useProjectStore.getState().apply(fixtureAfterSplit());
    });

    await waitFor(() =>
      expect(shots.reduceShotReport).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ inUs: 0, outUs: 2_000_000 }),
      ),
    );
    expect(
      screen.queryByText("Select a video clip to review its shot cuts."),
    ).toBeNull();
    expect(screen.getByTestId("shots-apply")).toBeTruthy();
  });

  it("reviews the first survivor when a discard removed the reviewed segment", async () => {
    // Shot 1 unchecked: the FIRST segment goes, and the answer's only survivor
    // is the fresh id `fixtureAfterDiscardOfFirst` leaves standing.
    shots.applyShotCuts.mockResolvedValue({ mode: "discard", layer_ids: ["s2"] });
    await review();

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep shot 1" }));
    await waitFor(() => expect(verb("discard").disabled).toBe(false));
    fireEvent.click(verb("discard"));
    await waitFor(() => expect(shots.applyShotCuts).toHaveBeenCalled());

    // Adopted off the answer, so when `project:changed` delivers a project
    // without `l1`, `retainLayerSelection` finds `s2` in place and drops
    // nothing.
    await waitFor(() => expect(primaryLayerIdOf(currentSelection())).toBe("s2"));
    act(() => {
      useProjectStore.getState().apply(fixtureAfterDiscardOfFirst());
    });

    // The Panel follows the selection onto the survivor's own source window.
    await waitFor(() =>
      expect(shots.reduceShotReport).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ inUs: 2_000_000, outUs: 6_000_000 }),
      ),
    );
    expect(
      screen.queryByText("Select a video clip to review its shot cuts."),
    ).toBeNull();
    expect(screen.getByTestId("shots-apply")).toBeTruthy();
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

// A running description JOB over a row (ADR 0121): this window's or an
// agent's, found by mapping the job's timeline window through its layer into
// source time. Rows: shot 1 over source [0, 2 s), shot 2 over [2 s, 6 s); the
// clip `l1` sits at 1 s, so source 2 s is timeline 3 s.
describe("ShotsPanel — a running description job", () => {
  let revision = 5_000_000;
  const job = (over: Partial<ComputeJob> & { phase: ComputePhase }): ComputeJob => ({
    job_id: "job-1",
    tool: "describe_clip",
    purpose: "shot",
    layer_id: "l1",
    media_id: "m1",
    window: { t_start_us: 3_000_000, t_end_us: 7_000_000 },
    phase_since: new Date().toISOString(),
    started_at: new Date().toISOString(),
    origin: { kind: "agent", client: "claude" },
    callers: 1,
    caller_disconnected: false,
    request_ids: [],
    ...over,
  });
  const publish = (jobs: ComputeJob[]) =>
    act(() => receiveComputeJobs({ revision: ++revision, jobs }));

  beforeEach(() => {
    shots.shotFloorReportCached.mockResolvedValue(true);
    shots.cancelComputeJob.mockResolvedValue(true);
  });
  afterEach(() => publish([]));

  async function review(): Promise<HTMLElement[]> {
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    return await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
  }
  const statusIn = (row: HTMLElement | undefined) =>
    row?.querySelector<HTMLElement>(".shots-description .compute-job-status") ?? null;

  it.each(["clip", undefined] as const)("does not display %s description progress or Cancel on shot rows", async (purpose) => {
    const rows = await review();
    const current = job({ phase: { kind: "loading_model" } });
    if (purpose === undefined) delete current.purpose;
    else current.purpose = purpose;
    publish([current]);
    for (const row of rows) expect(statusIn(row)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel description" })).toBeNull();
    expect(screen.queryByText("Loading model")).toBeNull();
  });

  it("does not display clip description progress when there are no shot rows", async () => {
    shots.shotFloorReportCached.mockResolvedValue(false);
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await screen.findByText(/has not been analyzed for shot cuts yet/);
    publish([job({ purpose: "clip", phase: { kind: "loading_model" } })]);
    expect(screen.queryByTestId("shots-describe-jobs")).toBeNull();
  });

  it("keeps clip progress out of local button tooltips and errors out of the panel", async () => {
    const rows = await review();
    act(() => setDescribing({ purpose: "clip", mediaId: "m1", srcStartUs: 0, srcEndUs: 6_000_000, requestId: "clip-run" }));
    publish([job({ purpose: "clip", request_ids: ["clip-run"], phase: { kind: "loading_model" } })]);
    for (const row of rows) expect(statusIn(row)).toBeNull();
    // Shared model admission may disable a button, but it must not present
    // another purpose's loading phase or Cancel as its own operation.
    expect(screen.getByTestId("shots-describe-0").title).not.toBe("Loading model");
    expect(screen.getByTestId("shots-describe-all").title).not.toBe("Loading model");
    act(() => setDescribeError("clip", "clip-only failure"));
    expect(screen.queryByTestId("shots-describe-error")).toBeNull();
    act(() => setDescribeError("shot", "shot-only failure"));
    expect(screen.getByTestId("shots-describe-error").textContent).toContain("shot-only failure");
    act(() => setDescribeError("clip", ""));
    expect(useDescriptionsStore.getState().errors.shot).toBe("shot-only failure");
  });

  it("selects a shot job even when an older clip job overlaps the same row", async () => {
    const rows = await review();
    publish([
      job({ purpose: "clip", job_id: "clip-job", started_at: "2026-01-01T00:00:00Z", phase: { kind: "loading_model" } }),
      job({ purpose: "shot", job_id: "shot-job", started_at: "2026-01-01T00:00:01Z", phase: { kind: "extracting", done: 2, total: 4 } }),
    ]);
    expect(statusIn(rows[1])?.textContent).toContain("Sampling frames 2/4");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Cancel description" }));
    await waitFor(() => expect(shots.cancelComputeJob).toHaveBeenCalledWith("shot-job"));
  });

  it("shows an agent's job on the rows its window covers, with Cancel, and nowhere else", async () => {
    const rows = await review();
    publish([job({ phase: { kind: "extracting", done: 3, total: 10 } })]);
    const status = statusIn(rows[1]);
    expect(status?.textContent).toContain("Sampling frames 3/10");
    expect(status?.dataset.phase).toBe("extracting");
    // In place of "Describing": the job line is the transient now.
    expect(rows[1]?.querySelector(".shots-description-empty")).toBeNull();
    expect(statusIn(rows[0])).toBeNull();
    expect(rows[0]?.textContent).toContain("Not described");

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Cancel description" }));
    await waitFor(() => expect(shots.cancelComputeJob).toHaveBeenCalledWith("job-1"));
  });

  it("shows the waiting state on every row a queued job covers", async () => {
    const rows = await review();
    // A whole-clip window from another clip of the same source: `lg1` is not
    // m1, so a second m1 layer is placed on the root for the job to name.
    act(() => {
      const other = clip({ id: "l9", mediaId: "m1", tStartUs: 10_000_000 });
      const summary = fixture();
      summary.compositions[ROOT_ID]!.tracks.push(track("t9", [other]));
      useProjectStore.getState().apply(summary);
    });
    publish([
      job({
        layer_id: "l9",
        window: { t_start_us: 10_000_000, t_end_us: 16_000_000 },
        phase: { kind: "queued", reason: "memory" },
      }),
    ]);
    for (const row of rows) {
      const status = statusIn(row);
      expect(status?.classList.contains("state-waiting")).toBe(true);
      expect(status?.textContent).toContain("Waiting for memory to free up");
      expect(status?.querySelector(".lucide-hourglass")).not.toBeNull();
    }
  });

  it("shows a job's status and Cancel on a source never analyzed for shots", async () => {
    // No scan, so no rows: the job's line must still have a home (#67).
    shots.shotFloorReportCached.mockResolvedValue(false);
    openComposition(ROOT_ID, null);
    setLayerSelection("l1", ["l1"]);
    render(<ShotsPanel />);
    await screen.findByText(/has not been analyzed for shot cuts yet/);
    publish([job({ phase: { kind: "extracting", done: 2, total: 8 } })]);
    const panel = await screen.findByTestId("shots-describe-jobs");
    expect(panel.textContent).toContain("Sampling frames 2/8");
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel description" }));
    await waitFor(() => expect(shots.cancelComputeJob).toHaveBeenCalledWith("job-1"));
  });

  it("lists a job no row covers at the panel level, and a covered one only on its rows", async () => {
    const rows = await review();
    // Timeline [8 s, 9 s) through l1 (at 1 s) is source [7 s, 8 s): past both rows.
    publish([
      job({ job_id: "job-out", window: { t_start_us: 8_000_000, t_end_us: 9_000_000 }, phase: { kind: "loading_model" } }),
      job({ job_id: "job-in", phase: { kind: "inferring" } }),
    ]);
    const panel = await screen.findByTestId("shots-describe-jobs");
    expect(panel.querySelectorAll(".compute-job-status")).toHaveLength(1);
    expect(panel.textContent).toContain("Loading model");
    expect(statusIn(rows[1])).not.toBeNull();
  });

  it("says what this window's own run is doing on the buttons it greys", async () => {
    shots.describeClip.mockReturnValue(new Promise(() => {}));
    await review();
    fireEvent.click(screen.getByTestId("shots-describe-1"));
    await waitFor(() => expect(shots.describeClip).toHaveBeenCalled());
    const { requestId } = shots.describeClip.mock.calls[0]![0] as { requestId: string };
    const other = screen.getByTestId("shots-describe-0") as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    // Before the job is mirrored, the generic reason.
    expect(other.title).toBe("A description is already running");
    publish([job({ origin: { kind: "user" }, request_ids: [requestId], phase: { kind: "loading_model" } })]);
    expect(other.title).toBe("Loading model");
    expect(screen.getByTestId("shots-describe-all").title).toBe("Loading model");
  });
});
