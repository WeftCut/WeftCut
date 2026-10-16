import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatTimecode } from "../frames";
import type { MarkerSummary } from "../ipc";
import type { TackView } from "../../shared/agent-activity";
import type { ReviewRangeMark } from "./reviewHighlight";
import { hitBand, type BandItem, type ReviewTarget } from "./reviewFocus";
import { tackCoverage } from "./tackModel";
import { useFocusedPlayheadUs } from "../state/playheadProjection";
import { usePointerGesture } from "../hooks/usePointerGesture";
import { uiPixels } from "../settings/layoutTheme";

/// Agent-mode mini timeline. Strip with click/drag-to-seek + a tick
/// row + project marker pips + timecode readout. No track lanes — the
/// human is supposed to be watching the preview, not editing.
///
/// Layout inside the 80-px-tall pane allocated by `.agent-mini-timeline`:
///   row 1 — tick marks (scale-adaptive)         ~14 px
///   row 2 — scrub bar with playhead + markers   ~36 px
///   row 3 — timecode readout                    ~14 px
interface MiniTimelineProps {
  durationUs: number;
  markers: MarkerSummary[];
  /// Open tacks placed on this composition (`paintableTacks`), painted as a
  /// band along the strip's foot — a separate row of ink from the marker pips,
  /// which run the strip's full height. The band is too thin to pack, so it
  /// paints the tacks' UNION (`tackCoverage`) at one opacity: overlapping
  /// tacks must not darken into what reads as a different mark.
  tacks?: readonly TackView[];
  /// The review focus (`reviewFocus`). A focused tack is drawn over the union
  /// at full strength when it is one of `tacks`, a focused change's ranges
  /// over the change band, so what the panel is showing can be found here.
  focus?: ReviewTarget | null;
  /// The panel row under the pointer (`reviewHover`): its mark is ringed.
  hover?: ReviewTarget | null;
  /// Review change ranges on this composition (`useCompositionChangeRanges`),
  /// painted as a second band along the strip's head — opposite the tack band,
  /// so the two never read as one: added/modified in their review hues; a
  /// removal at its baseline footprint, in the removed hue on a row of its
  /// own just under them (ADR 0116).
  changes?: readonly ReviewRangeMark[];
  /// What a change mark says under the pointer (`useChangeMarkLabel`) —
  /// its class alone when absent.
  changeLabel?: (mark: ReviewRangeMark) => string;
  /// A press on a band that names an item (`hitBand`) focuses it instead of
  /// seeking; the caller shows its row.
  onFocus?: (item: ReviewTarget) => void;
  onSeek: (tUs: number) => void;
  fpsNum: number;
  fpsDen: number;
}

// Pick a "nice number" tick interval (microseconds) such that the gap
// between ticks lands roughly in [60, 200] px. Mirrors the canonical
// 1/2/5 sequence many timeline UIs use.
function pickTickIntervalUs(durationUs: number, widthPx: number): number {
  if (durationUs <= 0 || widthPx <= 0) return 1_000_000;
  const SEC = 1_000_000;
  const MIN = 60 * SEC;
  // Candidate intervals, smallest → largest.
  const candidates: number[] = [
    SEC,
    2 * SEC,
    5 * SEC,
    10 * SEC,
    30 * SEC,
    MIN,
    2 * MIN,
    5 * MIN,
    10 * MIN,
    30 * MIN,
    60 * MIN,
  ];
  for (const interval of candidates) {
    const pxBetween = (interval / durationUs) * widthPx;
    if (pxBetween >= 60) return interval;
  }
  return candidates[candidates.length - 1]!;
}

function formatTickLabel(us: number): string {
  // Compact form: "1:00", "0:15", "1:30:00".
  const totalSec = Math.round(us / 1_000_000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
  return `${m}:${pad(s, 2)}`;
}

/// How near a point mark a band press still names it, in strip pixels.
const POINT_SLOP_PX = 4;

/// A change band item per painted change range — not the "contains changes"
/// footprints of Group clips, which name no row to show.
function changeBandItems(changes: readonly ReviewRangeMark[]): BandItem[] {
  return changes
    .filter((c) => !c.group)
    .map((c) => ({ id: c.changeId, startUs: c.tStartUs, endUs: c.tEndUs }));
}

/// Where the row of removals' baseline footprints starts, under the current
/// change band (`.mini-change-historical`), in theme baseline px: a press
/// below it names a historical mark first, one above it a current mark first.
const HISTORY_ROW_TOP = 5;

/// Room left after the last baseline footprint past the film's end, as a
/// fraction of its time.
const BEYOND_END_PAD = 0.02;

export function MiniTimeline({
  durationUs,
  markers,
  tacks = [],
  focus = null,
  hover = null,
  changes = [],
  changeLabel,
  onFocus,
  onSeek,
  fpsNum,
  fpsDen,
}: MiniTimelineProps) {
  const { t } = useTranslation();
  // Frame-rate playhead subscription (tier 4, playheadStore.ts): the
  // agent-mode progress strip is a tiny leaf subtree, so per-frame React
  // updates here are cheap and keep the playhead butter-smooth. Projected —
  // the strip's ticks are the open composition's own, so the moment has to be
  // read on that composition's clock.
  const currentTimeUs = useFocusedPlayheadUs();
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Strip width drives tick density. ResizeObserver writes into
  // state so the next render picks up the new tick set; the setter
  // is short-circuited when width hasn't actually changed so window
  // events that hit other elements don't churn this component.
  const [stripWidth, setStripWidth] = useState<number>(0);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        setStripWidth((prev) => (prev === w ? prev : w));
      }
    });
    ro.observe(el);
    setStripWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  // Click / drag anywhere on the strip → seek. The shared pointer session
  // tracks outside the strip and releases every listener if scrubbing aborts.
  // The strip's scale: the composition, stretched past its end when a
  // removal's baseline footprint lies there (a ripple shortened the film) —
  // where it was is still somewhere to point at, with a little room after it
  // so a point there is not cut off by the strip's edge. Seeking stays inside
  // the film.
  const extentUs = useMemo(() => {
    const end = changes.reduce((e, c) => (c.historical ? Math.max(e, c.tEndUs) : e), durationUs);
    return end > durationUs ? Math.round(end * (1 + BEYOND_END_PAD)) : durationUs;
  }, [changes, durationUs]);
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el || durationUs <= 0) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const t = Math.min(durationUs, Math.round((x / rect.width) * extentUs));
      onSeek(t);
    },
    [durationUs, extentUs, onSeek],
  );

  const beginGesture = usePointerGesture();
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      beginGesture(e.pointerId, {
        move: (ev) => seekFromClientX(ev.clientX),
        release: () => {},
        cancel: () => {},
      });
      seekFromClientX(e.clientX);
    },
    [seekFromClientX, beginGesture],
  );

  const width = stripWidth;
  const safeDuration = Math.max(extentUs, 1);
  const tickInterval = pickTickIntervalUs(safeDuration, width);
  const ticks: { tUs: number; left: number }[] = [];
  if (width > 0 && durationUs > 0) {
    for (let t = 0; t <= extentUs; t += tickInterval) {
      ticks.push({ tUs: t, left: (t / extentUs) * width });
    }
  }

  // Merged once per tack set: the union is what the band paints, so a strip
  // under a dense review reads as covered, not as a stack of shades.
  const tackBand = useMemo(() => tackCoverage(tacks), [tacks]);
  const tackItems = useMemo<BandItem[]>(
    () =>
      tacks.flatMap((tack) =>
        tack.t_us === null
          ? []
          : [{ id: tack.id, startUs: tack.t_us, endUs: Math.max(tack.t_us, tack.end_t_us ?? tack.t_us) }],
      ),
    [tacks],
  );
  const changeItems = useMemo(() => changeBandItems(changes.filter((c) => !c.historical)), [changes]);
  const historyItems = useMemo(() => changeBandItems(changes.filter((c) => c.historical)), [changes]);
  // The focused and hovered tack, drawn over the union: the selection solid,
  // the hover ringed (a hover on the selection adds nothing).
  const tackSpan = (item: ReviewTarget | null) =>
    item?.kind === "tack" ? tackItems.find((x) => x.id === item.id) ?? null : null;
  const selectedSpan = tackSpan(focus);
  const hoverSpan = hover?.kind === "tack" && hover.id !== selectedSpan?.id ? tackSpan(hover) : null;
  const changeMark = (c: ReviewRangeMark) =>
    focus?.kind === "change" && focus.id === c.changeId
      ? " mini-change-selected"
      : hover?.kind === "change" && hover.id === c.changeId
        ? " mini-change-hover"
        : "";

  // A band press names the item under it — the tack or change whose range
  // holds that moment — and focuses it; on bare band it falls through to the
  // strip's seek. Measured on the hit row itself, which spans the strip.
  const bandItemAt = (items: readonly BandItem[], e: React.PointerEvent<HTMLElement>): string | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || durationUs <= 0) return null;
    const tUs = ((e.clientX - rect.left) / rect.width) * extentUs;
    return hitBand(items, tUs, (POINT_SLOP_PX / rect.width) * extentUs);
  };
  // The change band holds two rows; the one pressed is asked first, so a
  // removal's footprint under a current change is reachable from its own row.
  const changeAt = (e: React.PointerEvent<HTMLElement>): string | null => {
    const lower = e.clientY - e.currentTarget.getBoundingClientRect().top >= uiPixels(HISTORY_ROW_TOP);
    const [first, second] = lower ? [historyItems, changeItems] : [changeItems, historyItems];
    return bandItemAt(first, e) ?? bandItemAt(second, e);
  };
  const bandHandlers = (
    kind: ReviewTarget["kind"],
    itemAt: (e: React.PointerEvent<HTMLElement>) => string | null,
    label: (id: string) => string,
  ) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || onFocus === undefined) return;
      const id = itemAt(e);
      if (id === null) return;
      // The strip's own pointerdown would seek; this press was for the item.
      e.stopPropagation();
      onFocus({ kind, id });
    },
    // The label under the pointer as the hover text — set on the node, not
    // through state, so moving along the band renders nothing.
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const id = itemAt(e);
      e.currentTarget.title = id === null ? "" : label(id);
    },
  });

  const playheadLeft =
    durationUs > 0
      ? (Math.max(0, Math.min(currentTimeUs, durationUs)) / extentUs) * width
      : 0;

  return (
    <div className="mini-timeline">
      <div className="mini-timeline-ticks">
        {ticks.map(({ tUs, left }) => (
          // Labels hang off the tick's right side by default; within
          // 48 px of the right edge that pushes the label past the
          // strip (worst case "1:30:00" ≈ 40 px), so flip the anchor.
          <div
            key={tUs}
            className={width - left < 48 ? "mini-tick mini-tick-flip" : "mini-tick"}
            style={{ left }}
          >
            <span className="mini-tick-label">{formatTickLabel(tUs)}</span>
          </div>
        ))}
      </div>
      <div
        ref={stripRef}
        className="mini-timeline-strip-real"
        onPointerDown={onPointerDown}
      >
        {markers.map((m) => {
          if (durationUs <= 0) return null;
          // A hibernating marker's `t_us` names a moment its clip no longer
          // shows, so there is no position on this strip to paint it AT — the
          // same reason the full timeline's lane drops them
          // (`computeLaneMarkers`). Not the `markers_visible` case: that flag is
          // a preference about canvas noise, and this strip deliberately ignores
          // it. An anchor that has left its window is a fact about the project.
          if (m.hibernating) return null;
          const left = (m.t_us / extentUs) * 100;
          const regionWidth =
            m.end_t_us !== null && m.end_t_us > m.t_us
              ? ((m.end_t_us - m.t_us) / extentUs) * 100
              : 0;
          return (
            <div
              key={m.id}
              className={regionWidth > 0 ? "mini-marker-region" : "mini-marker-pip"}
              style={
                regionWidth > 0
                  ? {
                      left: `${left}%`,
                      width: `${regionWidth}%`,
                      background: m.color_hint,
                    }
                  : { left: `${left}%`, background: m.color_hint }
              }
              // Same empty-label fallback as the marker lane's `markerTitle`,
              // trim included: a whitespace-only label must read as the entity
              // noun on both surfaces, not blank on one of them.
              title={m.label.trim() || t("kinds.marker")}
            />
          );
        })}
        {durationUs > 0 && tackBand.spans.map(([start, end]) => (
          <div
            key={`span-${start}`}
            data-testid="mini-tack"
            className="mini-tack mini-tack-region"
            style={{ left: `${(start / extentUs) * 100}%`, width: `${((end - start) / extentUs) * 100}%` }}
          />
        ))}
        {durationUs > 0 && tackBand.points.map((tUs) => (
          <div
            key={`point-${tUs}`}
            data-testid="mini-tack"
            className="mini-tack mini-tack-point"
            style={{ left: `${(tUs / extentUs) * 100}%` }}
          />
        ))}
        {durationUs > 0 && ([["selected", selectedSpan], ["hover", hoverSpan]] as const).map(([role, span]) =>
          span === null ? null : (
            <div
              key={role}
              data-testid={`mini-tack-${role}`}
              className={`mini-tack mini-tack-${role} ${span.endUs <= span.startUs ? "mini-tack-point" : "mini-tack-region"}`}
              style={{
                left: `${(span.startUs / extentUs) * 100}%`,
                ...(span.endUs <= span.startUs
                  ? {}
                  : { width: `${((span.endUs - span.startUs) / extentUs) * 100}%` }),
              }}
            />
          ),
        )}
        {durationUs > 0 && extentUs > durationUs && (
          <div
            data-testid="mini-beyond-end"
            className="mini-beyond-end"
            style={{ left: `${(durationUs / extentUs) * 100}%` }}
          />
        )}
        {durationUs > 0 && changes.map((c, i) => {
          const left = (c.tStartUs / extentUs) * 100;
          const span = ((c.tEndUs - c.tStartUs) / extentUs) * 100;
          return (
            <div
              key={`${c.changeId}-${i}`}
              data-testid="mini-change"
              data-change-id={c.changeId}
              data-change-class={c.cls}
              data-historical={c.historical || undefined}
              className={`mini-change mini-change-${c.cls}${c.historical ? " mini-change-historical" : ""}${changeMark(c)}`}
              style={{ left: `${left}%`, width: `${Math.max(0, span)}%` }}
            />
          );
        })}
        {durationUs > 0 && onFocus !== undefined && changeItems.length + historyItems.length > 0 && (
          <div
            data-testid="mini-change-band"
            className="mini-band-hit mini-band-hit-changes"
            {...bandHandlers("change", changeAt, (id) => {
              const c = changes.find((x) => x.changeId === id);
              if (c === undefined) return "";
              return changeLabel ? changeLabel(c) : t(`changes.class_${c.cls}`);
            })}
          />
        )}
        {durationUs > 0 && onFocus !== undefined && tackItems.length > 0 && (
          <div
            data-testid="mini-tack-band"
            className="mini-band-hit mini-band-hit-tacks"
            {...bandHandlers("tack", (e) => bandItemAt(tackItems, e), (id) => {
              const tack = tacks.find((x) => x.id === id);
              return tack === undefined ? "" : tack.label.trim() || t(`tacks.kind_${tack.kind}`);
            })}
          />
        )}
        <div className="mini-playhead" style={{ left: playheadLeft }} />
      </div>
      <div
        className="mini-timeline-tc"
        title={
          "Playhead position / composition duration. Numerator is a frame anchor " +
          "(start of the currently-painted frame); denominator is the exclusive " +
          "duration boundary. For a 10s 30fps comp at end of playback, this reads " +
          "00:00:09:29 / 00:00:10:00 — both correct, different semantics."
        }
      >
        {formatTimecode(currentTimeUs, fpsNum, fpsDen)} / {formatTimecode(durationUs, fpsNum, fpsDen)}
      </div>
    </div>
  );
}
