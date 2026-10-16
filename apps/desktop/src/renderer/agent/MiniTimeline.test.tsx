// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { MiniTimeline } from "./MiniTimeline";
import type { ReviewRangeMark } from "./reviewHighlight";

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

it("paints review change ranges as a second band, by class, apart from the tack band", () => {
  const { container } = render(<MiniTimeline
    durationUs={10_000_000}
    markers={[]}
    tacks={[{ id: "t", t_us: 2_000_000, end_t_us: 4_000_000, label: "Pause" }] as never}
    changes={[
      { changeId: "Layer:a", cls: "added", compositionId: "root", tStartUs: 0, tEndUs: 1_000_000 },
      { changeId: "Layer:m", cls: "modified", compositionId: "root", tStartUs: 2_000_000, tEndUs: 3_000_000 },
      { changeId: "Layer:r", cls: "removed", compositionId: "root", tStartUs: 5_000_000, tEndUs: 6_000_000 },
      { changeId: "Layer:moved", cls: "modified", compositionId: "root", tStartUs: 6_000_000, tEndUs: 9_000_000 },
    ]}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  const band = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
  expect(band.map((b) => [b.dataset.changeClass, b.style.left, b.style.width])).toEqual([
    ["added", "0%", "10%"], ["modified", "20%", "10%"], ["removed", "50%", "10%"], ["modified", "60%", "30%"],
  ]);
  expect(band.every((b) => b.classList.contains("mini-change") && !b.classList.contains("mini-tack"))).toBe(true);
  expect(container.querySelectorAll("[data-testid='mini-tack']")).toHaveLength(1);
});

describe("review focus on the strip", () => {
  const tacks = [
    { id: "long", t_us: 1_000_000, end_t_us: 6_000_000, label: "Long", kind: "note" },
    { id: "short", t_us: 2_000_000, end_t_us: 3_000_000, label: "Short", kind: "issue" },
    { id: "point", t_us: 8_000_000, end_t_us: null, label: "", kind: "question" },
  ] as never;
  const changes = [
    { changeId: "Layer:a", cls: "added" as const, compositionId: "root", tStartUs: 0, tEndUs: 1_000_000 },
    { changeId: "Layer:m", cls: "modified" as const, compositionId: "root", tStartUs: 5_000_000, tEndUs: 7_000_000 },
    { changeId: "Group:g", cls: "modified" as const, compositionId: "root", tStartUs: 8_000_000, tEndUs: 9_000_000, group: true as const },
  ];
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

  it("a removal's baseline footprint is dashed apart, says so under the pointer, and a press focuses it", () => {
    const removed = { changeId: "Layer:r", cls: "removed" as const, compositionId: "root", tStartUs: 3_000_000, tEndUs: 4_000_000, historical: true as const };
    const changeLabel = (m: ReviewRangeMark) => `${m.changeId}${m.historical ? " · Baseline position" : ""}`;
    const { container, band, onFocus, onSeek } = strip({ changes: [...changes, removed], changeLabel });
    const mark = container.querySelector<HTMLElement>("[data-change-id='Layer:r']")!;
    expect([mark.dataset.historical, mark.classList.contains("mini-change-historical")]).toEqual(["true", true]);
    expect(container.querySelector<HTMLElement>("[data-change-id='Layer:m']")!.classList.contains("mini-change-historical")).toBe(false);
    fireEvent.pointerMove(band("mini-change-band"), { clientX: 175 }); // 3.5 s
    expect(band("mini-change-band").title).toBe("Layer:r · Baseline position");
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 175 });
    expect(onFocus).toHaveBeenCalledWith({ kind: "change", id: "Layer:r" });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("a removal's footprint under a current change has its own row: a press there names it, above names the current one", () => {
    // A ripple closed up: Layer:m now sits exactly where Layer:r was.
    const under = { changeId: "Layer:r", cls: "removed" as const, compositionId: "root", tStartUs: 5_000_000, tEndUs: 7_000_000, historical: true as const };
    const { band, onFocus } = strip({ changes: [...changes, under] });
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 300, clientY: 1 });
    expect(onFocus).toHaveBeenLastCalledWith({ kind: "change", id: "Layer:m" });
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 300, clientY: 8 });
    expect(onFocus).toHaveBeenLastCalledWith({ kind: "change", id: "Layer:r" });
  });

  it("runs past the film's end to a removal's footprint there, shaded, and never seeks beyond the end", () => {
    const past = { changeId: "Marker:x", cls: "removed" as const, compositionId: "root", tStartUs: 12_000_000, tEndUs: 12_000_000, historical: true as const };
    const { container, onSeek, onFocus, band } = strip({ changes: [past] });
    // Scale 0–12 s on a 10 s film, and a little room after 12 s.
    const extent = 12_240_000;
    expect(container.querySelector<HTMLElement>("[data-testid='mini-beyond-end']")!.style.left).toBe(`${(10_000_000 / extent) * 100}%`);
    expect(container.querySelector<HTMLElement>("[data-change-id='Marker:x']")!.style.left).toBe(`${(12_000_000 / extent) * 100}%`);
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 490, clientY: 8 });
    expect(onFocus).toHaveBeenCalledWith({ kind: "change", id: "Marker:x" });
    const real = container.querySelector<HTMLElement>(".mini-timeline-strip-real")!;
    fireEvent.pointerDown(real, { button: 0, pointerId: 2, clientX: 250 });
    expect(onSeek).toHaveBeenLastCalledWith(6_120_000);
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 480 });
    expect(onSeek).toHaveBeenLastCalledWith(10_000_000);
    fireEvent.pointerUp(window, { pointerId: 2 });
    // Without one, no shade and the film's own scale.
    cleanup();
    const plain = strip();
    expect(plain.container.querySelector("[data-testid='mini-beyond-end']")).toBeNull();
  });

  it("a press on the change band focuses the change under it, never a Group footprint", () => {
    const { band, onSeek, onFocus } = strip();
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 300 }); // 6 s
    expect(onFocus).toHaveBeenCalledWith({ kind: "change", id: "Layer:m" });
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerDown(band("mini-change-band"), { button: 0, pointerId: 1, clientX: 425 }); // 8.5 s: Group only
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenLastCalledWith(8_500_000);
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

  it("rings the hovered tack and fills the focused change's ranges", () => {
    const { container } = strip({ focus: { kind: "change", id: "Layer:m" }, hover: { kind: "tack", id: "short" } });
    const hover = container.querySelector<HTMLElement>("[data-testid='mini-tack-hover']")!;
    expect([hover.style.left, hover.style.width]).toEqual(["20%", "10%"]);
    expect(container.querySelector("[data-testid='mini-tack-selected']")).toBeNull();
    const marks = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
    expect(marks.map((m) => [m.dataset.changeId, m.classList.contains("mini-change-selected")])).toEqual([
      ["Layer:a", false], ["Layer:m", true], ["Group:g", false],
    ]);
  });

  it("without a focus handler the bands are paint only", () => {
    const { container } = render(<MiniTimeline durationUs={10_000_000} markers={[]} tacks={tacks} changes={changes}
      onSeek={() => {}} fpsNum={30} fpsDen={1} />);
    expect(container.querySelector(".mini-band-hit")).toBeNull();
  });
});
