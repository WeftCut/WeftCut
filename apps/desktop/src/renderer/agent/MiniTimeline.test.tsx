// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { MiniTimeline } from "./MiniTimeline";
import { rangeMarks, type ReviewRangeMark } from "./reviewHighlight";
import { rangeKey } from "./reviewFocus";
import type { ChangeClass, ChangedRange, EntityKey } from "../../shared/review";
import type { TackView } from "../../shared/agent-activity";

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Changed ranges on the root, as the bands receive them. */
const marks = (...rs: Array<[ChangeClass, number, number, EntityKey[], Partial<ChangedRange>?]>): ReviewRangeMark[] =>
  rangeMarks(rs.map(([cls, s, e, ids, extra]) => ({
    composition_id: "root", class: cls, t_start_us: s, t_end_us: e, before_start_us: s, before_end_us: e,
    source: "review", change_ids: ids, ...extra,
  })));

it.each(["release", "cancel", "escape", "blur", "unmount"])(
  "stops mini-timeline seeking on %s so later edits cannot inherit its scrub",
  (ending) => {
    const onSeek = vi.fn();
    const { container, unmount } = render(<MiniTimeline
      durationUs={5_000_000} markers={[]} onSeek={onSeek} fpsNum={30} fpsDen={1}
    />);
    const strip = container.querySelector<HTMLElement>(".mini-timeline-strip-real")!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 36));
    fireEvent.pointerDown(strip, { button: 0, pointerId: 3, clientX: 100 });
    expect(onSeek).toHaveBeenLastCalledWith(1_000_000);
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 200 });
    expect(onSeek).toHaveBeenLastCalledWith(2_000_000);
    if (ending === "release") fireEvent.pointerUp(window, { pointerId: 3 });
    else if (ending === "cancel") fireEvent.pointerCancel(window, { pointerId: 3 });
    else if (ending === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (ending === "blur") fireEvent.blur(window);
    else unmount();
    onSeek.mockClear();
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 300 });
    expect(onSeek).not.toHaveBeenCalled();
  },
);

it("paints open tacks as one band of their own, merged, apart from the marker pips", () => {
  const { container } = render(<MiniTimeline
    durationUs={10_000_000}
    markers={[{ id: "m", t_us: 1_000_000, end_t_us: null, label: "Mark", note: "", color_hint: "#ff0000", anchor_layer: null, hibernating: false } as never]}
    tacks={[
      { id: "region", t_us: 2_000_000, end_t_us: 4_000_000, label: "Pause" },
      { id: "overlap", t_us: 3_000_000, end_t_us: 5_000_000, label: "Breath" },
      { id: "inside", t_us: 4_000_000, end_t_us: null, label: "Inside" },
      { id: "point", t_us: 7_000_000, end_t_us: null, label: "Check" },
    ] as never}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  // Two overlapping ranges are one span, not two strips stacking their alpha;
  // a point inside it adds nothing, a point outside it is a tick.
  const bands = container.querySelectorAll<HTMLElement>("[data-testid='mini-tack']");
  expect([...bands].map((b) => [b.className, b.style.left, b.style.width])).toEqual([
    ["mini-tack mini-tack-region", "20%", "30%"],
    ["mini-tack mini-tack-point", "70%", ""],
  ]);
  expect(container.querySelector("[data-testid='mini-tack-selected']")).toBeNull();
  // The marker keeps its own pip; a tack is never drawn as one.
  expect(container.querySelectorAll(".mini-marker-pip")).toHaveLength(1);
  expect(container.querySelectorAll(".mini-tack.mini-marker-pip")).toHaveLength(0);
});

it("draws the focused tack over the union, and nothing for a focus it does not paint", () => {
  const tacks = [
    { id: "region", t_us: 2_000_000, end_t_us: 4_000_000, label: "Pause" },
    { id: "overlap", t_us: 3_000_000, end_t_us: 5_000_000, label: "Breath" },
  ] as never;
  const { container, rerender } = render(<MiniTimeline
    durationUs={10_000_000} markers={[]} tacks={tacks} focus={{ kind: "tack", id: "overlap" }}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  const selected = () => container.querySelector<HTMLElement>("[data-testid='mini-tack-selected']");
  expect([selected()!.className, selected()!.style.left, selected()!.style.width])
    .toEqual(["mini-tack mini-tack-selected mini-tack-region", "30%", "20%"]);
  // Painted after the band, so it is on top.
  const band = container.querySelector("[data-testid='mini-tack']")!;
  expect(band.compareDocumentPosition(selected()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender(<MiniTimeline
    durationUs={10_000_000} markers={[]} tacks={tacks} focus={{ kind: "tack", id: "resolved-elsewhere" }}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  expect(selected()).toBeNull();
});

it("paints changed ranges as a second band, by class, a cut point as a notch, apart from the tack band", () => {
  const { container } = render(<MiniTimeline
    durationUs={10_000_000}
    markers={[]}
    tacks={[{ id: "t", t_us: 2_000_000, end_t_us: 4_000_000, label: "Pause" }] as never}
    changes={marks(
      ["added", 0, 1_000_000, ["Layer:a"]],
      ["modified", 2_000_000, 3_000_000, ["Layer:m"]],
      ["removed", 5_000_000, 5_000_000, ["Layer:r"], { before_end_us: 6_000_000 }],
      ["modified", 6_000_000, 9_000_000, ["Layer:u"], { source: "user" }],
    )}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  const band = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
  expect(band.map((b) => [b.dataset.changeClass, b.dataset.cut ?? null, b.dataset.user ?? null, b.style.left, b.style.width])).toEqual([
    ["added", null, null, "0%", "10%"], ["modified", null, null, "20%", "10%"],
    ["removed", "true", null, "50%", ""], ["modified", null, "true", "60%", "30%"],
  ]);
  expect(band.every((b) => b.classList.contains("mini-change") && !b.classList.contains("mini-tack"))).toBe(true);
  expect(container.querySelectorAll("[data-testid='mini-tack']")).toHaveLength(1);
});

it("paints touching ranges of one look as one block, every range still named", () => {
  const changeLabel = (m: ReviewRangeMark) => `${m.cls} ${m.tStartUs / 1_000_000}`;
  const { container, getByTestId } = render(<MiniTimeline durationUs={10_000_000} markers={[]}
    changes={marks(["modified", 1_000_000, 2_000_000, ["Layer:a"]], ["modified", 2_000_000, 3_000_000, ["Layer:b"]], ["added", 3_000_000, 4_000_000, ["Layer:c"]])}
    changeLabel={changeLabel} onFocus={() => {}} onSeek={() => {}} fpsNum={30} fpsDen={1} />);
  const band = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
  expect(band.map((b) => [b.dataset.changeClass, b.dataset.count])).toEqual([["modified", "2"], ["added", "1"]]);
  const hit = getByTestId("mini-change-band");
  vi.spyOn(hit, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 36));
  fireEvent.pointerMove(hit, { clientX: 75 }); // 1.5 s
  expect(hit.title).toBe("modified 1\nmodified 2");
});

it("paints a range only out of sync apart from solid ones, never merged with them", () => {
  const sync = { sync_offset_us: 2_000_000 };
  const { container } = render(<MiniTimeline durationUs={10_000_000} markers={[]}
    changes={marks(
      ["modified", 1_000_000, 2_000_000, ["Layer:a"], { ...sync, only: "sync" }],
      ["modified", 2_000_000, 3_000_000, ["Layer:b"], { ...sync }],
      ["modified", 3_000_000, 4_000_000, ["Layer:c"], { ...sync, only: "sync", sync_bound: true }],
    )}
    onSeek={() => {}} fpsNum={30} fpsDen={1} />);
  const band = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
  expect(band.map((b) => [b.dataset.sync, b.dataset.count])).toEqual([["loose", "1"], ["mixed", "1"], ["bound", "1"]]);
});

describe("review focus on the strip", () => {
  const tacks = [
    { id: "long", t_us: 1_000_000, end_t_us: 6_000_000, label: "Long", kind: "note" },
    { id: "short", t_us: 2_000_000, end_t_us: 3_000_000, label: "Short", kind: "issue" },
    { id: "point", t_us: 8_000_000, end_t_us: null, label: "", kind: "question" },
  ] as TackView[];
  const changes = marks(
    ["added", 0, 1_000_000, ["Layer:a"]],
    ["modified", 5_000_000, 7_000_000, ["Layer:m", "Layer:n"]],
  );
  function strip(props: Partial<React.ComponentProps<typeof MiniTimeline>> = {}) {
    const onSeek = vi.fn();
    const onFocus = vi.fn();
    const r = render(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={changes}
      onSeek={onSeek} onFocus={onFocus} fpsNum={30} fpsDen={1} {...props} />);
    for (const el of r.container.querySelectorAll<HTMLElement>(".mini-timeline-strip-real, .mini-band-hit")) {
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 36));
    }
    const band = (id: string) => r.getByTestId(id);
    return { ...r, onSeek, onFocus, band };
  }

  it("a press on the tack band focuses the shortest tack under it, and does not seek", () => {
    const { band, onSeek, onFocus } = strip();
    fireEvent.pointerDown(band("mini-tack-band"), { button: 0, pointerId: 1, clientX: 125 }); // 2.5 s
    expect(onFocus).toHaveBeenCalledWith({ kind: "tack", id: "short" });
    fireEvent.pointerDown(band("mini-tack-band"), { button: 0, pointerId: 1, clientX: 200 }); // 4 s
    expect(onFocus).toHaveBeenLastCalledWith({ kind: "tack", id: "long" });
    // A point tack, a couple of pixels off.
    fireEvent.pointerDown(band("mini-tack-band"), { button: 0, pointerId: 1, clientX: 402 });
    expect(onFocus).toHaveBeenLastCalledWith({ kind: "tack", id: "point" });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("a cut point says how much was removed under the pointer, and a press focuses it", () => {
    const withCut = marks(
      ["added", 0, 1_000_000, ["Layer:a"]],
      ["removed", 3_000_000, 3_000_000, ["Layer:r"], { before_start_us: 3_000_000, before_end_us: 5_000_000 }],
      ["modified", 5_000_000, 7_000_000, ["Layer:m", "Layer:n"]],
    );
    const changeLabel = (m: ReviewRangeMark) => `${m.cls} ${(m.range.before_end_us - m.range.before_start_us) / 1_000_000}`;
    const { band, onFocus, onSeek } = strip({ changes: withCut, changeLabel });
    fireEvent.pointerMove(band("mini-change-band"), { clientX: 151 }); // a pixel off 3 s
    expect(band("mini-change-band").title).toBe("removed 2");
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 151 });
    expect(onFocus).toHaveBeenCalledWith({ kind: "range", id: rangeKey(withCut[1]!.range) });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("a press on a changed range focuses the range itself, not one of its changes", () => {
    const { band, onSeek, onFocus } = strip();
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 300 }); // 6 s
    expect(onFocus).toHaveBeenCalledWith({ kind: "range", id: rangeKey(changes[1]!.range) });
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 425 }); // 8.5 s: bare band
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenLastCalledWith(8_500_000);
  });

  it("a press on ranges painted as one block focuses the one under it", () => {
    const touching = marks(["modified", 1_000_000, 2_000_000, ["Layer:a"]], ["modified", 2_000_000, 3_000_000, ["Layer:b"]]);
    const { band, onFocus } = strip({ changes: touching });
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 125 }); // 2.5 s
    expect(onFocus).toHaveBeenLastCalledWith({ kind: "range", id: rangeKey(touching[1]!.range) });
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 75 }); // 1.5 s
    expect(onFocus).toHaveBeenLastCalledWith({ kind: "range", id: rangeKey(touching[0]!.range) });
  });

  it("a focused range fills its own mark and washes its span", () => {
    const { container } = strip({ focus: { kind: "range", id: rangeKey(changes[1]!.range) } });
    const painted = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
    expect(painted.map((m) => m.classList.contains("mini-change-selected"))).toEqual([false, true]);
    const washes = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-focus-wash']")].map((w) => [w.style.left, w.style.width]);
    expect(washes).toEqual([["50%", "20%"]]);
  });

  it("a double press on a band item jumps to its start, a press beyond the film's end to the end", () => {
    const { band, onSeek } = strip();
    fireEvent.doubleClick(band("mini-tack-band"), { clientX: 125 });
    expect(onSeek).toHaveBeenLastCalledWith(tacks.find((x) => x.id === "short")!.t_us);
    fireEvent.doubleClick(band("mini-change-band"), { clientX: 300 });
    expect(onSeek).toHaveBeenLastCalledWith(5_000_000);
    onSeek.mockClear();
    fireEvent.doubleClick(band("mini-change-band"), { clientX: 425 }); // bare band names nothing
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("bare band falls through to the seek, and hovering a band names what is under it", () => {
    const { band, onSeek, onFocus } = strip();
    fireEvent.pointerDown(band("mini-tack-band"), { button: 0, pointerId: 1, clientX: 350 }); // 7 s
    expect(onFocus).not.toHaveBeenCalled();
    expect(onSeek).toHaveBeenLastCalledWith(7_000_000);
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerMove(band("mini-tack-band"), { clientX: 125 });
    expect(band("mini-tack-band").title).toBe("Short");
    fireEvent.pointerMove(band("mini-tack-band"), { clientX: 401 });
    expect(band("mini-tack-band").title).toBe("Question");
    fireEvent.pointerMove(band("mini-change-band"), { clientX: 25 });
    expect(band("mini-change-band").title).toBe("Added");
  });

  it("rings the hovered tack and fills the ranges the focused change plays in", () => {
    const { container } = strip({ focus: { kind: "change", id: "Layer:n" }, hover: { kind: "tack", id: "short" } });
    const hover = container.querySelector<HTMLElement>("[data-testid='mini-tack-hover']")!;
    expect([hover.style.left, hover.style.width]).toEqual(["20%", "10%"]);
    expect(container.querySelector("[data-testid='mini-tack-selected']")).toBeNull();
    // A range is selected while the focused change plays in it.
    const painted = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
    expect(painted.map((m) => [m.dataset.changeClass, m.classList.contains("mini-change-selected")])).toEqual([
      ["added", false], ["modified", true],
    ]);
  });

  it("washes the focused change's ranges the strip's full height and steps its band back, as the editor timeline does", () => {
    const withCut = marks(["added", 0, 1_000_000, ["Layer:a"]], ["removed", 2_000_000, 2_000_000, ["Layer:r"]], ["modified", 5_000_000, 7_000_000, ["Layer:m"]]);
    const { container, rerender } = render(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={withCut}
      focus={{ kind: "change", id: "Layer:m" }} onSeek={() => {}} fpsNum={30} fpsDen={1} />);
    const strip = () => container.querySelector<HTMLElement>(".mini-timeline-strip-real")!;
    const washes = () => [...container.querySelectorAll<HTMLElement>("[data-testid='mini-focus-wash']")]
      .map((w) => [w.dataset.kind, w.dataset.point ?? null, w.style.left, w.style.width]);
    expect(washes()).toEqual([["change", null, "50%", "20%"]]);
    expect(strip().classList.contains("mini-focus-change")).toBe(true);
    // Under every mark: the wash comes first in the strip.
    expect(strip().firstElementChild?.getAttribute("data-testid")).toBe("mini-focus-wash");
    rerender(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={withCut}
      focus={{ kind: "change", id: "Layer:r" }} onSeek={() => {}} fpsNum={30} fpsDen={1} />);
    expect(washes()).toEqual([["change", "true", "20%", ""]]);
    rerender(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={changes}
      focus={{ kind: "tack", id: "short" }} onSeek={() => {}} fpsNum={30} fpsDen={1} />);
    expect(washes()).toEqual([["tack", null, "20%", "10%"]]);
    expect(strip().classList.contains("mini-focus-tack")).toBe(true);
    rerender(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={changes}
      focus={null} onSeek={() => {}} fpsNum={30} fpsDen={1} />);
    expect(washes()).toEqual([]);
    expect(strip().className).toBe("mini-timeline-strip-real");
  });

  it("without a focus handler the bands are paint only", () => {
    const { container } = render(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={changes}
      onSeek={() => {}} fpsNum={30} fpsDen={1} />);
    expect(container.querySelector(".mini-band-hit")).toBeNull();
  });
});
