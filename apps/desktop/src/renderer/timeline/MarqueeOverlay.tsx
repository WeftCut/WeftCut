// The drag rectangle. Sole subscriber of `marqueeStore.ts`, mounted as the LAST
// child of `timeline-canvas` — which is what puts it over every chip (max
// `z-[3]`) and over the out-of-range wash (`z-[4]`, an earlier sibling) while
// leaving it under the playhead (`z-[4]`, a later sibling of the canvas).

import { useMarqueeBox, useMarqueeKind } from "./marqueeStore";

/// Kind-tinted fill + hairline, so the box says which population it is taking
/// before it has taken anything. Yellow is the keyframe domain accent
/// (`--keyframe`), matching the diamonds the box is sweeping.
const TINT = {
  clip: { fill: "bg-blue-400/15", edge: "bg-blue-300/85" },
  keyframe: { fill: "bg-yellow-400/15", edge: "bg-yellow-300/85" },
} as const;

export function MarqueeOverlay() {
  const box = useMarqueeBox();
  const kind = useMarqueeKind();
  if (box === null || kind === null) return null;
  const x = Math.min(box.x0, box.x1);
  const y = Math.min(box.y0, box.y1);
  const w = Math.abs(box.x1 - box.x0);
  const h = Math.abs(box.y1 - box.y0);
  const tint = TINT[kind];
  return (
    <div
      data-testid="timeline-marquee"
      data-kind={kind}
      className="pointer-events-none absolute inset-0 z-[4]"
      aria-hidden="true"
    >
      <Piece x={x} y={y} sx={w} sy={h} className={tint.fill} />
      <Piece x={x} y={y} sx={w} sy={1} className={tint.edge} />
      <Piece x={x} y={y + h} sx={w} sy={1} className={tint.edge} />
      <Piece x={x} y={y} sx={1} sy={h} className={tint.edge} />
      <Piece x={x + w} y={y} sx={1} sy={h} className={tint.edge} />
    </div>
  );
}

/**
 * One 1×1 px unit box, placed and stretched by `transform` alone.
 *
 * Never `left`/`top`/`width`/`height`: the gesture READS lane rects and writes
 * this overlay in the same frame, and a layout-affecting write between reads
 * would force a reflow per frame. A compositor-only transform removes that
 * read/write ordering discipline instead of requiring it.
 *
 * It is also why the border is four of these rather than a `border` on the
 * fill — a scaled border scales its own width, so a 200 px-wide box would carry
 * a 200 px-thick hairline.
 */
function Piece({
  x,
  y,
  sx,
  sy,
  className,
}: {
  x: number;
  y: number;
  sx: number;
  sy: number;
  className: string;
}) {
  return (
    <div
      className={`absolute left-0 top-0 h-px w-px origin-top-left ${className}`}
      style={{ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})` }}
    />
  );
}
