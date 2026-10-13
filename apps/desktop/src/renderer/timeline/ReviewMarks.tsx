import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { GitCompareArrows } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { formatTimecode } from "../frames";
import {
  useGroupReviewCount,
  useLayerReviewMark,
  useTrackReviewGhosts,
} from "../agent/reviewStore";
import type { ReviewClipMark } from "../agent/reviewHighlight";
import { layerSliceRect } from "./geometry";

/// The Review overlay's marks on the editor timeline (ADR 0115). Each is an
/// absolutely positioned, `pointer-events: none` paint layer inside a box that
/// already exists — the clip block or the track lane — so turning the overlay
/// on or off moves nothing, sizes nothing and catches no press: every click,
/// drag, trim and context menu still lands on the clip or lane under it.
///
/// What they paint comes from `reviewStore`'s highlight reads, the seam a
/// per-activity highlight later feeds a different change set through.

const EDGE: Record<ReviewClipMark, CSSProperties> = {
  // A coloured edge for what is new or edited, a dashed one for what moved
  // track or composition, and a tint (no edge) for a pure shift in time.
  added: { boxShadow: "inset 0 0 0 2px var(--review-added)" },
  modified: { boxShadow: "inset 0 0 0 2px var(--review-modified)" },
  moved: { border: "2px dashed var(--review-modified)" },
  shifted: { background: "color-mix(in srgb, var(--review-shifted) 28%, transparent)" },
};

/// A clip's review mark: drawn over the clip's body, under its selection
/// outline (`z-[3]`), in the clip's own rounded box.
export function ReviewClipMarkLayer({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const mark = useLayerReviewMark(layerId);
  if (mark === null) return null;
  return (
    <span
      data-testid="review-clip-mark"
      data-review-mark={mark}
      aria-label={t(`changes.class_${mark}`)}
      role="img"
      className="pointer-events-none absolute inset-0 z-[2] rounded-[inherit]"
      style={EDGE[mark]}
    />
  );
}

/// The "contains changes" badge on a Group clip: how many highlighted changes
/// live inside the composition it shows, nesting included. Top-right, left of
/// the lock when there is one. It names; going in is the clip's double-click.
export function ReviewGroupBadge({
  layerId,
  locked,
}: {
  layerId: string;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const count = useGroupReviewCount(layerId);
  if (count === 0) return null;
  const label = t("changes.group_badge", { count });
  return (
    <span
      data-testid="review-group-badge"
      role="img"
      aria-label={label}
      className="pointer-events-none absolute right-1 top-1 z-[4] flex items-center gap-0.5 rounded px-1 py-0.5 text-[length:var(--font-size-micro)] font-semibold leading-none text-black shadow-sm"
      style={{ right: locked ? 20 : undefined, background: "var(--review-modified)" }}
    >
      <AppIcon icon={GitCompareArrows} size="fine" strokeWidth={2.5} aria-hidden="true" />
      {count}
    </span>
  );
}

/// Removed clips of one lane, outlined at their baseline place. Drawn before
/// the lane's clips, so a clip now occupying the same stretch paints over its
/// predecessor's ghost. The lane renders this only while the track still
/// exists — a removed track has no lane, so its clips have nowhere to ghost.
export function ReviewGhosts({
  trackId,
  pxPerSec,
  laneHeight,
  fpsNum,
  fpsDen,
}: {
  trackId: string;
  pxPerSec: number;
  laneHeight: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const ghosts = useTrackReviewGhosts(trackId);
  if (ghosts.length === 0) return null;
  const band = layerSliceRect(laneHeight, "full");
  return (
    <>
      {ghosts.map((g) => (
        <span
          key={g.changeId}
          data-testid="review-ghost"
          data-layer-ghost={g.layerId}
          role="img"
          aria-label={t("changes.ghost_label", {
            start: formatTimecode(g.tStartUs, fpsNum, fpsDen),
            end: formatTimecode(g.tEndUs, fpsNum, fpsDen),
          })}
          className="pointer-events-none absolute rounded"
          style={{
            left: (g.tStartUs / 1_000_000) * pxPerSec,
            width: Math.max(2, ((g.tEndUs - g.tStartUs) / 1_000_000) * pxPerSec),
            top: band.top,
            height: band.height,
            border: "1px dashed var(--review-removed)",
            background:
              "repeating-linear-gradient(135deg, color-mix(in srgb, var(--review-removed) 16%, transparent) 0 4px, transparent 4px 8px)",
          }}
        />
      ))}
    </>
  );
}
