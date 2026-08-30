// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n"; // real en-US bundle, so a tooltip is the shipped string
import type {
  AnimTrack,
  AppSettings,
  AppSettingsPatch,
  LayerSummary,
  MarkerSummary,
  TrackSummary,
} from "../ipc";
import { summaryFixture } from "../testing/summaryFixture";

// jsdom does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .button / .clientX (the same shim
// Timeline.interaction.test.tsx and TransformGizmo.test.tsx use).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

const ipcMocks = vi.hoisted(() => ({
  moveMarker: vi.fn(),
  removeMarker: vi.fn(),
  attachMarker: vi.fn(),
  detachMarker: vi.fn(),
  appSettingsSet: vi.fn(),
  logEmit: vi.fn(),
}));

// `markerAnchorFor` stays REAL: it is the rule the Attach row is gated on, and
// a stub would leave the gate testing itself.
vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    moveMarker: ipcMocks.moveMarker,
    removeMarker: ipcMocks.removeMarker,
    attachMarker: ipcMocks.attachMarker,
    detachMarker: ipcMocks.detachMarker,
    appSettingsSet: ipcMocks.appSettingsSet,
    logEmit: ipcMocks.logEmit,
  };
});

import { useProjectStore } from "../state/projectStore";
import {
  closeMarkerRenamePrompt,
  useMarkerRenamePromptStore,
} from "./markerRenamePrompt";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { setTimelineScrollLeftPx } from "../state/timelineScrollStore";
import { useSelectionStore } from "../state/selectionStore";
import {
  DROP_STRIP_HEIGHT_PX,
  MARKER_LANE_COLLAPSED_HEIGHT_PX,
  MARKER_LANE_HEIGHT_PX,
} from "./geometry";
import { MarkerLane, MarkerLaneHeader } from "./MarkerLane";

afterEach(cleanup);
// Every store here is renderer-global; reset them so each case starts at the row
// head with no markers, the lane expanded and the marks shown.
beforeEach(() => {
  setTimelineScrollLeftPx(null, 0);
  useProjectStore.setState({ summary: null });
  setSettings({ markers_visible: true, marker_lane_collapsed: false });
  // The store's own write path, minus the disk: `setAppSettings` awaits the IPC
  // and hydrates whatever comes back, so the toggle under test is exercised end
  // to end rather than stubbed at the store.
  ipcMocks.appSettingsSet.mockImplementation((patch: AppSettingsPatch) =>
    Promise.resolve({
      ...useAppSettingsStore.getState().settings,
      ...patch,
    } as AppSettings),
  );
});

const setSettings = (patch: Partial<AppSettings>) =>
  useAppSettingsStore.setState((s) => ({
    settings: { ...s.settings, ...patch },
  }));

/// 4 s row at 2000 px/s at 30 fps, so 1 s of marker time is 2000 px of row and
/// every frame is 66.7 px — wide enough that a one-frame region is a capsule and
/// a shorter one is not.
const renderLane = ({ pxPerSec = 2000 }: { pxPerSec?: number } = {}) => {
  const widthPx = 4 * pxPerSec;
  return render(
    <MarkerLane
      compositionId={null}
      pxPerSec={pxPerSec}
      widthPx={widthPx}
      viewportWidthPx={widthPx}
      fpsNum={30}
      fpsDen={1}
    />,
  );
};

/// Only the root's `markers` carry content; the lane reads them through the open
/// composition, so the seed goes through `apply` (which also opens it). `tracks`
/// is for the anchoring rows alone — they read the clip the selection names out
/// of the same composition.
const seed = (markers: MarkerSummary[], tracks: TrackSummary[] = []) => {
  useProjectStore.getState().apply(summaryFixture({ root: { markers, tracks } }));
};

const staticNum = (value: number): AnimTrack<number> => ({
  mode: "Static",
  value,
});

/// A clip at `[1 s, 3 s)` over source `[2 s, 4 s)`, so the mark at 1 s that
/// `point()` makes falls inside it and names source 2 s.
const clipTrack = (
  over: Partial<Pick<LayerSummary, "id" | "t_start_us" | "t_end_us">> = {},
): TrackSummary => ({
  id: "track-1",
  kind: "Video",
  label: null,
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: null,
  transient: true,
  layers: [
    {
      id: "clip-1",
      label: null,
      t_start_us: 1_000_000,
      t_end_us: 3_000_000,
      kind: "VideoClip",
      color_hint: "#5588aa",
      enabled: true,
      locked: false,
      effects: [],
      params: {
        kind: "VideoClip",
        media_id: "media-1",
        media_label: "clip.mov",
        src_in_us: 2_000_000,
        src_out_us: 4_000_000,
        x: staticNum(0),
        y: staticNum(0),
        scale_x: staticNum(1),
        scale_y: staticNum(1),
        scale_linked: true,
        rotation_deg: staticNum(0),
        anchor_x: staticNum(0.5),
        anchor_y: staticNum(0.5),
        opacity: staticNum(1),
        speed: 1,
        flip_h: false,
        flip_v: false,
        fade_in_us: 0,
        fade_out_us: 0,
      },
      ...over,
    },
  ],
});

/// The marker menu's rows in order: two for maintaining the marker, two for the
/// anchoring the glossary spells Attach to clip / Detach.
const MARKER_MENU_ROWS = ["Rename", "Delete marker", "Attach to clip", "Detach"];

const selectLayers = (...ids: string[]) =>
  useSelectionStore.setState({
    selection:
      ids.length === 0
        ? { kind: "none" }
        : { kind: "layers", primary: ids[0]!, ids: new Set(ids) },
  });

const point = (over: Partial<MarkerSummary> = {}): MarkerSummary => ({
  id: "point-1",
  t_us: 1_000_000,
  end_t_us: null,
  label: "",
  note: "",
  color_hint: "#ff8800",
  anchor_layer: null,
  hibernating: false,
  ...over,
});

const region = (over: Partial<MarkerSummary> = {}): MarkerSummary => ({
  id: "region-1",
  t_us: 1_000_000,
  end_t_us: 2_000_000,
  label: "",
  note: "",
  color_hint: "#22cc55",
  anchor_layer: null,
  hibernating: false,
  ...over,
});

const lane = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>('[data-testid="timeline-marker-lane"]')!;

const layer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="timeline-marker-layer"]');

const marks = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="timeline-marker"]'),
  );

const markById = (container: HTMLElement, id: string): HTMLElement =>
  container.querySelector<HTMLElement>(
    `[data-testid="timeline-marker"][data-marker-id="${id}"]`,
  )!;

const labels = (container: HTMLElement): string[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="timeline-marker-label"]',
    ),
  ).map((el) => el.textContent ?? "");

describe("the lane is permanent", () => {
  it("holds its row with no markers in the project", () => {
    const { container } = renderLane();
    expect(lane(container)).not.toBeNull();
    expect(lane(container).style.height).toBe(`${MARKER_LANE_HEIGHT_PX}px`);
    // No marks and no LAYER either — "hidden" has to mean gone, or an empty
    // wrapper leaves "painted transparently" and "not painted" the same picture.
    expect(marks(container)).toHaveLength(0);
    expect(layer(container)).toBeNull();
  });

  it("holds its row with the marks switched off", () => {
    setSettings({ markers_visible: false });
    seed([point(), region({ t_us: 2_000_000, end_t_us: 3_000_000 })]);
    const { container } = renderLane();
    expect(lane(container)).not.toBeNull();
    expect(lane(container).style.height).toBe(`${MARKER_LANE_HEIGHT_PX}px`);
    expect(marks(container)).toHaveLength(0);
    expect(layer(container)).toBeNull();
  });

  // The trap this exists to keep shut: `M` force-enables `markers_visible`, so a
  // lane whose EXISTENCE answered to that flag would reflow the timeline under
  // the pointer on every press.
  it("changes no height when the marks are hidden and shown again", () => {
    seed([point()]);
    const { container } = renderLane();
    const height = lane(container).style.height;
    act(() => setSettings({ markers_visible: false }));
    expect(lane(container).style.height).toBe(height);
    act(() => setSettings({ markers_visible: true }));
    expect(lane(container).style.height).toBe(height);
    expect(marks(container)).toHaveLength(1);
  });

  it("brings the marks back on the same mount, with no project reload", () => {
    seed([point(), region({ t_us: 2_000_000, end_t_us: 3_000_000 })]);
    const { container } = renderLane();
    expect(marks(container)).toHaveLength(2);
    act(() => setSettings({ markers_visible: false }));
    expect(marks(container)).toHaveLength(0);
    act(() => setSettings({ markers_visible: true }));
    expect(marks(container)).toHaveLength(2);
  });

  it("appears the moment a marker is created and goes the moment it is undone", () => {
    const { container } = renderLane();
    act(() => seed([point()]));
    expect(marks(container)).toHaveLength(1);
    act(() => seed([]));
    expect(marks(container)).toHaveLength(0);
  });

  // Neither a scrub surface nor a selection surface: the scroll body above the
  // lane starts a marquee on pointerdown, and a press that reached it from here
  // would be a box the user never asked to draw.
  it("lets no press escape to the surfaces around it", () => {
    const escaped: string[] = [];
    seed([point()]);
    const { container } = render(
      <div
        onPointerDown={() => escaped.push("down")}
        onClick={() => escaped.push("click")}
      >
        <MarkerLane
          compositionId={null}
          pxPerSec={2000}
          widthPx={8000}
          viewportWidthPx={8000}
          fpsNum={30}
          fpsDen={1}
        />
      </div>,
    );
    fireEvent.pointerDown(lane(container), { button: 0, clientX: 2000 });
    fireEvent.click(lane(container));
    fireEvent.pointerDown(markById(container, "point-1"), {
      button: 0,
      clientX: 2000,
    });
    expect(escaped).toEqual([]);
  });
});

describe("glyph geometry", () => {
  // Anchored, so the colour lands as a FILL — a free marker carries the same
  // colour as a ring instead (see "anchored and free read apart").
  it("puts a point marker's mark on its own time, in its author's colour", () => {
    seed([
      point({
        t_us: 1_500_000,
        color_hint: "#ff8800",
        anchor_layer: "clip-1",
      }),
    ]);
    const { container } = renderLane();
    const mark = markById(container, "point-1");
    expect(mark.style.left).toBe("3000px");
    expect(mark.style.background).toBe("rgb(255, 136, 0)");
  });

  it("spans a region marker's capsule across its range, in its author's colour", () => {
    seed([
      region({
        t_us: 500_000,
        end_t_us: 1_500_000,
        color_hint: "#22cc55",
        anchor_layer: "clip-1",
      }),
    ]);
    const { container } = renderLane();
    const mark = markById(container, "region-1");
    expect(mark.style.left).toBe("1000px");
    expect(mark.style.width).toBe("2000px");
    expect(mark.style.background).toBe("rgb(34, 204, 85)");
  });

  it("keeps every glyph inside the lane it sits in", () => {
    // A point glyph is a rotated square, so what it paints is its DIAGONAL —
    // sizing against the side is how a diamond ends up taller than its row.
    seed([point(), region({ t_us: 2_000_000, end_t_us: 3_000_000 })]);
    const { container } = renderLane();
    expect(marks(container)).toHaveLength(2);
    for (const mark of marks(container)) {
      const top = Number.parseFloat(mark.style.top);
      const height = Number.parseFloat(mark.style.height);
      const painted =
        mark.dataset.shape === "point" ? height * Math.SQRT2 : height;
      const centre = top + height / 2;
      expect(centre - painted / 2).toBeGreaterThanOrEqual(0);
      expect(centre + painted / 2).toBeLessThanOrEqual(MARKER_LANE_HEIGHT_PX);
    }
  });

  it("outlines a mark both dark and light, so no authored colour can vanish", () => {
    // The lane is near-black, so one dark hairline separates a BRIGHT marker
    // from the background and leaves a near-black one (this case's colour) a
    // smudge. The light ring outside it carries that half of the guarantee.
    seed([point({ color_hint: "#14141a" })]);
    const { container } = renderLane();
    const outline = markById(container, "point-1").style.boxShadow;
    expect(outline).toContain("rgba(0,0,0,0.7)");
    expect(outline).toContain("rgba(255,255,255,0.4)");
  });

  // The degrade may drop the region's LENGTH; it may not move its START. A
  // degraded region begins at its x and nothing of it exists before, so the
  // glyph is nudged right by its rotation overhang instead of being centred the
  // way a true point marker is — otherwise ~5 px of mark paints over frames the
  // region does not cover.
  it("puts a degraded region's painted left edge on the region's start", () => {
    seed([
      point({ id: "true-point", t_us: 1_000_000 }),
      region({ id: "degraded", t_us: 2_000_000, end_t_us: 2_066_667 }),
    ]);
    const { container } = renderLane({ pxPerSec: 20 });
    // A true point straddles its frame: half its box sits left of it.
    expect(markById(container, "true-point").style.translate).toBe("-50%");
    // The degraded region does not. The offset is the 45° rotation's overhang —
    // half of (diagonal − side) for the glyph — so the painted edge, not just
    // the box edge, lands on the start.
    const degraded = markById(container, "degraded");
    const sizePx = Number.parseFloat(degraded.style.width);
    const nudge = (sizePx * (Math.SQRT2 - 1)) / 2;
    expect(Number.parseFloat(degraded.style.translate)).toBeCloseTo(nudge, 5);
    expect(degraded.style.left).toBe("40px");
  });

  it("groups the marks under one container", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        point({ id: `m${i}`, t_us: 100_000 * (i + 1) }),
      );
    const { container } = renderLane();
    act(() => seed(many(30)));
    expect(marks(container)).toHaveLength(30);
    for (const mark of marks(container)) {
      expect(layer(container)!.contains(mark)).toBe(true);
    }
  });
});

// Solid is anchored, hollow is free. No tether line to the anchoring clip: the
// clip may be several lanes away, so the line would cross the whole lane region
// to say one bit.
describe("anchored and free read apart", () => {
  it("fills an anchored marker and hollows out a free one", () => {
    seed([
      point({ id: "free", t_us: 500_000, color_hint: "#ff8800" }),
      point({
        id: "tied",
        t_us: 1_500_000,
        color_hint: "#ff8800",
        anchor_layer: "clip-1",
      }),
    ]);
    const { container } = renderLane();
    const free = markById(container, "free");
    const tied = markById(container, "tied");

    expect(free.dataset.anchored).toBe("false");
    expect(tied.dataset.anchored).toBe("true");
    expect(tied.style.background).toBe("rgb(255, 136, 0)");
    expect(free.style.background).toBe("transparent");
    // The hollow one still shows its colour — as a ring, not a fill.
    expect(free.style.boxShadow).toContain("#ff8800");
  });

  // Retained in state, never painted: it is anchored at source its clip no
  // longer shows, so it has no position on this timeline to paint at. It revives
  // on its own when the clip's window covers it again.
  it("paints nothing for a hibernating marker", () => {
    seed([
      point({ id: "awake", t_us: 500_000 }),
      point({
        id: "asleep",
        t_us: 1_500_000,
        anchor_layer: "clip-1",
        hibernating: true,
      }),
    ]);
    const { container } = renderLane();
    expect(marks(container).map((m) => m.dataset.markerId)).toEqual(["awake"]);
  });
});

// The whole point of the lane: a mark's name without a hover, without a click,
// without a panel.
describe("labels", () => {
  it("prints a point marker's name beside it, unhovered", () => {
    seed([point({ label: "cut here" })]);
    const { container } = renderLane();
    expect(labels(container)).toEqual(["cut here"]);
  });

  it("prints a region marker's name inside its capsule", () => {
    seed([region({ label: "needs VO" })]);
    const { container } = renderLane();
    const label = container.querySelector<HTMLElement>(
      '[data-testid="timeline-marker-label"]',
    )!;
    expect(label.textContent).toBe("needs VO");
    expect(markById(container, "region-1").contains(label)).toBe(true);
  });

  it("prints nothing for an unlabelled marker", () => {
    // The tooltip's translated fallback names it; a lane that printed "Marker"
    // beside every unnamed mark would be noise, not information.
    seed([point({ label: "" }), point({ id: "p2", t_us: 2_000_000, label: "  " })]);
    const { container } = renderLane();
    expect(labels(container)).toEqual([]);
  });

  // Past its neighbour's x a label reads as the neighbour's name.
  it("stops a point's label where the next mark begins", () => {
    seed([
      point({ id: "a", t_us: 1_000_000, label: "a very long marker name" }),
      point({ id: "b", t_us: 1_500_000, label: "next" }),
    ]);
    const { container } = renderLane();
    const first = container.querySelector<HTMLElement>(
      '[data-testid="timeline-marker-label"][data-marker-id="a"]',
    )!;
    // 500 ms at 2000 px/s is 1000 px of room, less the clearance the diamond
    // itself takes.
    expect(Number.parseFloat(first.style.maxWidth)).toBeGreaterThan(980);
    expect(Number.parseFloat(first.style.maxWidth)).toBeLessThan(1000);
  });

  it("leaves the last mark's label unbounded", () => {
    seed([point({ id: "a", t_us: 1_000_000, label: "the only one" })]);
    const { container } = renderLane();
    const only = container.querySelector<HTMLElement>(
      '[data-testid="timeline-marker-label"]',
    )!;
    expect(only.style.maxWidth).toBe("");
  });
});

describe("hover text", () => {
  it("reads out a point marker as label · timecode", () => {
    seed([point({ t_us: 1_000_000, label: "cut here" })]);
    const { container } = renderLane();
    expect(markById(container, "point-1").title).toBe("cut here · 00:00:01:00");
  });

  it("reads out a region marker as label · start – end", () => {
    seed([region({ t_us: 1_000_000, end_t_us: 2_000_000, label: "needs VO" })]);
    const { container } = renderLane();
    expect(markById(container, "region-1").title).toBe(
      "needs VO · 00:00:01:00 – 00:00:02:00",
    );
  });

  it("still reads out the real range for a region too narrow to paint as a capsule", () => {
    // Zoomed out to 20 px/s, a two-frame region is 1.3 px — under the capsule
    // threshold. The shape degrades to a point AT THE REGION'S START; the hover
    // text keeps reporting the range the shape can no longer show.
    seed([region({ t_us: 1_000_000, end_t_us: 1_066_667, label: "blip" })]);
    const { container } = renderLane({ pxPerSec: 20 });
    const mark = markById(container, "region-1");
    expect(mark.dataset.shape).toBe("point");
    expect(mark.style.left).toBe("20px");
    expect(mark.title).toBe("blip · 00:00:01:00 – 00:00:01:02");
  });

  it("falls back to the translated noun when a marker carries no label", () => {
    seed([point({ t_us: 1_000_000, label: "" })]);
    const { container } = renderLane();
    expect(markById(container, "point-1").title).toBe("Marker · 00:00:01:00");
  });
});

// Collapse is a USER-initiated toggle, like track expand, so unlike the
// visibility flag its reflow is asked for and welcome.
describe("collapse", () => {
  it("gives back the 6 px and keeps every glyph", () => {
    seed([
      point({ label: "cut here" }),
      region({ t_us: 2_000_000, end_t_us: 3_000_000, label: "needs VO" }),
    ]);
    const { container } = renderLane();
    expect(lane(container).style.height).toBe(`${MARKER_LANE_HEIGHT_PX}px`);
    expect(labels(container)).toHaveLength(2);

    act(() => setSettings({ marker_lane_collapsed: true }));
    expect(lane(container).style.height).toBe(
      `${MARKER_LANE_COLLAPSED_HEIGHT_PX}px`,
    );
    expect(MARKER_LANE_HEIGHT_PX - MARKER_LANE_COLLAPSED_HEIGHT_PX).toBe(6);
    // Every mark survives — what goes is the text.
    expect(marks(container)).toHaveLength(2);
    expect(labels(container)).toHaveLength(0);
  });

  // A collapsed lane is a seam, not a lane to manage, so it is exactly as thick
  // as the other seam above the tracks.
  it("collapses to the drop strip's height", () => {
    expect(MARKER_LANE_COLLAPSED_HEIGHT_PX).toBe(DROP_STRIP_HEIGHT_PX);
  });

  it("keeps every glyph inside the shorter row too", () => {
    seed([point(), region({ t_us: 2_000_000, end_t_us: 3_000_000 })]);
    setSettings({ marker_lane_collapsed: true });
    const { container } = renderLane();
    for (const mark of marks(container)) {
      const top = Number.parseFloat(mark.style.top);
      const height = Number.parseFloat(mark.style.height);
      const painted =
        mark.dataset.shape === "point" ? height * Math.SQRT2 : height;
      const centre = top + height / 2;
      expect(centre - painted / 2).toBeGreaterThanOrEqual(0);
      expect(centre + painted / 2).toBeLessThanOrEqual(
        MARKER_LANE_COLLAPSED_HEIGHT_PX,
      );
    }
  });
});

describe("the lane header", () => {
  const twirl = (container: HTMLElement): HTMLElement =>
    container.querySelector<HTMLElement>(
      '[data-testid="timeline-marker-lane-twirl"]',
    )!;
  const header = (container: HTMLElement): HTMLElement =>
    container.querySelector<HTMLElement>(
      '[data-testid="timeline-marker-lane-header"]',
    )!;

  // The invariant the two columns live under: the header cell and the body lane
  // paint the same row, so a height either one owns alone slides every header
  // below it out of line with its lane.
  it("is exactly as tall as the lane, in both states", () => {
    const { container } = render(
      <>
        <MarkerLaneHeader />
        <MarkerLane
          compositionId={null}
          pxPerSec={2000}
          widthPx={8000}
          viewportWidthPx={8000}
          fpsNum={30}
          fpsDen={1}
        />
      </>,
    );
    expect(header(container).style.height).toBe(lane(container).style.height);
    act(() => setSettings({ marker_lane_collapsed: true }));
    expect(header(container).style.height).toBe(lane(container).style.height);
    expect(header(container).style.height).toBe(
      `${MARKER_LANE_COLLAPSED_HEIGHT_PX}px`,
    );
  });

  it("names the row it heads", () => {
    const { container } = render(<MarkerLaneHeader />);
    expect(header(container).textContent).toContain("Markers");
  });

  it("flips the collapse preference from the twirl", async () => {
    const { container } = render(<MarkerLaneHeader />);
    expect(twirl(container).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(twirl(container));
    await waitFor(() =>
      expect(
        useAppSettingsStore.getState().settings.marker_lane_collapsed,
      ).toBe(true),
    );
    expect(twirl(container).getAttribute("aria-expanded")).toBe("false");
    // App-level, not project state: the flip goes out as a settings patch, so it
    // never enters undo and never makes one project look different on two
    // machines.
    expect(ipcMocks.appSettingsSet).toHaveBeenCalledExactlyOnceWith({
      marker_lane_collapsed: true,
    });
  });
});

// Authoring separates by input channel: the RIGHT button opens the marker's
// menu. The popup portals to the body, so an open menu adds nothing to the lane.
describe("context menu", () => {
  beforeEach(() => {
    ipcMocks.removeMarker.mockReset().mockResolvedValue(undefined);
    ipcMocks.attachMarker.mockReset().mockResolvedValue(undefined);
    ipcMocks.detachMarker.mockReset().mockResolvedValue(undefined);
    useSelectionStore.setState({ selection: { kind: "none" } });
    closeMarkerRenamePrompt();
  });

  const openMenu = async (
    container: HTMLElement,
    id: string,
  ): Promise<HTMLElement[]> => {
    fireEvent.contextMenu(markById(container, id), {
      clientX: 80,
      clientY: 12,
    });
    return await waitFor(() => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(".app-menu-item"),
      );
      expect(items.length).toBeGreaterThan(0);
      return items;
    });
  };

  it("right-click on a glyph offers all four rows", async () => {
    seed([point()]);
    const { container } = renderLane();
    const items = await openMenu(container, "point-1");
    expect(items.map((i) => i.textContent)).toEqual(MARKER_MENU_ROWS);
  });

  it("opens from a point's label too, which is the bigger target", async () => {
    seed([point({ label: "cut here" })]);
    const { container } = renderLane();
    fireEvent.contextMenu(
      container.querySelector('[data-testid="timeline-marker-label"]')!,
      { clientX: 80, clientY: 12 },
    );
    const items = await waitFor(() => {
      const found = Array.from(
        document.querySelectorAll<HTMLElement>(".app-menu-item"),
      );
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(items.map((i) => i.textContent)).toEqual(MARKER_MENU_ROWS);
  });

  it("Rename routes the marker id to the prompt store — regions included", async () => {
    seed([region()]);
    const { container } = renderLane();
    const items = await openMenu(container, "region-1");
    fireEvent.click(items[0]!);
    expect(useMarkerRenamePromptStore.getState().markerId).toBe("region-1");
  });

  it("Delete goes straight through the channel, with nothing asked first", async () => {
    seed([point()]);
    const { container } = renderLane();
    const items = await openMenu(container, "point-1");
    fireEvent.click(items[1]!);
    await waitFor(() =>
      expect(ipcMocks.removeMarker).toHaveBeenCalledExactlyOnceWith("point-1"),
    );
    expect(useMarkerRenamePromptStore.getState().markerId).toBeNull();
  });
});

// The anchoring rows GREY OUT rather than vanish: a row that disappears teaches
// nothing about why, and both of these are unavailable far more often than they
// are available.
describe("anchoring rows", () => {
  beforeEach(() => {
    ipcMocks.attachMarker.mockReset().mockResolvedValue(undefined);
    ipcMocks.detachMarker.mockReset().mockResolvedValue(undefined);
    useSelectionStore.setState({ selection: { kind: "none" } });
    closeMarkerRenamePrompt();
  });
  afterEach(() => useSelectionStore.setState({ selection: { kind: "none" } }));

  const disabled = (items: HTMLElement[]): string[] =>
    items
      .filter((i) => i.getAttribute("aria-disabled") === "true")
      .map((i) => i.textContent ?? "");

  const openMenu = async (
    container: HTMLElement,
    id: string,
  ): Promise<HTMLElement[]> => {
    fireEvent.contextMenu(markById(container, id), {
      clientX: 80,
      clientY: 12,
    });
    return await waitFor(() => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(".app-menu-item"),
      );
      expect(items.length).toBe(MARKER_MENU_ROWS.length);
      return items;
    });
  };

  it("offers neither on a free marker with nothing selected", async () => {
    seed([point()], [clipTrack()]);
    const { container } = renderLane();
    expect(disabled(await openMenu(container, "point-1"))).toEqual([
      "Attach to clip",
      "Detach",
    ]);
  });

  // "The selected clip" needs the selection to name exactly one: the primary of
  // a set would tie the marker to a clip the row never mentioned.
  it("offers Attach for one selected clip and for no other count", async () => {
    seed([point()], [clipTrack()]);
    const { container } = renderLane();
    act(() => selectLayers("clip-1"));
    expect(disabled(await openMenu(container, "point-1"))).toEqual(["Detach"]);
    act(() => selectLayers("clip-1", "clip-2"));
    expect(disabled(await openMenu(container, "point-1"))).toEqual([
      "Attach to clip",
      "Detach",
    ]);
  });

  it("refuses Attach for a marker the selected clip does not cover", async () => {
    seed([point({ t_us: 3_500_000 })], [clipTrack()]);
    const { container } = renderLane();
    act(() => selectLayers("clip-1"));
    expect(disabled(await openMenu(container, "point-1"))).toEqual([
      "Attach to clip",
      "Detach",
    ]);
  });

  it("routes Attach to the channel with the marker and the clip it named", async () => {
    seed([point()], [clipTrack()]);
    const { container } = renderLane();
    act(() => selectLayers("clip-1"));
    const items = await openMenu(container, "point-1");
    fireEvent.click(items[2]!);
    await waitFor(() =>
      expect(ipcMocks.attachMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        "clip-1",
      ),
    );
  });

  // The one exit from hibernation — and a hibernating marker paints nothing, so
  // the row has to be reachable from a marker that IS painted. An anchored one
  // whose clip still shows it is that marker.
  it("offers Detach on an anchored marker", async () => {
    seed([point({ anchor_layer: "clip-1" })], [clipTrack()]);
    const { container } = renderLane();
    const items = await openMenu(container, "point-1");
    expect(disabled(items)).toEqual(["Attach to clip"]);
    fireEvent.click(items[3]!);
    await waitFor(() =>
      expect(ipcMocks.detachMarker).toHaveBeenCalledExactlyOnceWith("point-1"),
    );
  });
});

// The last of the three operations the marker menu cut, and the one that could
// only exist once the glyphs left the ruler: a left-press in this lane has no
// scrub to contest, so it means exactly one thing.
describe("dragging a marker", () => {
  beforeEach(() => {
    ipcMocks.moveMarker.mockReset().mockResolvedValue(undefined);
    // Off by default here so a case states the frame grid without the snap
    // targets also speaking; the one snapping case turns it back on.
    setSettings({ tail_snap_enabled: false });
  });

  /// Press, travel and release over a mark, in row px. 2000 px/s, so 1000 px is
  /// half a second.
  const dragBy = (container: HTMLElement, id: string, dxPx: number) => {
    fireEvent.pointerDown(markById(container, id), { button: 0, clientX: 0 });
    fireEvent.pointerMove(window, { clientX: dxPx });
    fireEvent.pointerUp(window, { clientX: dxPx });
  };

  it("commits the landing time as ONE patch at release", async () => {
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderLane();
    dragBy(container, "point-1", 1000);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        1_500_000,
        null,
      ),
    );
  });

  it("paints the mark where the pointer has it, before anything is committed", () => {
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderLane();
    fireEvent.pointerDown(markById(container, "point-1"), {
      button: 0,
      clientX: 0,
    });
    fireEvent.pointerMove(window, { clientX: 1000 });
    expect(markById(container, "point-1").style.left).toBe("3000px");
    expect(markById(container, "point-1").dataset.dragging).toBe("true");
    expect(ipcMocks.moveMarker).not.toHaveBeenCalled();
  });

  // Frame-quantised, so the glyph never sits where the commit cannot put it.
  it("previews on the frame grid, never on the raw pixel", () => {
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderLane();
    // 20 px is 10 ms — under half a frame at 30 fps, so the mark holds still.
    fireEvent.pointerDown(markById(container, "point-1"), {
      button: 0,
      clientX: 0,
    });
    fireEvent.pointerMove(window, { clientX: 20 });
    expect(markById(container, "point-1").style.left).toBe("2000px");
    // 50 px is 25 ms, which rounds up to the next frame.
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(markById(container, "point-1").style.left).toBe(
      `${(1_033_333 / 1_000_000) * 2000}px`,
    );
  });

  it("records nothing for a drag with no net movement", async () => {
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderLane();
    dragBy(container, "point-1", 0);
    // Out and back is the same non-edit: what counts is where it landed, so the
    // ONE call below is the one real move that follows.
    fireEvent.pointerDown(markById(container, "point-1"), {
      button: 0,
      clientX: 0,
    });
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window, { clientX: 0 });
    expect(ipcMocks.moveMarker).not.toHaveBeenCalled();
    dragBy(container, "point-1", 1000);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        1_500_000,
        null,
      ),
    );
  });

  // The gesture the whole lane exists to make possible, and the one the ruler
  // could never host: the scrub surface is elsewhere and this press never
  // reaches it.
  it("scrubs nothing on the way", () => {
    const escaped: string[] = [];
    seed([point({ t_us: 1_000_000 })]);
    const { container } = render(
      <div onPointerDown={() => escaped.push("down")}>
        <MarkerLane
          compositionId={null}
          pxPerSec={2000}
          widthPx={8000}
          viewportWidthPx={8000}
          fpsNum={30}
          fpsDen={1}
        />
      </div>,
    );
    dragBy(container, "point-1", 1000);
    expect(escaped).toEqual([]);
  });

  it("leaves the right button to the menu", async () => {
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderLane();
    fireEvent.pointerDown(markById(container, "point-1"), {
      button: 2,
      clientX: 0,
    });
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window, { clientX: 1000 });
    expect(markById(container, "point-1").style.left).toBe("2000px");
    expect(ipcMocks.moveMarker).not.toHaveBeenCalled();
    // And the menu the press was on its way to still opens.
    fireEvent.contextMenu(markById(container, "point-1"), {
      clientX: 80,
      clientY: 12,
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll<HTMLElement>(".app-menu-item").length,
      ).toBeGreaterThan(0),
    );
  });

  // The clamp is the renderer's half of the split: the gesture keeps the time
  // legal and the actor refuses an illegal one, so a mark held against an edge
  // STOPS there. It must not vanish — src_us at the clip's src_out is exactly
  // what puts a marker to sleep, and a glyph that disappeared under the cursor
  // is the worst answer a clamp can give.
  it("stops an anchored mark at its clip's last frame, still painted", async () => {
    seed([point({ t_us: 2_000_000, anchor_layer: "clip-1" })], [clipTrack()]);
    const { container } = renderLane();
    dragBy(container, "point-1", 6000);
    expect(markById(container, "point-1")).not.toBeNull();
    expect(markById(container, "point-1").style.left).toBe(
      `${(2_966_667 / 1_000_000) * 2000}px`,
    );
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        2_966_667,
        null,
      ),
    );
  });

  it("stops an anchored mark at its clip's start too", async () => {
    seed([point({ t_us: 2_000_000, anchor_layer: "clip-1" })], [clipTrack()]);
    const { container } = renderLane();
    dragBy(container, "point-1", -6000);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        1_000_000,
        null,
      ),
    );
  });

  it("never lets a free mark cross zero", async () => {
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderLane();
    dragBy(container, "point-1", -6000);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        0,
        null,
      ),
    );
  });

  // A region drags WHOLE. A FREE one has to carry its own end in the patch —
  // nothing else would move it — where an anchored one's end is carried by its
  // anchor and must NOT be sent, or the commit's reconcile would move it twice.
  it("carries a free region's end with it", async () => {
    seed([region({ t_us: 1_000_000, end_t_us: 2_000_000 })]);
    const { container } = renderLane();
    dragBy(container, "region-1", 1000);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "region-1",
        1_500_000,
        2_500_000,
      ),
    );
  });

  it("leaves an anchored region's end to its anchor", async () => {
    seed(
      [region({ t_us: 1_500_000, end_t_us: 2_000_000, anchor_layer: "clip-1" })],
      [clipTrack()],
    );
    const { container } = renderLane();
    dragBy(container, "region-1", 400);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "region-1",
        1_700_000,
        null,
      ),
    );
  });

  it("drags a point marker by its label, which is the bigger target", async () => {
    seed([point({ t_us: 1_000_000, label: "cut here" })]);
    const { container } = renderLane();
    fireEvent.pointerDown(
      container.querySelector('[data-testid="timeline-marker-label"]')!,
      { button: 0, clientX: 0 },
    );
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window, { clientX: 1000 });
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        1_500_000,
        null,
      ),
    );
  });

  // The preference the clip drag and the blade already obey; markers get no
  // second flag of their own. At 10 px/s a frame is 0.33 px, so the 12 px
  // strength reaches a clip edge from far outside the grid's own rounding.
  it("snaps to a clip edge under the timeline's own snap preference", async () => {
    setSettings({ tail_snap_enabled: true, tail_snap_strength_px: 12 });
    seed([point({ t_us: 2_000_000 })], [clipTrack()]);
    const { container } = renderLane({ pxPerSec: 10 });
    // 2 px right of 2 s is 2.2 s — 0.8 s short of the clip's end boundary, and
    // 8 px at this zoom.
    dragBy(container, "point-1", 2);
    await waitFor(() =>
      expect(ipcMocks.moveMarker).toHaveBeenCalledExactlyOnceWith(
        "point-1",
        3_000_000,
        null,
      ),
    );
  });
});
