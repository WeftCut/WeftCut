import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CircleHelp, ScanEye, StickyNote, TriangleAlert } from "lucide-react";
import type { TackKind } from "../../shared/agent-activity";
import { AppIcon } from "@/components/AppIcon";
import { formatTimecode } from "../frames";
import { getCommand } from "../commands/registry";
import { useUiScale } from "../settings/layoutTheme";
import { UI_METRICS } from "../settings/uiMetrics";
import { useComposition } from "../state/projectStore";
import { useAgentActivity } from "../agent/activityStore";
import { useCompositionTacks, useReviewLaneExists } from "../agent/tackModel";
import { useRulerScrollBlockPx } from "./TimelineRuler";
import { packLaneTacks, windowLaneTacks } from "./rulerModel";

/// The Review lane (ADR 0115): the tacks agents left for the user, as chips in
/// a row of their own between the marker lane and the drop strip.
///
/// Its own row, not a layer of the marker lane's. Tacks painted behind the
/// user's markers read as more markers, and vanished whenever the user hid
/// markers — the one switch that owns that row is about the user's marks, not
/// the agent's. Here the two never share ink, and `markers_visible` has no say.
///
/// A row in the ruler family like the marker lane: same row coordinates, same
/// quantised scroll window, so a chip and the tick above its start are the same
/// x. It EXISTS by `reviewLaneExists` — the overlay on and agent review
/// material seen in this project opening — never by how many tacks are open,
/// so an agent resolving or adding tacks mid-session cannot reflow the tracks.
/// And its height is fixed at two sub-rows of chips whatever it holds.
///
/// Never a scrub surface: the ruler stays the sole one. A chip click selects
/// its tack in the agent panel; nothing here seeks.
const REVIEW = UI_METRICS.timeline.review;

/// One icon per kind, the same the Tacks tab draws, so a chip and its panel
/// row are recognisably the same item.
const KIND_ICON: Record<TackKind, typeof StickyNote> = {
  note: StickyNote,
  issue: TriangleAlert,
  question: CircleHelp,
};

const selectTack = (id: string) => {
  useAgentActivity.getState().selectTack(id);
  void getCommand("openAgentPanel")?.run();
};

/// The lane's sticky-header cell: what the row is, and the Review overlay's
/// switch. The switch lives on the row it governs — turning it off removes
/// this row with the clip decorations, and the View menu turns it back on.
/// Reads the same existence rule as the lane, for the same reason the marker
/// lane's header does: a cell that outlived its row would slide every header
/// below it out of line with its lane.
export function ReviewLaneHeader() {
  const { t } = useTranslation();
  const scale = useUiScale();
  const exists = useReviewLaneExists();
  if (!exists) return null;
  return (
    <div
      data-testid="timeline-review-lane-header"
      className="flex items-center border-b border-border-soft bg-card px-1.5"
      style={{ height: REVIEW.laneHeight * scale }}
      // The header column is not a timeline surface (same guard as
      // `MarkerLaneHeader` and `TrackHeader`).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="truncate text-[length:var(--font-size-fine)] uppercase tracking-wide text-muted-foreground/70">
        {t("timeline.review_lane")}
      </span>
      <button
        type="button"
        data-testid="timeline-review-overlay-toggle"
        aria-pressed={true}
        aria-label={t("timeline.review_overlay")}
        title={t("timeline.review_overlay_hint")}
        onClick={() => useAgentActivity.setState({ reviewOverlay: false })}
        className="ml-auto flex flex-none items-center rounded-[2px] px-0.5 text-[color:var(--tack)] hover:bg-[var(--hover-neutral)]"
      >
        <AppIcon icon={ScanEye} size="micro" />
      </button>
    </div>
  );
}

export function ReviewLane({
  compositionId,
  pxPerSec,
  widthPx,
  viewportWidthPx,
  fpsNum,
  fpsDen,
}: {
  compositionId: string | null;
  pxPerSec: number;
  widthPx: number;
  viewportWidthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const scale = useUiScale();
  const exists = useReviewLaneExists();
  const scrollLeftPx = useRulerScrollBlockPx(compositionId);
  const selected = useAgentActivity((s) => s.selectedTack);
  // `compositionId` null names the root, as everywhere on the timeline; tacks
  // carry the concrete id.
  const resolvedId = useComposition(compositionId)?.id ?? null;
  const tacks = useCompositionTacks(exists ? resolvedId : null);
  // Packed once per tack set and zoom, not per scroll block: the sub-row a
  // chip sits on must not depend on which neighbours are on screen.
  const packing = useMemo(
    () => packLaneTacks({ tacks, pxPerSec, minChipPx: REVIEW.chipMinWidth * scale }),
    [tacks, pxPerSec, scale],
  );
  // Hover text composed per window, like the marker lane's: each title is a
  // pair of `formatTimecode` calls through the wasm frame grid.
  const painted = useMemo(() => {
    const { chips, overflow } = windowLaneTacks(packing, { scrollLeftPx, viewportWidthPx });
    return {
      chips: chips.map((chip) => ({
        chip,
        title: t("tacks.band_tooltip", {
          label: chip.label,
          time:
            formatTimecode(chip.tUs, fpsNum, fpsDen) +
            (chip.endTUs === null ? "" : ` – ${formatTimecode(chip.endTUs, fpsNum, fpsDen)}`),
        }),
      })),
      overflow,
    };
  }, [packing, scrollLeftPx, viewportWidthPx, fpsNum, fpsDen, t]);
  // Dim the rest only while the selection is ON this lane: a selected tack
  // that is resolved, hibernating or on another composition paints nowhere
  // here, and dimming every chip for it would point at nothing.
  const selectionHere =
    selected !== null &&
    (packing.chips.some((c) => c.id === selected) ||
      packing.overflow.some((o) => o.ids.includes(selected)));

  // The row itself, not merely its contents — see `reviewLaneExists`.
  if (!exists) return null;

  const rowTop = (row: number) => (REVIEW.inset + row * (REVIEW.chipHeight + REVIEW.rowGap)) * scale;
  return (
    // `overflow-hidden` for the marker lane's reason: a chip running past
    // widthPx must not inflate the parent's scrollWidth.
    <div
      data-testid="timeline-review-lane"
      data-selecting={selectionHere ? "true" : undefined}
      className="review-lane relative flex-none select-none overflow-hidden border-b border-border-soft bg-card"
      style={{ width: widthPx, height: REVIEW.laneHeight * scale }}
      // Neither a scrub surface nor a selection surface (the marker lane's
      // guard): a press here must not start the body's marquee.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {painted.chips.map(({ chip, title }) => (
        <div
          key={chip.id}
          data-testid="timeline-tack"
          data-tack-id={chip.id}
          data-kind={chip.kind}
          data-row={chip.row}
          data-selected={selected === chip.id ? "true" : undefined}
          title={title}
          className="review-tack"
          style={{
            left: chip.xPx,
            width: chip.widthPx,
            top: rowTop(chip.row),
            height: REVIEW.chipHeight * scale,
          }}
          onClick={() => selectTack(chip.id)}
        >
          <AppIcon icon={KIND_ICON[chip.kind]} size="fine" className="review-tack-icon" />
          {chip.label.trim() !== "" && <span className="review-tack-label">{chip.label}</span>}
        </div>
      ))}
      {/* Tacks that fit on neither sub-row: counted, not painted — a third
          stacked chip is exactly the overlap this lane exists to avoid. On the
          second sub-row, over its chips, so the count is never hidden. */}
      {painted.overflow.map((o) => (
        <button
          key={o.ids[0]}
          type="button"
          data-testid="timeline-tack-overflow"
          data-tack-id={o.ids[0]}
          data-count={o.ids.length}
          data-selected={selected !== null && o.ids.includes(selected) ? "true" : undefined}
          title={t("tacks.band_overflow", { count: o.ids.length })}
          className="review-tack-overflow"
          style={{
            left: o.xPx,
            minWidth: REVIEW.chipMinWidth * scale,
            top: rowTop(1),
            height: REVIEW.chipHeight * scale,
          }}
          onClick={() => selectTack(o.ids[0]!)}
        >
          +{o.ids.length}
        </button>
      ))}
    </div>
  );
}
