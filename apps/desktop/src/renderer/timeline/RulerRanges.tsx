import type React from "react";
import { getCommand } from "../commands/registry";
import { useComposition } from "../state/projectStore";
import { selectChange, useReviewFocus } from "../agent/reviewFocus";
import { useCompositionChangeRanges, useRangeMarkLabel } from "../agent/reviewStore";
import type { ReviewRangeMark } from "../agent/reviewHighlight";
import { useReviewLaneExists } from "../agent/tackModel";

/// The changed ranges (ADR 0169) on the ruler: where the film plays
/// differently from the review baseline, each stretch of the clock washed in
/// its class hue with that hue along the ruler's foot, and a cut point as a ▼
/// down to the foot where baseline content was taken out and what followed
/// closed up — the cut mark's shape on the track lanes below.
///
/// On the ruler because a range is a stretch of the film's clock, not an item
/// beside the tacks: the Review lane stays the agent's notes. It shows while
/// the Review lane exists (`reviewLaneExists`), so turning the overlay off
/// takes both.
///
/// The ruler is the sole scrub surface and stays one: a press here scrubs as
/// it would on the bare ruler, so a range never takes the place the user
/// meant to seek to. The hover names the range; a double press focuses its
/// first change and shows its row, the one thing a range adds.
///
/// A sibling of the ruler strip, not a child: the strip's direct children are
/// its ticks (see the landmine in `TimelineRuler`).
export function RulerRanges({
  compositionId,
  pxPerSec,
  onScrub,
  onContextMenu,
}: {
  compositionId: string | null;
  pxPerSec: number;
  onScrub: (event: React.PointerEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const exists = useReviewLaneExists();
  const resolvedId = useComposition(compositionId)?.id ?? null;
  const ranges = useCompositionChangeRanges(exists ? resolvedId : null);
  const label = useRangeMarkLabel();
  const focused = useReviewFocus((s) => (s.focus?.kind === "change" ? s.focus.id : null));
  const hovered = useReviewFocus((s) => (s.hover?.kind === "change" ? s.hover.id : null));
  if (ranges.length === 0) return null;
  const plays = (m: ReviewRangeMark, id: string | null) => id !== null && m.range.change_ids.includes(id as never);
  return (
    <div className="pointer-events-none absolute inset-0 z-[4] overflow-hidden">
      {ranges.map((m) => {
        const x = (m.tStartUs / 1_000_000) * pxPerSec;
        const w = ((m.tEndUs - m.tStartUs) / 1_000_000) * pxPerSec;
        const first = m.range.change_ids[0];
        return (
          <div
            key={m.key}
            data-testid="timeline-ruler-range"
            data-change-class={m.cls}
            data-cut={m.cut || undefined}
            data-user={m.user || undefined}
            data-selected={plays(m, focused) || undefined}
            data-hovered={plays(m, hovered) || undefined}
            title={label(m)}
            className={`ruler-range ruler-range-${m.cls}`}
            // A cut point at the film's start hangs from its edge, not half off it.
            style={m.cut ? { left: x, ...(m.tStartUs <= 0 ? { marginLeft: 0 } : {}) } : { left: x, width: Math.max(2, w) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button === 0) onScrub(e);
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (first === undefined) return;
              selectChange(first);
              void getCommand("openAgentPanel")?.run();
            }}
            onContextMenu={onContextMenu}
          />
        );
      })}
    </div>
  );
}
