// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../i18n";
import { MiniTimeline } from "./MiniTimeline";

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

it("draws the selected tack over the union, and nothing for a selection it does not paint", () => {
  const tacks = [
    { id: "region", t_us: 2_000_000, end_t_us: 4_000_000, label: "Pause" },
    { id: "overlap", t_us: 3_000_000, end_t_us: 5_000_000, label: "Breath" },
  ] as never;
  const { container, rerender } = render(<MiniTimeline
    durationUs={10_000_000} markers={[]} tacks={tacks} selectedTackId="overlap"
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  const selected = () => container.querySelector<HTMLElement>("[data-testid='mini-tack-selected']");
  expect([selected()!.className, selected()!.style.left, selected()!.style.width])
    .toEqual(["mini-tack mini-tack-selected mini-tack-region", "30%", "20%"]);
  // Painted after the band, so it is on top.
  const band = container.querySelector("[data-testid='mini-tack']")!;
  expect(band.compareDocumentPosition(selected()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender(<MiniTimeline
    durationUs={10_000_000} markers={[]} tacks={tacks} selectedTackId="resolved-elsewhere"
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
      { changeId: "Shift:root:1", cls: "shifted", compositionId: "root", tStartUs: 6_000_000, tEndUs: 9_000_000 },
    ]}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  const band = [...container.querySelectorAll<HTMLElement>("[data-testid='mini-change']")];
  expect(band.map((b) => [b.dataset.changeClass, b.style.left, b.style.width])).toEqual([
    ["added", "0%", "10%"], ["modified", "20%", "10%"], ["removed", "50%", "10%"], ["shifted", "60%", "30%"],
  ]);
  expect(band.every((b) => b.classList.contains("mini-change") && !b.classList.contains("mini-tack"))).toBe(true);
  expect(container.querySelectorAll("[data-testid='mini-tack']")).toHaveLength(1);
});
