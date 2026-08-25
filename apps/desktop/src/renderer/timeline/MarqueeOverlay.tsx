// The drag rectangle. Sole subscriber of `marqueeStore.ts`, mounted as the LAST
// child of `timeline-canvas` — which is what puts it over every chip (max
// `z-[3]`) and over the out-of-range wash (`z-[4]`, an earlier sibling) while
// leaving it under the playhead (`z-[4]`, a later sibling of the canvas).

import { useMarqueeBox, useMarqueeKind } from "./marqueeStore";

/// Kind-tinted fill + hairline, so the box says which population it is taking
/// before it has taken anything. Yellow is the keyframe domain accent
/// (`--keyframe`), matching the diamonds the box is sweeping.
const TINT = {
  clip: "border-blue-300/85 bg-blue-400/15",
  keyframe: "border-yellow-300/85 bg-yellow-400/15",
} as const;

/**
 * One element, sized by `width`/`height`.
 *
 * LANDMINE: `transform: scale(w, h)` on a 1×1 px div is the tempting way to draw
 * this — compositor-only, no layout — and it is wrong by an amount that GROWS
 * with the box. `scale` multiplies the element's used size, and a CSS `1px` does
 * not survive a fractional device pixel ratio: at DPR 1.1 it computes to
 * 0.994318 px, being 1.1 device px quantized to Chrome's 1/64 px layout grid and
 * reported back in CSS px. Transform OFFSETS stay exact, so the fill of a 300 px
 * box fell 1.7 px short of the border its own translate had placed, and the gap
 * widened with every pixel of the drag. Scale nothing and the error is gone
 * rather than merely small.
 *
 * Layout-affecting writes cost nothing special here anyway: every chip in this
 * same container positions itself with `left`/`top`/`width`/`height` and moves on
 * the same pointermoves this box does.
 *
 * `border` under Tailwind's global `border-box` is what keeps the hairline INSIDE
 * the element, so the ring encloses exactly the half-open range `marquee.ts`
 * takes instead of painting the first row and column the box excludes.
 */
export function MarqueeOverlay() {
  const box = useMarqueeBox();
  const kind = useMarqueeKind();
  if (box === null || kind === null) return null;
  return (
    <div
      data-testid="timeline-marquee"
      data-kind={kind}
      aria-hidden="true"
      className={`pointer-events-none absolute z-[4] border ${TINT[kind]}`}
      style={{
        left: Math.min(box.x0, box.x1),
        top: Math.min(box.y0, box.y1),
        width: Math.abs(box.x1 - box.x0),
        height: Math.abs(box.y1 - box.y0),
      }}
    />
  );
}
