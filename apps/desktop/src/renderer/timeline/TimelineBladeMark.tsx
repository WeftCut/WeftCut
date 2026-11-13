import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RULER_HEIGHT_PX, TIME_MARK_WIDTH_PX, timeMarkLeftPx } from "./geometry";
import { SNAP_TARGET_COLOR } from "./TimelineSnapGuide";

const BLADE_COLOR = "#fcd34d";
/// Room the flag needs before it flips to the mark's left side.
const FLAG_FLIP_PX = 96;
/// The flag keeps to the ruler's label band: the ruler's ticks rise up to 8 px
/// from its bottom edge (`TimelineRuler`), and stay readable around the cut.
/// Its stem crosses that band to the line, as one more tick in the mark's colour.
const FLAG_TOP_PX = 1;
const FLAG_HEIGHT_PX = 11;

/** One cut clip's rows, in the mark's own coordinates. */
interface CutSpan {
  layerId: string;
  topPx: number;
  heightPx: number;
}

/**
 * The Blade tool's Time mark in `TimeMarkOverlay`: a line from the ruler's
 * bottom edge down, faint except over the clips the click splits
 * (`bladeCutLayerIds`), and in the ruler a flag carrying the cut's timecode,
 * hung from a stem on the line's x. While
 * the cut is snapped it takes the snap guide's colour; blade mode draws no
 * separate guide.
 *
 * The overlay sits outside the vertically scrolling track viewport, so the
 * solid spans are measured from the clip blocks and re-measured on its scroll,
 * clipped to it so a scrolled-away clip never paints over the ruler rows.
 */
export function TimelineBladeMark({
  atUs, snapped, cutLayerIds, label, pxPerSec, widthPx, trackViewportRef,
}: {
  atUs: number;
  snapped: boolean;
  cutLayerIds: readonly string[];
  label: string;
  pxPerSec: number;
  widthPx: number;
  trackViewportRef: RefObject<HTMLDivElement | null>;
}) {
  const markRef = useRef<HTMLDivElement>(null);
  const [cuts, setCuts] = useState<readonly CutSpan[]>([]);
  const cutKey = cutLayerIds.join(" ");
  useLayoutEffect(() => {
    const viewport = trackViewportRef.current;
    const mark = markRef.current;
    if (!viewport || !mark) return;
    const ids = new Set(cutKey.split(" "));
    const measure = () => {
      const originY = mark.getBoundingClientRect().top;
      const view = viewport.getBoundingClientRect();
      const next: CutSpan[] = [];
      for (const el of viewport.querySelectorAll<HTMLElement>(".timeline-layer[data-layer-id]")) {
        const layerId = el.dataset.layerId;
        if (layerId === undefined || !ids.has(layerId)) continue;
        const r = el.getBoundingClientRect();
        const top = Math.max(r.top, view.top);
        const bottom = Math.min(r.bottom, view.bottom);
        if (bottom > top) next.push({ layerId, topPx: top - originY, heightPx: bottom - top });
      }
      setCuts((prev) => (sameSpans(prev, next) ? prev : next));
    };
    measure();
    viewport.addEventListener("scroll", measure, { passive: true });
    return () => viewport.removeEventListener("scroll", measure);
  }, [cutKey, trackViewportRef]);

  const x = timeMarkLeftPx(atUs, pxPerSec);
  const color = snapped ? SNAP_TARGET_COLOR : BLADE_COLOR;
  const flip = x > widthPx - FLAG_FLIP_PX;
  return (
    <div
      ref={markRef}
      data-testid="timeline-blade-mark"
      data-at-us={atUs}
      data-snapped={snapped}
      aria-hidden="true"
      className="absolute bottom-0"
      style={{ top: RULER_HEIGHT_PX, left: x, width: TIME_MARK_WIDTH_PX }}
    >
      <div className="absolute inset-0 opacity-35" style={{ backgroundColor: color }} />
      {cuts.map((cut) => (
        <div key={cut.layerId} data-testid="timeline-blade-cut" data-layer-id={cut.layerId}
          className="absolute inset-x-0"
          style={{
            top: cut.topPx,
            height: cut.heightPx,
            backgroundColor: color,
            boxShadow: `0 0 0 0.5px rgba(0,0,0,0.65), 0 0 8px ${color}8c`,
          }} />
      ))}
      <div data-testid="timeline-blade-flag" className="absolute inset-x-0"
        style={{ top: FLAG_TOP_PX - RULER_HEIGHT_PX, height: RULER_HEIGHT_PX - FLAG_TOP_PX, backgroundColor: color }}>
        <div
          className={`absolute top-0 flex items-center whitespace-nowrap border bg-black/80 px-1 font-mono text-[length:var(--font-size-micro)] font-medium leading-none text-amber-100 shadow-[0_1px_5px_rgba(0,0,0,0.45)] ${
            flip ? "right-full rounded-l-sm border-r-0" : "left-full rounded-r-sm border-l-0"
          }`}
          style={{ height: FLAG_HEIGHT_PX, borderColor: `${color}80` }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

function sameSpans(a: readonly CutSpan[], b: readonly CutSpan[]): boolean {
  return a.length === b.length && a.every((s, i) => {
    const t = b[i];
    return t !== undefined && s.layerId === t.layerId && s.topPx === t.topPx && s.heightPx === t.heightPx;
  });
}
