import { Fragment, useEffect, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { GitCompareArrows } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { formatTimecode } from "../frames";
import {
  useChangeWords,
  useGroupReviewCount,
  useHighlightedChanges,
  useLayerReviewChange,
  useLayerReviewMark,
  useTrackReviewCuts,
  useTrackReviewGhosts,
} from "../agent/reviewStore";
import type { ReviewClipMark, ReviewCut } from "../agent/reviewHighlight";
import {
  useCompositionFocusWashes,
  useFocusedChangeId,
  useGhostFocus,
  useLayerFocusMark,
  useReviewMarksRecede,
  useTrackFocusWas,
  useFocusPaint,
  releaseFocus,
  selectChange,
} from "../agent/reviewFocus";
import { changeLine, formatSeconds, framedWords } from "../agent/changeWords";
import { getCommand } from "../commands/registry";
import { uiPixels, useUiScale } from "../settings/layoutTheme";
import { UI_METRICS } from "../settings/uiMetrics";
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
  // A coloured edge: green for what is new, amber for what differs — a move
  // to another track or time included. What it differs in is the panel's
  // to say, in words, not one more hue here.
  added: { boxShadow: "inset 0 0 0 2px var(--review-added)" },
  modified: { boxShadow: "inset 0 0 0 2px var(--review-modified)" },
};

/// A clip's review mark: drawn over the clip's body, under its selection
/// outline (`z-[3]`), in the clip's own rounded box. And the review focus's
/// outline (`agent/reviewFocus.ts`), inside that box too, so it never leaves
/// the lane or lands on a neighbour: one neutral hairline inside the mark's own
/// edge, whatever is focused (`.review-focus-outline`). While a change is
/// focused, the marks of the others step back.
export function ReviewClipMarkLayer({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const mark = useLayerReviewMark(layerId);
  const focus = useLayerFocusMark(layerId);
  // While a change is focused every other clip dims (`ReviewFocusExit` ends it).
  const dim = useReviewMarksRecede() && focus !== "change";
  const recede = dim;
  if (mark === null && focus === null && !dim) return null;
  return (
    <>
      {dim && (
        <span
          data-testid="review-spotlight-dim"
          aria-hidden="true"
          className="review-spotlight-dim pointer-events-none absolute inset-0 z-[2] rounded-[inherit]"
        />
      )}
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

/// The words a clip's tooltip adds for its review mark: its change's line
/// (`changeLine`) — the panel row's words, so a clip reads the same pointed at
/// from either side. The project is read only for a marked clip, so an
/// unmarked block hears nothing of a publication from here.
export function useLayerReviewTitle(layerId: string | null): string | null {
  const change = useLayerReviewChange(layerId);
  const words = useChangeWords({ active: change !== null });
  return useMemo(() => (change === null || change.class === "removed" ? null : changeLine(change, words)), [change, words]);
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
  const count = useGroupReviewCount(layerId);
  const words = useChangeWords({ active: false });
  if (count === 0) return null;
  const label = framedWords(words, "group_badge", { count });
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

/// Removed clips at their historical baseline position, explicitly labelled. Drawn before
/// the lane's clips, so a clip now occupying the same stretch paints over its
/// predecessor's ghost. The lane renders this only while the track still
/// exists — a removed track has no lane, so its clips have nowhere to ghost.
///
/// A ghost has no clip to select, so a click on it focuses its change in the
/// agent panel instead. It takes the click and nothing else: the press still
/// bubbles to the lane, which reads it as background as it would without the
/// ghost (a box from here, a gap click), and a clip over it keeps its own.
///
/// While its change is focused or its row hovered, the ghost lifts over the
/// clips as its dashed edge alone (`data-raised`): after a ripple the content
/// that closed up sits exactly where it was, and would hide it. Lifted, it
/// takes no press, so the clip under it keeps every one.
///
/// And always, over the clips, a thin removed-hue edge along the lane's top
/// across the same stretch (`review-ghost-edge`) — the lane-top red the cut
/// marks speak — so a removal reads on the timeline without being looked for,
/// without the box that would say the clip now there is the one removed.
/// Focused, it lifts over the clips as its dashed edge alone and is named
/// "removed" in its corner: the removed-hue twin of a move's "before" box.
/// Paint only. Under an activity's highlight the stretch is where the clip
/// was before that call, and the words say so.
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
  const ghosts = useTrackReviewGhosts(trackId);
  const focus = useGhostFocus();
  const words = useChangeWords({ active: false });
  if (ghosts.length === 0) return null;
  const band = layerSliceRect(laneHeight, "full");
  return (
    <>
      {ghosts.map((g) => {
        const mark = focus.ghosts.get(g.changeId);
        const recede = (focus.recede && mark !== "change") || undefined;
        const left = (g.tStartUs / 1_000_000) * pxPerSec;
        const width = Math.max(2, ((g.tEndUs - g.tStartUs) / 1_000_000) * pxPerSec);
        return (
        <Fragment key={g.changeId}>
        <span
          data-testid="review-ghost"
          data-layer-ghost={g.layerId}
          data-change-id={g.changeId}
          data-focus={mark}
          data-raised={mark !== undefined || undefined}
          data-recede={recede}
          role="img"
          aria-label={framedWords(words, "ghost_label", {
            start: formatTimecode(g.tStartUs, fpsNum, fpsDen),
            end: formatTimecode(g.tEndUs, fpsNum, fpsDen),
          })}
          title={framedWords(words, "ghost_label", {
            start: formatTimecode(g.tStartUs, fpsNum, fpsDen),
            end: formatTimecode(g.tEndUs, fpsNum, fpsDen),
          })}
          onClick={() => {
            selectChange(g.changeId);
            void getCommand("openAgentPanel")?.run();
          }}
          className={`review-ghost absolute overflow-hidden rounded ${mark !== undefined ? "pointer-events-none z-[3]" : "cursor-pointer"}`}
          style={{ left, width, top: band.top, height: band.height }}
        >
          {mark === "change" && (
            <span className="review-was-label review-ghost-label">
              {framedWords(words, "ghost_tag", {
                start: formatSeconds(g.tStartUs),
                end: formatSeconds(g.tEndUs),
              })}
            </span>
          )}
        </span>
        {/* Focused, its named box says it; the edge would draw it twice. */}
        {mark !== "change" && (
        <span
          data-testid="review-ghost-edge"
          data-change-id={g.changeId}
          data-recede={recede}
          aria-hidden="true"
          className="review-ghost-edge pointer-events-none absolute top-0 z-[3]"
          style={{ left, width }}
        />
        )}
        </Fragment>
        );
      })}
    </>
  );
}

/// The review focus's time range, washed across one lane: a translucent band
/// for a range, a thin line for a point. The lane renders it FIRST, so it lies
/// over the lane's own background and under everything the lane draws — gap,
/// ghosts, clips. Paint only: no pointer events, no box of its own in the
/// flow, so the focus moving never reflows or re-hits anything. The tack hue
/// for a tack, the neutral review-focus hue for a change; a removal's baseline
/// footprint hatched in the removed hue — where it was, not what is there —
/// unless it is a clip whose lane survives, which its raised ghost shows.
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
            data-historical={w.historical || undefined}
            aria-hidden="true"
            className="review-focus-wash pointer-events-none absolute inset-y-0 z-[2]"
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

/// A focused change's historical baseline footprint on this lane: a dashed
/// box the shape of a clip, named "before" in its corner, lifted over the
/// blocks (`z-[3]`) — the clip that now sits there would otherwise hide it.
/// Only while that change is focused (`buildFocusPaint`), when every other
/// clip has dimmed: the box crossing a dimmed neighbour reads as a layer over
/// the timeline, not a cut through that clip. Dashed, as a place and not a
/// thing; neutral, never the removed hue. Paint only.
export function ReviewWasFrames({
  trackId,
  pxPerSec,
  laneHeight,
}: {
  trackId: string;
  pxPerSec: number;
  laneHeight: number;
}) {
  const was = useTrackFocusWas(trackId);
  const words = useChangeWords({ active: false });
  if (was.length === 0) return null;
  const band = layerSliceRect(laneHeight, "full");
  return (
    <>
      {was.map((w, i) => (
        <span
          key={i}
          data-testid="review-was"
          aria-hidden="true"
          className="review-was pointer-events-none absolute z-[3] overflow-hidden rounded"
          style={{
            left: (w.startUs / 1_000_000) * pxPerSec,
            width: Math.max(2, ((w.endUs - w.startUs) / 1_000_000) * pxPerSec),
            top: band.top,
            height: band.height,
          }}
        >
          <span className="review-was-label">
            {framedWords(words, "was_label", {
              start: formatSeconds(w.startUs),
              end: formatSeconds(w.endUs),
            })}
          </span>
        </span>
      ))}
    </>
  );
}

/// A focused change dims the rest of the timeline, so the focus ends with the
/// look: a press on the lanes anywhere but a clip of the focused change lets
/// it go (approving it already does). A press on the focused clip keeps it, so
/// it can still be selected and trimmed. Not Esc — on the timeline Esc already
/// ends blade and region arms, and one key ending two things is a surprise.
export function ReviewFocusExit() {
  const active = useReviewMarksRecede();
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest('[data-testid="track-lane"]')) return;
      const layerId = el.closest<HTMLElement>("[data-layer-id]")?.dataset.layerId;
      if (layerId !== undefined && useFocusPaint.getState().layers.get(layerId) === "change") return;
      releaseFocus();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [active]);
  return null;
}

/** Cut marks of one lane that read as one at this zoom: neighbours closer than
 *  `mergePx` chain into a group, drawn at the middle of its span — so two
 *  groups' marks are never closer than that either. `cuts` in time order. */
export function mergeCuts(
  cuts: readonly ReviewCut[],
  pxPerSec: number,
  mergePx: number,
): { px: number; cuts: ReviewCut[] }[] {
  const out: { first: number; last: number; cuts: ReviewCut[] }[] = [];
  for (const c of cuts) {
    const px = (c.tUs / 1_000_000) * pxPerSec;
    const open = out.at(-1);
    if (open && px - open.last < mergePx) {
      open.last = px;
      open.cuts.push(c);
    } else out.push({ first: px, last: px, cuts: [c] });
  }
  return out.map((g) => ({ px: (g.first + g.last) / 2, cuts: g.cuts }));
}

/// Cut marks: a small red ▼ hanging from the lane's top edge where material was
/// taken out — the end a trim cut back. The
/// three colours mark what is there; this marks what is no longer there where
/// no geometry says so (a gap left by a plain delete has its ghost). It has
/// no name in the UI; its tooltip says what was cut.
///
/// After the blocks and above them (`z-[3]`, later in the lane than a selected
/// `z-[2]` block or a dragged `z-[3]` one), so a mark at a clip's edge stays
/// visible; small, so a clip's name under it stays readable. Marks closer than
/// a few pixels at the current zoom merge into one, its tooltip a line per
/// change. Like a ghost it takes the click — focusing its (first) change in the
/// agent panel — and nothing else: the press bubbles to the lane, which reads
/// it as background.
export function ReviewCuts({ trackId, pxPerSec }: { trackId: string; pxPerSec: number }) {
  useUiScale();
  const cuts = useTrackReviewCuts(trackId);
  const changes = useHighlightedChanges();
  const words = useChangeWords({ active: cuts.length > 0 });
  const recede = useReviewMarksRecede();
  const focused = useFocusedChangeId();
  if (cuts.length === 0) return null;
  const metrics = UI_METRICS.timeline.review.cutMark;
  const [width, height] = [uiPixels(metrics.width), uiPixels(metrics.height)];
  return (
    <>
      {mergeCuts(cuts, pxPerSec, uiPixels(metrics.merge)).map((g) => {
        const lines: string[] = [];
        const seen = new Set<string>();
        for (const c of g.cuts) {
          const change = changes.get(c.changeId);
          if (!change || seen.has(c.changeId)) continue;
          seen.add(c.changeId);
          lines.push(changeLine(change, words));
        }
        const label = lines.join("\n");
        const first = g.cuts[0]!;
        const mine = focused !== null && seen.has(focused);
        return (
          <span
            key={`${first.changeId}:${first.kind}:${first.tUs}`}
            data-testid="review-cut"
            data-change-id={first.changeId}
            data-cut-kind={first.kind}
            data-count={g.cuts.length}
            data-focus={mine ? "change" : undefined}
            data-recede={(recede && !mine) || undefined}
            role="img"
            aria-label={label}
            title={label}
            onClick={() => {
              selectChange(first.changeId);
              void getCommand("openAgentPanel")?.run();
            }}
            className="review-cut absolute top-0 z-[3] flex cursor-pointer"
            style={{ left: g.px - width / 2, width, height }}
          >
            <svg viewBox="0 0 7 5" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">
              <path d="M0 0H7L3.5 5Z" />
            </svg>
          </span>
        );
      })}
    </>
  );
}
