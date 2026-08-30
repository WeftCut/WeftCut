// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// Partial, not wholesale: the composition switch under test runs the REAL
// `openComposition`, and that calls back into navigation (`collapseReveal`).
vi.mock("../state/navigation", async (importActual) => ({
  ...(await importActual<typeof import("../state/navigation")>()),
  jumpToLayer: vi.fn(() => true),
  jumpToTimeUs: vi.fn(),
}));

const marker = vi.hoisted(() => ({
  renameMarker: vi.fn().mockResolvedValue(undefined),
  setMarkerNote: vi.fn().mockResolvedValue(undefined),
  setMarkerColor: vi.fn().mockResolvedValue(undefined),
  detachMarker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  ...marker,
}));

import "../i18n"; // side effect: init global i18next (en-US fallback)
import { jumpToLayer, jumpToTimeUs } from "../state/navigation";
import {
  focusedCompositionId,
  openComposition,
  useCompositionAnchorStore,
} from "../state/compositionAnchorStore";
import { useProjectStore } from "../state/projectStore";
import { registerTimelinePanels } from "../workspace/timelinePanels";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
  ROOT_ID,
} from "../testing/summaryFixture";
import type { LayerSummary, MarkerSummary, ProjectSummary } from "../ipc";
import { MarkerPanel } from "./MarkerPanel";

const num = (value: number) => ({ mode: "Static" as const, value });

function clip(): LayerSummary {
  return {
    id: "l1",
    label: "shot 4",
    t_start_us: 0,
    t_end_us: 4_000_000,
    kind: "VideoClip",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: "m1",
      media_label: "beach.mp4",
      src_in_us: 0,
      src_out_us: 4_000_000,
      x: num(0), y: num(0), scale_x: num(1), scale_y: num(1), scale_linked: true,
      rotation_deg: num(0), anchor_x: num(0.5), anchor_y: num(0.5), opacity: num(1),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    },
  };
}

function marks(over: Partial<MarkerSummary> & { id: string; t_us: number }): MarkerSummary {
  return {
    end_t_us: null,
    label: "",
    note: "",
    color_hint: "#0080ff",
    anchor_layer: null,
    anchor_src_us: null,
    hibernating: false,
    ...over,
  };
}

/// Root at 30 fps holding a clip, a Group clip, and three markers — one free,
/// one awake and anchored, one asleep. Group 1 holds one marker of its own and
/// Group 2 holds none, so every section shape the Panel draws is present.
///
/// The Group clip starts at 0 with `src_in_us: 0`, which makes Group-local time
/// equal root time — an activation's projected seek is then the marker's own
/// `t_us` and the assertion is about the routing, not the arithmetic.
function fixtureSummary(): ProjectSummary {
  return summaryFixture({
    root: {
      duration_us: 10_000_000,
      tracks: [
        {
          id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
          muted: false, solo: false, role: "a-roll", transient: false,
          layers: [
            clip(),
            groupLayerFixture({ id: "lg", compositionId: "g1", tStartUs: 0, tEndUs: 6_000_000, srcOutUs: 6_000_000 }),
          ],
        },
      ],
      markers: [
        marks({ id: "free", t_us: 1_000_000, label: "chapter one", note: "opening" }),
        marks({ id: "awake", t_us: 2_000_000, label: "cut here", anchor_layer: "l1", anchor_src_us: 2_000_000 }),
        marks({
          id: "asleep", t_us: 3_000_000, label: "dog blinks", note: "worth keeping",
          anchor_layer: "l1", anchor_src_us: 61_500_000, hibernating: true,
        }),
      ],
    },
    groups: [
      compositionFixture({
        id: "g1",
        duration_us: 6_000_000,
        markers: [marks({ id: "inside", t_us: 4_000_000, label: "beat" })],
      }),
      compositionFixture({ id: "g2", duration_us: 1_000_000 }),
    ],
  });
}

const headings = () =>
  screen.getAllByRole("heading").map((h) => h.textContent);

const rowsUnder = (name: string) =>
  within(screen.getByRole("region", { name })).getAllByRole("listitem");

let openedTimelines: string[] = [];
let unregisterTimelinePanels = () => {};

beforeEach(() => {
  openedTimelines = [];
  // Which composition is focused decides whether activating a row RE-ENTERS a
  // timeline or seeks in the one already open, so a file that inherits another
  // file's focus asserts the wrong branch — and passes or fails on run order.
  // The anchor store is module state and outlives a `cleanup()`.
  useCompositionAnchorStore.setState({ anchors: new Map(), focusedId: null });
  unregisterTimelinePanels = registerTimelinePanels({
    open: (id) => openedTimelines.push(id),
    close: () => {},
  });
  useProjectStore.getState().apply(fixtureSummary());
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  unregisterTimelinePanels();
  vi.useRealTimers();
});

describe("MarkerPanel", () => {
  it("lists every marker in the project once, under the composition that owns it", () => {
    render(<MarkerPanel />);
    expect(headings()).toEqual(["Timeline (2)", "Group 1 (1)", "Group 2 (0)", "Hibernating (1)"]);
    expect(rowsUnder("Timeline")).toHaveLength(2);
    expect(rowsUnder("Group 1")).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: "Marker label" })).toHaveLength(4);
  });

  it("keeps the heading of a composition nothing is marked in, and reads it (0)", () => {
    render(<MarkerPanel />);
    const empty = screen.getByRole("region", { name: "Group 2" });
    expect(within(empty).getByRole("heading").textContent).toBe("Group 2 (0)");
    expect(within(empty).queryAllByRole("listitem")).toHaveLength(0);
  });

  // Standing on the root, as the pair below does: a seek means nothing until
  // some timeline is open, so entering from nothing open would also open the
  // root and the assertion would be about the cold start rather than about the
  // Group.
  it("opens a Group's own timeline before seeking into it", () => {
    openComposition(ROOT_ID, null);
    openedTimelines = [];
    render(<MarkerPanel />);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Group 1" })).getByRole("button", {
        name: /Go to/,
      }),
    );
    expect(openedTimelines).toEqual(["g1"]);
    expect(focusedCompositionId()).toBe("g1");
    expect(jumpToTimeUs).toHaveBeenCalledWith(4_000_000);
  });

  it("seeks a marker of the timeline already in focus without re-entering it", () => {
    openComposition(ROOT_ID, null);
    openedTimelines = [];
    render(<MarkerPanel />);
    fireEvent.click(
      within(rowsUnder("Timeline")[0]!).getByRole("button", { name: /Go to/ }),
    );
    expect(openedTimelines).toEqual([]);
    expect(focusedCompositionId()).toBe(ROOT_ID);
    expect(jumpToTimeUs).toHaveBeenCalledWith(1_000_000);
  });

  it("shows a hibernating marker under Hibernating and nowhere else, at a position in the footage", () => {
    render(<MarkerPanel />);
    const asleep = rowsUnder("Hibernating");
    expect(asleep).toHaveLength(1);
    // 61.5 s into the source, and named as a source position rather than a
    // timeline one — no composition holds that frame.
    expect(within(asleep[0]!).getByRole("button", { name: /reveal the anchoring clip/ }).textContent)
      .toBe("00:01:01.500");
    expect(within(asleep[0]!).getByText("shot 4")).toBeTruthy();
    for (const row of rowsUnder("Timeline"))
      expect(within(row).queryByText("worth keeping")).toBeNull();
  });

  it("reveals the anchoring clip from a hibernating row instead of seeking a time", () => {
    render(<MarkerPanel />);
    fireEvent.click(
      within(rowsUnder("Hibernating")[0]!).getByRole("button", {
        name: /reveal the anchoring clip/,
      }),
    );
    expect(jumpToLayer).toHaveBeenCalledWith("l1");
    expect(jumpToTimeUs).not.toHaveBeenCalled();
  });

  it("offers Detach on a hibernating row — the one exit from hibernation", () => {
    render(<MarkerPanel />);
    const row = rowsUnder("Hibernating")[0]!;
    fireEvent.click(within(row).getByRole("button", { name: "Detach" }));
    expect(marker.detachMarker).toHaveBeenCalledWith("asleep");
    // Detach is the hibernating section's own action: an awake row has no
    // business offering it, because the anchor is still doing its job.
    for (const awake of rowsUnder("Timeline"))
      expect(within(awake).queryByRole("button", { name: "Detach" })).toBeNull();
  });

  it("offers no editable time on any row, hibernating or not", () => {
    render(<MarkerPanel />);
    const names = screen
      .getAllByRole("textbox")
      .map((el) => el.getAttribute("aria-label"));
    expect(new Set(names)).toEqual(new Set(["Marker label", "Marker note"]));
  });

  it("commits a label once on blur, and nothing at all when the field is left alone", () => {
    render(<MarkerPanel />);
    const label = within(rowsUnder("Timeline")[0]!).getByRole("textbox", { name: "Marker label" });
    fireEvent.blur(label);
    expect(marker.renameMarker).not.toHaveBeenCalled();
    fireEvent.change(label, { target: { value: "chapter two" } });
    fireEvent.blur(label);
    expect(marker.renameMarker).toHaveBeenCalledTimes(1);
    expect(marker.renameMarker).toHaveBeenCalledWith("free", "chapter two");
  });

  it("commits a note as one update, and Escape abandons the edit instead", () => {
    render(<MarkerPanel />);
    const note = within(rowsUnder("Timeline")[0]!).getByRole("textbox", { name: "Marker note" });
    fireEvent.change(note, { target: { value: "recut" } });
    fireEvent.blur(note);
    expect(marker.setMarkerNote).toHaveBeenCalledTimes(1);
    expect(marker.setMarkerNote).toHaveBeenCalledWith("free", "recut");

    fireEvent.change(note, { target: { value: "abandoned" } });
    fireEvent.keyDown(note, { key: "Escape" });
    fireEvent.blur(note);
    expect(marker.setMarkerNote).toHaveBeenCalledTimes(1);
  });

  it("spends one undo entry per colour gesture, however many values the swatch streams", () => {
    vi.useFakeTimers();
    render(<MarkerPanel />);
    const swatch = within(rowsUnder("Timeline")[0]!).getByLabelText("Marker color");
    for (const hex of ["#112233", "#223344", "#334455"])
      fireEvent.change(swatch, { target: { value: hex } });
    vi.runAllTimers();
    expect(marker.setMarkerColor).toHaveBeenCalledTimes(1);
    expect(marker.setMarkerColor).toHaveBeenCalledWith("free", {
      r: 0x33, g: 0x44, b: 0x55, a: 255,
    });
  });

  it("folds a section's rows away and keeps its heading standing", () => {
    render(<MarkerPanel />);
    const toggle = within(screen.getByRole("region", { name: "Timeline" })).getByRole("button", {
      name: "Timeline (2)",
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(screen.getByRole("region", { name: "Timeline" })).queryAllByRole("listitem"))
      .toHaveLength(0);
    expect(headings()).toContain("Timeline (2)");
  });
});
