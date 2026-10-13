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

it("paints open tacks as a band of their own, apart from the marker pips", () => {
  const { container } = render(<MiniTimeline
    durationUs={10_000_000}
    markers={[{ id: "m", t_us: 1_000_000, end_t_us: null, label: "Mark", note: "", color_hint: "#ff0000", anchor_layer: null, hibernating: false } as never]}
    tacks={[
      { id: "region", t_us: 2_000_000, end_t_us: 4_000_000, label: "Pause" },
      { id: "point", t_us: 5_000_000, end_t_us: null, label: "Check" },
    ] as never}
    onSeek={() => {}} fpsNum={30} fpsDen={1}
  />);
  const bands = container.querySelectorAll<HTMLElement>("[data-testid='mini-tack']");
  expect([...bands].map((b) => [b.className, b.style.left, b.style.width, b.title])).toEqual([
    ["mini-tack mini-tack-region", "20%", "20%", "Pause"],
    ["mini-tack mini-tack-point", "50%", "", "Check"],
  ]);
  // The marker keeps its own pip; a tack is never drawn as one.
  expect(container.querySelectorAll(".mini-marker-pip")).toHaveLength(1);
  expect(container.querySelectorAll(".mini-tack.mini-marker-pip")).toHaveLength(0);
});
