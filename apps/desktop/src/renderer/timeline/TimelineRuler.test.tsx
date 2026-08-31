// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n"; // real en-US bundle, so a menu row is the shipped string
import type { MarkerSummary } from "../ipc";
import { summaryFixture } from "../testing/summaryFixture";

const ipcMocks = vi.hoisted(() => ({
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    logEmit: ipcMocks.logEmit,
  };
});

import { useProjectStore } from "../state/projectStore";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../state/timelineScrollStore";
import { hasMarkedRange, useRangeStore } from "../state/rangeStore";
import { registerCommandProvider } from "../commands/registry";
import { RULER_SCROLL_QUANTUM_PX } from "./rulerModel";
import { TimelineRuler } from "./TimelineRuler";

afterEach(cleanup);
// All three stores are renderer-global; reset them so each case starts at the
// row head with no marks and no markers, regardless of order.
beforeEach(() => {
  setTimelineScrollLeftPx(null, 0);
  useRangeStore.setState({ inUs: null, outUs: null });
  useProjectStore.setState({ summary: null });
});

/// The whole row fits the "viewport", so these cases assert tick CONTENT without
/// the window entering it (rulerModel.test.ts owns the windowing).
function renderWholeRow(props: {
  pxPerSec: number;
  totalSec: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const widthPx = props.totalSec * props.pxPerSec;
  return render(
    <TimelineRuler
      compositionId={null}
      pxPerSec={props.pxPerSec}
      totalSec={props.totalSec}
      widthPx={widthPx}
      viewportWidthPx={widthPx}
      fpsNum={props.fpsNum}
      fpsDen={props.fpsDen}
      onScrub={() => {}}
    />,
  );
}

const ticks = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="timeline-ruler"] > *',
    ),
  );

const majorLabels = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll("span")).map(
    (el) => el.textContent ?? "",
  );

describe("<TimelineRuler>", () => {
  it("labels every major tick with the timecode of its canonical time", () => {
    const { container } = renderWholeRow({
      pxPerSec: 2000,
      totalSec: 3,
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    // Expected timecodes derived from the frame INDEX (not from any µs math),
    // so a tick whose time had drifted onto a neighbouring frame would show up
    // as a mismatched label here.
    const expected: string[] = [];
    for (let f = 0; f <= 90; f += 2) {
      const s = Math.floor(f / 30);
      expected.push(
        `00:00:${String(s).padStart(2, "0")}:${String(f % 30).padStart(2, "0")}`,
      );
    }
    expect(majorLabels(container)).toEqual(expected);
  });

  it("labels second mode with mm:ss", () => {
    const { container } = renderWholeRow({
      pxPerSec: 80,
      totalSec: 10,
      fpsNum: 30,
      fpsDen: 1,
    });
    expect(majorLabels(container)).toEqual([
      "0:00",
      "0:02",
      "0:04",
      "0:06",
      "0:08",
      "0:10",
    ]);
  });

  it("keeps the width and the overflow clip that bound fit-zoom scroll", () => {
    const { container } = renderWholeRow({
      pxPerSec: 2000,
      totalSec: 3,
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    const ruler = container.querySelector<HTMLElement>(
      '[data-testid="timeline-ruler"]',
    )!;
    expect(ruler.style.width).toBe("6000px");
    expect(ruler.className).toContain("overflow-hidden");
    // `h-5` is coupled to the playhead knob's top offset (see the sizing note).
    expect(ruler.className).toContain("h-5");
  });

  it("paints a viewport-sized node set for a one-hour 60 fps row", () => {
    // The row is 7.2 M px wide, so the node set must stay viewport-sized.
    const { container } = render(
      <TimelineRuler
        compositionId={null}
        pxPerSec={2000}
        totalSec={3600}
        widthPx={7_200_000}
        viewportWidthPx={1200}
        fpsNum={60}
        fpsDen={1}
        onScrub={() => {}}
      />,
    );
    expect(ticks(container).length).toBeLessThan(100);
  });
});

describe("in/out end caps", () => {
  const cap = (container: HTMLElement, side: "in" | "out") =>
    container.querySelector<HTMLElement>(
      `[data-testid="timeline-range-cap-${side}"]`,
    );

  /// 4 s row at 2000 px/s, so 1 s of time is exactly 2000 px of row.
  const renderRuler = () =>
    renderWholeRow({ pxPerSec: 2000, totalSec: 4, fpsNum: 30, fpsDen: 1 });

  it("paints nothing while the timeline is unmarked", () => {
    const { container } = renderRuler();
    expect(cap(container, "in")).toBeNull();
    expect(cap(container, "out")).toBeNull();
  });

  it("paints each side independently", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    const { container } = renderRuler();
    expect(cap(container, "in")).not.toBeNull();
    expect(cap(container, "out")).toBeNull();
  });

  it("puts the in cap on the boundary", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    const { container } = renderRuler();
    expect(cap(container, "in")!.style.left).toBe("2000px");
  });

  // The end is EXCLUSIVE — the boundary is the right edge of the last kept
  // frame — so the bar sits one bar-width left of it. Getting this backwards
  // would draw the cap over the first excluded frame instead of the last kept
  // one, which reads as an off-by-one frame at any real zoom.
  it("hangs the out cap back off its boundary by its own width", () => {
    act(() => useRangeStore.setState({ inUs: null, outUs: 2_000_000 }));
    const { container } = renderRuler();
    expect(cap(container, "out")!.style.left).toBe("3998px");
  });

  it("updates in place when the marks move", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    const { container } = renderRuler();
    act(() => useRangeStore.setState({ inUs: 1_500_000, outUs: null }));
    expect(cap(container, "in")!.style.left).toBe("3000px");
  });

  // The caps are the permanent half of the design, so they must never be able
  // to swallow a scrub that starts on the ruler.
  it("stays out of the ruler's own pointer handling", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: 2_000_000 }));
    const { container } = renderRuler();
    for (const side of ["in", "out"] as const) {
      expect(cap(container, side)!.className).toContain("pointer-events-none");
    }
  });
});

/// 4 s row at 2000 px/s at 30 fps — the same row the marker lane's own suite
/// uses, so "the ruler paints none of these" is a statement about the ruler and
/// not about a zoom at which nothing would paint anyway.
const renderRuler = ({
  onScrub = () => {},
}: { onScrub?: (clientX: number) => void } = {}) =>
  render(
    <TimelineRuler
      compositionId={null}
      pxPerSec={2000}
      totalSec={4}
      widthPx={8000}
      viewportWidthPx={8000}
      fpsNum={30}
      fpsDen={1}
      onScrub={onScrub}
    />,
  );

const point = (over: Partial<MarkerSummary> = {}): MarkerSummary => ({
  id: "point-1",
  t_us: 1_000_000,
  end_t_us: null,
  label: "",
  note: "",
  color_hint: "#ff8800",
  anchor_layer: null,
  anchor_src_us: null,
  hibernating: false,
  ...over,
});

/// Only the root's `markers` carry content; the ruler reads the open
/// composition, so the seed goes through `apply` (which also opens it).
const seed = (markers: MarkerSummary[]) =>
  useProjectStore.getState().apply(summaryFixture({ root: { markers } }));

// The strip gave markers up entirely, and that is what keeps a left-press here
// meaning exactly one thing. Two hit regions for one object is the alternative,
// and it is the scrub conflict the marker lane exists to avoid.
describe("markers are not the ruler's", () => {
  it("paints no glyph and no marker layer, whatever the project carries", () => {
    seed([
      point(),
      point({ id: "region-1", t_us: 2_000_000, end_t_us: 3_000_000 }),
    ]);
    const { container } = renderRuler();
    expect(
      container.querySelectorAll('[data-testid="timeline-marker"]'),
    ).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="timeline-marker-layer"]'),
    ).toBeNull();
  });

  // A mark at 1 s is at x = 2000 on this row. A press there and a press clear of
  // it are the same press, because there is nothing at either one.
  it("scrubs across a marker's x exactly as it does anywhere else", () => {
    const scrubs: number[] = [];
    seed([point({ t_us: 1_000_000 })]);
    const { container } = renderRuler({ onScrub: (x) => scrubs.push(x) });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 2000 });
    fireEvent.pointerDown(ruler, { button: 0, clientX: 2400 });
    expect(scrubs).toEqual([2000, 2400]);
  });

  // The node-count gate reads `parseFloat(style.left)` off every direct child of
  // the strip and sorts it; a marker layer among them would feed NaN into that
  // sort. Nothing the project carries may enter the strip's child budget.
  it("keeps ticks the only thing in the strip's child budget", () => {
    const { container } = renderRuler();
    const bare = ticks(container).length;
    act(() =>
      seed(
        Array.from({ length: 30 }, (_, i) =>
          point({ id: `m${i}`, t_us: 100_000 * (i + 1) }),
        ),
      ),
    );
    expect(ticks(container).length).toBe(bare);
    for (const child of ticks(container)) {
      expect(Number.isNaN(Number.parseFloat(child.style.left))).toBe(false);
    }
  });
});

// The strip's OWN menu: the in/out and marker COMMANDS, which lived only on the
// keyboard, the strip and the palette. One menu on one strip, because the strip
// holds no object a second menu could be about.
describe("ruler context menu", () => {
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    // Every row resolves through the registry, so the menu is empty without a
    // provider — the same "omit, never render dead" policy the strip applies.
    unregister = registerCommandProvider(() => [
      { id: "markIn", actionId: "markIn", labelKey: "actions.mark_in", run: () => {} },
      { id: "markOut", actionId: "markOut", labelKey: "actions.mark_out", run: () => {} },
      {
        id: "clearRange",
        actionId: "clearRange",
        labelKey: "actions.clear_range",
        // Mirrors `appCommands.ts`: the point of the disabled case below is
        // that the live store read reaches the rendered row.
        enabled: () => hasMarkedRange(),
        run: () => {},
      },
      {
        id: "addMarkerAtPlayhead",
        actionId: "addMarkerAtPlayhead",
        labelKey: "actions.add_marker_at_playhead",
        run: () => {},
      },
      {
        id: "toggleMarkersVisible",
        labelKey: "actions.toggle_markers_visible",
        checked: () => true,
        run: () => {},
      },
    ]);
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  const openStripMenu = async (container: HTMLElement) => {
    fireEvent.contextMenu(
      container.querySelector('[data-testid="timeline-ruler"]')!,
      { clientX: 300, clientY: 12 },
    );
    return await waitFor(() => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(".app-menu-item"),
      );
      expect(items.length).toBeGreaterThan(0);
      return items;
    });
  };

  it("offers the in/out and marker commands, adding no strip children", async () => {
    const { container } = renderRuler();
    const childrenBefore = ticks(container).length;
    const items = await openStripMenu(container);
    expect(
      items.map((i) => i.querySelector(".app-menu-item-label")?.textContent),
    ).toEqual([
      "Mark in point",
      "Mark out point",
      "Clear in/out points",
      "Add marker at playhead",
      "Toggle timeline markers",
    ]);
    // The popup portals to the body, so the strip's child budget — what the
    // node-count gate and the tick enumeration measure — is untouched.
    expect(ticks(container)).toHaveLength(childrenBefore);
  });

  // The whole reason these rows come from the registry rather than being
  // hand-written: each carries the key that does the same thing, so a menu
  // the user discovered teaches the keystroke they will use next time. The
  // marker toggle has no binding by design, and correspondingly no cell.
  it("prints each row's accelerator beside it", async () => {
    const { container } = renderRuler();
    const items = await openStripMenu(container);
    const accelerator = (i: HTMLElement) =>
      i.querySelector(".app-menu-item-accelerator")?.textContent ?? null;
    expect(items.map(accelerator)).toEqual(["I", "O", "Alt+X", "M", null]);
  });

  // Clear spends most of its life unavailable, and the row has to say so
  // rather than sit there looking live. The gate is the command's own live
  // store read, reaching the rendered row.
  it("disables Clear until a range is marked", async () => {
    const { container } = renderRuler();
    const items = await openStripMenu(container);
    expect(items[2]!.getAttribute("aria-disabled")).toBe("true");
  });

  // One menu, no arbitration: a press that lands where a marker's x is still
  // opens this one, because the glyph that used to stop it is not here.
  it("opens on a press at a marker's own x", async () => {
    seed([point()]);
    const { container } = renderRuler();
    const items = await openStripMenu(container);
    expect(items).toHaveLength(5);
  });
});


describe("scroll subscription", () => {
  /// The virtualization criterion: the visible interval reaches the ruler
  /// without `scrollLeft` becoming React state above a leaf. Proven with a
  /// counter, not by inspection — a parent that re-rendered on scroll would be
  /// the whole timeline tree in production.
  function renderWithParentCounter() {
    const counter = { renders: 0 };
    function Parent() {
      counter.renders++;
      return (
        <TimelineRuler
          compositionId={null}
          pxPerSec={2000}
          totalSec={3600}
          widthPx={7_200_000}
          viewportWidthPx={1200}
          fpsNum={60}
          fpsDen={1}
          onScrub={() => {}}
        />
      );
    }
    return { counter, ...render(<Parent />) };
  }

  it("moves the painted window without re-rendering the parent", () => {
    const { counter, container } = renderWithParentCounter();
    const before = counter.renders;
    const firstTickX = () => ticks(container)[0]!.style.left;
    const headX = firstTickX();

    act(() => setTimelineScrollLeftPx(null, 40_000));
    expect(firstTickX()).not.toBe(headX);
    expect(counter.renders).toBe(before);

    // Every scroll event of a wheel gesture, not just the last one.
    for (let px = 40_000; px < 60_000; px += 250) {
      act(() => setTimelineScrollLeftPx(null, px));
    }
    expect(counter.renders).toBe(before);
  });

  it("does not recompute inside a scroll quantum", () => {
    const { container } = renderWithParentCounter();
    // Start at a block boundary, then move within it.
    act(() => setTimelineScrollLeftPx(null, 40_000));
    const windowStart = ticks(container)[0]!.style.left;

    act(() => setTimelineScrollLeftPx(null, 40_000 + RULER_SCROLL_QUANTUM_PX - 1));
    expect(ticks(container)[0]!.style.left).toBe(windowStart);

    act(() => setTimelineScrollLeftPx(null, 40_000 + RULER_SCROLL_QUANTUM_PX));
    expect(ticks(container)[0]!.style.left).not.toBe(windowStart);
  });

  it("seeds its window from the store on mount", () => {
    // A remount (dock panel switch) with the store already scrolled must not
    // paint the row head.
    setTimelineScrollLeftPx(null, 40_000);
    expect(timelineScrollLeftPx(null)).toBe(40_000);
    const { container } = renderWithParentCounter();
    const left = Number.parseFloat(ticks(container)[0]!.style.left);
    expect(left).toBeGreaterThan(39_000);
    expect(left).toBeLessThanOrEqual(40_000);
  });
});
