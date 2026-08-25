// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarqueeOverlay } from "./MarqueeOverlay";
import { clearMarquee, setMarqueeBox, type MarqueeBox } from "./marqueeStore";

/// `Piece` writes no `left`/`top`/`width`/`height`, so its transform IS its
/// geometry and reading it back is the only way to see where the box was drawn.
/// `x1`/`y1` are exclusive, matching `marquee.ts`'s half-open intervals.
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  x1: number;
  y1: number;
}

const TRANSFORM =
  /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+), (-?[\d.]+)\)$/;

/// Fill first, then the four hairlines — the component's own source order, which
/// is what makes `[fill, ...edges]` legible at the call sites below.
function draw(box: MarqueeBox): { fill: Rect; edges: Rect[] } {
  setMarqueeBox(box, "clip");
  const { container } = render(<MarqueeOverlay />);
  const root = container.querySelector('[data-testid="timeline-marquee"]');
  const [fill, ...edges] = [...(root?.children ?? [])].map((el): Rect => {
    const t = (el as HTMLElement).style.transform;
    const m = TRANSFORM.exec(t);
    if (m === null) throw new Error(`unparsable transform: ${t}`);
    const x = Number(m[1]);
    const y = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    return { x, y, w, h, x1: x + w, y1: y + h };
  });
  if (fill === undefined) throw new Error("overlay drew nothing");
  return { fill, edges };
}

describe("MarqueeOverlay", () => {
  afterEach(() => {
    cleanup();
    clearMarquee();
  });

  it("insets every hairline into the range the hit-test takes", () => {
    // The regression this file exists for. A ring drawn at `x + w` / `y + h`
    // paints the first column and row the box does NOT select, so the fill
    // visibly comes loose from its right and bottom sides — and the assertion
    // that catches it is containment, not any one coordinate.
    const { fill, edges } = draw({ x0: 100, y0: 40, x1: 300, y1: 120 });
    expect(fill).toMatchObject({ x: 100, y: 40, w: 200, h: 80 });
    for (const e of edges) {
      expect(e.x).toBeGreaterThanOrEqual(fill.x);
      expect(e.y).toBeGreaterThanOrEqual(fill.y);
      expect(e.x1).toBeLessThanOrEqual(fill.x1);
      expect(e.y1).toBeLessThanOrEqual(fill.y1);
    }
  });

  it("welds one hairline to each of the four sides", () => {
    // Containment alone would also pass a ring collapsed into the middle, so
    // pin the far edges' outer bound to the fill's: flush, not merely inside.
    const { fill, edges } = draw({ x0: 100, y0: 40, x1: 300, y1: 120 });
    expect(edges.map((e) => `${e.x},${e.y} ${e.w}x${e.h}`)).toEqual([
      "100,40 200x1",
      "100,119 200x1",
      "100,40 1x80",
      "299,40 1x80",
    ]);
    expect(edges.some((e) => e.x1 === fill.x1)).toBe(true);
    expect(edges.some((e) => e.y1 === fill.y1)).toBe(true);
  });

  it("draws a backwards drag as the same rectangle", () => {
    const forward = draw({ x0: 100, y0: 40, x1: 300, y1: 120 });
    cleanup();
    const backward = draw({ x0: 300, y0: 120, x1: 100, y1: 40 });
    expect(backward).toEqual(forward);
  });

  it("keeps the ring inside a box that armed on one axis only", () => {
    // The arm gate is total displacement, so a straight-down drag reaches it
    // with zero width. Without the clamp the vertical hairlines land at x - 1,
    // outside a box that has no interior to hide them in.
    const { fill, edges } = draw({ x0: 100, y0: 40, x1: 100, y1: 120 });
    expect(fill.w).toBe(0);
    for (const e of edges) expect(e.x).toBe(100);
  });
});
