// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarqueeOverlay } from "./MarqueeOverlay";
import { clearMarquee, setMarqueeBox, type MarqueeBox } from "./marqueeStore";

function draw(box: MarqueeBox, kind: "clip" | "keyframe" = "clip"): HTMLElement {
  setMarqueeBox(box, kind);
  const { container } = render(<MarqueeOverlay />);
  const el = container.querySelector<HTMLElement>('[data-testid="timeline-marquee"]');
  if (el === null) throw new Error("overlay drew nothing");
  return el;
}

describe("MarqueeOverlay", () => {
  afterEach(() => {
    cleanup();
    clearMarquee();
  });

  it("draws exactly the rectangle the hit-test takes", () => {
    // The drawn box and the selected range are the same numbers or the gesture
    // lies about what it is about to take. `border` + the global `border-box`
    // then keeps the hairline inside that range, so the ring never paints the
    // row and column `marquee.ts` excludes.
    const el = draw({ x0: 100, y0: 40, x1: 300, y1: 120 });
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("40px");
    expect(el.style.width).toBe("200px");
    expect(el.style.height).toBe("80px");
    expect(el.className).toContain("border");
  });

  it("never sizes itself with a transform", () => {
    // LANDMINE guard, not style policing. `scale(w, h)` on a 1×1 px div drew
    // this box until a fractional DPR turned its `1px` into 0.994318 px: the
    // fill then fell short of its own border by 0.6% of the box's width, which
    // is invisible on a small drag and 1.7 px on a 300 px one. `left`/`top`/
    // `width`/`height` cannot accumulate that error.
    const el = draw({ x0: 0, y0: 0, x1: 900, y1: 400 });
    expect(el.style.transform).toBe("");
  });

  it("draws a backwards drag as the same rectangle", () => {
    const forward = draw({ x0: 100, y0: 40, x1: 300, y1: 120 }).style.cssText;
    cleanup();
    const backward = draw({ x0: 300, y0: 120, x1: 100, y1: 40 }).style.cssText;
    expect(backward).toBe(forward);
  });

  it("tints by kind, so the box says which population it is taking", () => {
    expect(draw({ x0: 0, y0: 0, x1: 10, y1: 10 }, "clip").className).toContain("blue");
    cleanup();
    const kf = draw({ x0: 0, y0: 0, x1: 10, y1: 10 }, "keyframe");
    expect(kf.className).toContain("yellow");
    expect(kf.dataset.kind).toBe("keyframe");
  });
});
