// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimelineBladeMark } from "./TimelineBladeMark";

/// jsdom has no layout, so each element's box is read from this table: the
/// viewport and the mark by test id, a clip block by its layer id. A test
/// scrolls by rewriting the clip rows and firing the viewport's scroll event.
const boxes = new Map<string, { top: number; bottom: number }>();
const keyOf = (el: Element): string | undefined =>
  (el as HTMLElement).dataset.layerId ?? (el as HTMLElement).dataset.testid;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = boxes.get(keyOf(this) ?? "") ?? { top: 0, bottom: 0 };
    return {
      top: box.top, bottom: box.bottom, height: box.bottom - box.top,
      left: 0, right: 100, width: 100, x: 0, y: box.top, toJSON: () => ({}),
    } as DOMRect;
  });
  // The mark hangs from the ruler's bottom edge; the viewport below it shows
  // the rows from y=100 to y=300.
  boxes.set("timeline-blade-mark", { top: 80, bottom: 400 });
  boxes.set("viewport", { top: 100, bottom: 300 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  boxes.clear();
});

function renderMark(cutLayerIds: readonly string[]) {
  const viewportRef = createRef<HTMLDivElement>();
  const view = render(
    <>
      <div ref={viewportRef} data-testid="viewport">
        {["a", "b", "c"].map((id) => (
          <div key={id} className="timeline-layer" data-layer-id={id} />
        ))}
      </div>
      <TimelineBladeMark
        atUs={1_000_000} snapped={false} cutLayerIds={cutLayerIds} label="00:00:01:00"
        pxPerSec={100} widthPx={1000} trackViewportRef={viewportRef}
      />
    </>,
  );
  return { ...view, viewport: screen.getByTestId("viewport") };
}

/// Each solid span as [top, height] relative to the mark, keyed by layer id.
const spans = () => Object.fromEntries(
  screen.queryAllByTestId("timeline-blade-cut").map((el) => [
    el.dataset.layerId, [parseFloat(el.style.top), parseFloat(el.style.height)],
  ]),
);

describe("TimelineBladeMark", () => {
  it("draws a solid span over exactly the clips the cut names, in the mark's own coordinates", () => {
    boxes.set("a", { top: 120, bottom: 160 });
    boxes.set("b", { top: 180, bottom: 220 });
    boxes.set("c", { top: 240, bottom: 280 });
    renderMark(["a", "c"]);
    // Measured from the mark's top, so a span sits on its clip whatever the
    // distance between the ruler and the rows.
    expect(spans()).toEqual({ a: [120 - 80, 40], c: [240 - 80, 40] });
  });

  it("clips a span to the viewport, and drops a clip scrolled out of it", () => {
    boxes.set("a", { top: 80, bottom: 140 });
    boxes.set("b", { top: 180, bottom: 220 });
    renderMark(["a", "b"]);
    // Clip a starts above the viewport: only its visible part is solid, so the
    // span never paints over the ruler.
    expect(spans()).toEqual({ a: [100 - 80, 40], b: [180 - 80, 40] });
  });

  it("re-measures on the viewport's scroll", () => {
    boxes.set("a", { top: 120, bottom: 160 });
    boxes.set("b", { top: 180, bottom: 220 });
    const { viewport } = renderMark(["a", "b"]);
    expect(Object.keys(spans())).toEqual(["a", "b"]);

    // Scrolled up by 100: a leaves the viewport, b moves with its row.
    boxes.set("a", { top: 20, bottom: 60 });
    boxes.set("b", { top: 80, bottom: 120 });
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(spans()).toEqual({ b: [100 - 80, 20] });
  });

  it("stops following the viewport once unmounted", () => {
    boxes.set("a", { top: 120, bottom: 160 });
    const { viewport, unmount } = renderMark(["a"]);
    const measured = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length;
    unmount();
    viewport.dispatchEvent(new Event("scroll"));
    expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length).toBe(measured);
  });
});
