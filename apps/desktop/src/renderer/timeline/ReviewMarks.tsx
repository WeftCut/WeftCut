import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { GitCompareArrows } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { formatTimecode } from "../frames";
import {
  useActivityHighlightShown,
  useGroupReviewCount,
  useLayerReviewMark,
  useTrackReviewGhosts,
} from "../agent/reviewStore";
import type { ReviewClipMark } from "../agent/reviewHighlight";
import { useAgentActivity } from "../agent/activityStore";
import {
  useCompositionFocusWashes,
  useGhostFocus,
  useLayerFocusMark,
  useReviewMarksRecede,
} from "../agent/reviewFocus";
import { getCommand } from "../commands/registry";
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
/// outline (`z-[3]`), in the clip's own rounded box. And the review focus's
/// outline (`agent/reviewFocus.ts`): a ring just OUTSIDE the box, beyond the
/// selection outline, so it never covers the mark's own edge or the selection
/// — a clip can be all three at once. While a change is focused, the marks of
/// the others step back.
export function ReviewClipMarkLayer({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const mark = useLayerReviewMark(layerId);
  const focus = useLayerFocusMark(layerId);
  const recede = useReviewMarksRecede() && focus !== "change";
  if (mark === null && focus === null) return null;
  return (
    <>
      {mark !== null && (
        <span
          data-testid="review-clip-mark"
          data-review-mark={mark}
          data-recede={recede || undefined}
          aria-label={t(`changes.class_${mark}`)}
          role="img"
          className="review-clip-mark pointer-events-none absolute inset-0 z-[2] rounded-[inherit]"
          style={EDGE[mark]}
        />
      )}
      {focus !== null && (
        <span
          data-testid="review-focus-outline"
          data-focus={focus}
          aria-hidden="true"
          className="review-focus-outline pointer-events-none absolute z-[3]"
        />
      )}
    </>
  );
}

/// The "contains changes" badge on a Group clip: how many highlighted changes
/// live inside the composition it shows, nesting included. Top-right, left of
/// the lock when there is one. It names; going in is the clip's double-click.
/// Counting a selected activity's changes, it does not call them unreviewed.
export function ReviewGroupBadge({
  layerId,
  locked,
}: {
  layerId: string;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const count = useGroupReviewCount(layerId);
  const activity = useActivityHighlightShown();
  if (count === 0) return null;
  const label = t(activity ? "changes.group_badge_activity" : "changes.group_badge", { count });
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
///
/// A ghost has no clip to select, so a click on it focuses its change in the
/// agent panel instead. It takes the click and nothing else: the press still
/// bubbles to the lane, which reads it as background as it would without the
/// ghost (a box from here, a gap click), and a clip over it keeps its own.
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
  const focus = useGhostFocus();
  if (ghosts.length === 0) return null;
  const band = layerSliceRect(laneHeight, "full");
  return (
    <>
      {ghosts.map((g) => (
        <span
          key={g.changeId}
          data-testid="review-ghost"
          data-layer-ghost={g.layerId}
          data-change-id={g.changeId}
          data-focus={focus.ghosts.get(g.changeId)}
          data-recede={(focus.recede && focus.ghosts.get(g.changeId) !== "change") || undefined}
          role="img"
          aria-label={t("changes.ghost_label", {
            start: formatTimecode(g.tStartUs, fpsNum, fpsDen),
            end: formatTimecode(g.tEndUs, fpsNum, fpsDen),
          })}
          title={t("changes.ghost_label", {
            start: formatTimecode(g.tStartUs, fpsNum, fpsDen),
            end: formatTimecode(g.tEndUs, fpsNum, fpsDen),
          })}
          onClick={() => {
            useAgentActivity.getState().selectChange(g.changeId);
            void getCommand("openAgentPanel")?.run();
          }}
          className="review-ghost absolute cursor-pointer rounded"
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

/// The review focus's time range, washed across one lane: a translucent band
/// for a range, a thin line for a point. The lane renders it FIRST, so it lies
/// over the lane's own background and under everything the lane draws — gap,
/// ghosts, clips. Paint only: no pointer events, no box of its own in the
/// flow, so the focus moving never reflows or re-hits anything. The tack hue
/// for a tack, the neutral review-focus hue for a change.
export function ReviewFocusWash({
  compositionId,
  pxPerSec,
}: {
  compositionId: string | null;
  pxPerSec: number;
}) {
  const washes = useCompositionFocusWashes(compositionId);
  if (washes.length === 0) return null;
  return (
    <>
      {washes.map((w, i) => {
        const point = w.endUs <= w.startUs;
        return (
          <span
            key={i}
            data-testid="review-focus-wash"
            data-kind={w.kind}
            data-point={point || undefined}
            aria-hidden="true"
            className="review-focus-wash pointer-events-none absolute inset-y-0"
            style={{
              left: (w.startUs / 1_000_000) * pxPerSec,
              width: point ? undefined : ((w.endUs - w.startUs) / 1_000_000) * pxPerSec,
            }}
          />
        );
      })}
    </>
  );
}
