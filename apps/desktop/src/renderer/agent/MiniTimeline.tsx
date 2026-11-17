import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatTimecode } from "../frames";
import type { MarkerSummary } from "../ipc";
import type { TackView } from "../../shared/agent-activity";
import type { ReviewRangeMark } from "./reviewHighlight";
import { hitBand, rangeKey, type BandItem, type ReviewTarget } from "./reviewFocus";
import { tackCoverage } from "./tackModel";
import { useFocusedPlayheadUs } from "../state/playheadProjection";
import { usePointerGesture } from "../hooks/usePointerGesture";
import { uiPixels } from "../settings/layoutTheme";
import { UI_METRICS } from "../settings/uiMetrics";

/// Agent-mode mini timeline. Strip with click/drag-to-seek + a tick
/// row + project marker pips + timecode readout. No track lanes — the
/// human is supposed to be watching the preview, not editing.
///
/// Three rows, and `.agent-mini-timeline` is as tall as they are (all themed):
///   row 1 — tick marks (scale-adaptive)         14 ui-px
///   row 2 — scrub bar with playhead + markers   36 ui-px
///   row 3 — timecode readout                    one caption line
interface MiniTimelineProps {
  durationUs: number;
  markers: MarkerSummary[];
  /// Open tacks placed on this composition (`paintableTacks`), painted as a
  /// band along the strip's foot — a separate row of ink from the markers'
  /// row through the strip's middle. The band is too thin to pack, so it
  /// paints the tacks' UNION (`tackCoverage`) at one opacity: overlapping
  /// tacks must not darken into what reads as a different mark.
  tacks?: readonly TackView[];
  /// The review focus (`reviewFocus`), shown as the editor timeline shows it:
  /// its range washed the strip's full height, its own mark at full strength
  /// and the others in its band stepping back. No mark grows, so a focused
  /// change never covers the removal row under it. A focused changed range
  /// comes as its `rangeKey`.
  focus?: ReviewTarget | null;
  /// The panel row under the pointer (`reviewHover`): its mark is ringed
  /// inside its own box.
  hover?: ReviewTarget | null;
  /// Changed ranges on this composition (`useCompositionChangeRanges`; ADR
  /// 0169), painted as a second band along the strip's head — opposite the
  /// tack band, so the two never read as one: each range in its class hue, a
  /// cut point (removed with no width now) as a mark hanging from the top, the
  /// user's own ranges muted.
  changes?: readonly ReviewRangeMark[];
  /// What a range says under the pointer (`useRangeMarkLabel`) — its class
  /// alone when absent.
  changeLabel?: (mark: ReviewRangeMark) => string;
  /// A press on a band that names an item (`hitBand`) focuses it instead of
  /// seeking; the caller shows its row. On the change band the item is the
  /// changed range under the press (`kind: "range"`, its `rangeKey`).
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

/// The review bands' metrics: a press's slop round a point mark, and how
/// near two changed ranges paint as one block.
const MINI = UI_METRICS.agent.miniTimeline;

/// One painted block of the change band: ranges of one look (class, owner)
/// close enough at this width to read as one, kept apart in the hover
/// text.
interface ChangeBlock {
  key: string;
  cls: ReviewRangeMark["cls"];
  cut: boolean;
  user: boolean;
  startUs: number;
  endUs: number;
  marks: ReviewRangeMark[];
}

/// The band's blocks at `widthPx`: a range keeps at least `minPx`, and ranges
/// of one look nearer than `mergePx` paint as one block — merged for the eye
/// only, every range still named under the pointer.
function changeBlocks(marks: readonly ReviewRangeMark[], extentUs: number, widthPx: number): ChangeBlock[] {
  const usPerPx = widthPx > 0 ? extentUs / widthPx : 0;
  const mergeUs = MINI.changeMergePx * usPerPx;
  const out: ChangeBlock[] = [];
  for (const m of [...marks].sort((a, b) => a.tStartUs - b.tStartUs)) {
    const last = out.at(-1);
    if (last && last.cls === m.cls && last.cut === m.cut && last.user === m.user && m.tStartUs - last.endUs <= mergeUs) {
      last.endUs = Math.max(last.endUs, m.tEndUs);
      last.marks.push(m);
    } else {
      out.push({ key: m.key, cls: m.cls, cut: m.cut, user: m.user, startUs: m.tStartUs, endUs: m.tEndUs, marks: [m] });
    }
  }
  return out;
}

/// The range of block `b` a press at `tUs` names: the one holding it, else
/// the nearest — a block merges ranges for the eye only, each still its own
/// to focus.
function blockRangeAt(b: ChangeBlock, tUs: number): ReviewRangeMark | null {
  let best: ReviewRangeMark | null = null;
  let distance = Infinity;
  for (const m of b.marks) {
    const d = tUs < m.tStartUs ? m.tStartUs - tUs : tUs > m.tEndUs ? tUs - m.tEndUs : 0;
    if (d < distance) { best = m; distance = d; }
  }
  return best;
}

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
  // Changed ranges are in the film's own time (ADR 0169), so the strip's
  // scale is the composition.
  const extentUs = durationUs;
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
  const blocks = useMemo(() => changeBlocks(changes, extentUs, width), [changes, extentUs, width]);
  const changeItems = useMemo<BandItem[]>(() => blocks.map((b) => ({ id: b.key, startUs: b.startUs, endUs: b.endUs })), [blocks]);
  // The focused and hovered tack, drawn over the union: the selection solid,
  // the hover ringed (a hover on the selection adds nothing).
  const tackSpan = (item: ReviewTarget | null) =>
    item?.kind === "tack" ? tackItems.find((x) => x.id === item.id) ?? null : null;
  const selectedSpan = tackSpan(focus);
  const hoverSpan = hover?.kind === "tack" && hover.id !== selectedSpan?.id ? tackSpan(hover) : null;
  // The focus's washes: the tack's range, the focused changed range, or
  // each changed range the focused change plays in.
  const marksOf = (item: ReviewTarget | null): readonly ReviewRangeMark[] =>
    item?.kind === "range"
      ? changes.filter((m) => rangeKey(m.range) === item.id)
      : item?.kind === "change"
        ? changes.filter((m) => m.range.change_ids.includes(item.id as never))
        : [];
  const focusMarks = marksOf(focus);
  const hoverMarks = marksOf(hover);
  const names = (b: ChangeBlock, marks: readonly ReviewRangeMark[]) => b.marks.some((m) => marks.includes(m));
  const focusWashes: { kind: "tack" | "change"; startUs: number; endUs: number }[] =
    selectedSpan !== null
      ? [{ kind: "tack", startUs: selectedSpan.startUs, endUs: selectedSpan.endUs }]
      : focusMarks.map((c) => ({ kind: "change", startUs: c.tStartUs, endUs: c.tEndUs }));
  const focusBand = focusWashes[0]?.kind;
  const changeMark = (b: ChangeBlock) =>
    names(b, focusMarks) ? " mini-change-selected" : names(b, hoverMarks) ? " mini-change-hover" : "";

  // A band press names the item under it — the tack or changed range that
  // holds that moment — and focuses it; on bare band it falls through to the
  // strip's seek. Measured on the hit row itself, which spans the strip.
  const bandTimeAt = (e: React.MouseEvent<HTMLElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || durationUs <= 0) return null;
    return ((e.clientX - rect.left) / rect.width) * extentUs;
  };
  const bandItemAt = (items: readonly BandItem[], e: React.MouseEvent<HTMLElement>): string | null => {
    const tUs = bandTimeAt(e);
    if (tUs === null) return null;
    const width = e.currentTarget.getBoundingClientRect().width;
    return hitBand(items, tUs, (uiPixels(MINI.pointSlop) / width) * extentUs);
  };
  // A press on the change band names a block, and in it the range under the
  // press, which the panel shows; the block's hover text says each range in it.
  const blockOf = (key: string): ChangeBlock | undefined => blocks.find((b) => b.key === key);
  const blockLabel = (key: string): string =>
    (blockOf(key)?.marks ?? []).map((m) => (changeLabel ? changeLabel(m) : t(`changes.class_${m.cls}`))).join("\n");
  // A double press jumps to the item's start on this strip — the first press
  // already focused it — and only moves the moment, as the strip's seek does.
  // `focusOf`: the item a band item focuses at that moment, when not itself.
  const bandHandlers = (
    kind: ReviewTarget["kind"],
    itemAt: (e: React.MouseEvent<HTMLElement>) => string | null,
    label: (id: string) => string,
    items: readonly BandItem[],
    focusOf: (id: string, tUs: number) => string | null = (id) => id,
  ) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || onFocus === undefined) return;
      const at = itemAt(e);
      const tUs = bandTimeAt(e);
      const id = at === null || tUs === null ? null : focusOf(at, tUs);
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
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
      const id = itemAt(e);
      const item = id === null ? undefined : items.find((x) => x.id === id);
      if (item === undefined) return;
      e.stopPropagation();
      onSeek(Math.min(durationUs, item.startUs));
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
        className={`mini-timeline-strip-real${focusBand ? ` mini-focus-${focusBand}` : ""}`}
        onPointerDown={onPointerDown}
      >
        {durationUs > 0 && focusWashes.map((w, i) => {
          const point = w.endUs <= w.startUs;
          return (
            <span
              key={`wash-${i}`}
              data-testid="mini-focus-wash"
              data-kind={w.kind}
              data-point={point || undefined}
              aria-hidden="true"
              className="review-focus-wash mini-focus-wash"
              style={{
                left: `${(w.startUs / extentUs) * 100}%`,
                ...(point ? {} : { width: `${((w.endUs - w.startUs) / extentUs) * 100}%` }),
              }}
            />
          );
        })}
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
        {durationUs > 0 && blocks.map((b) => {
          const left = (b.startUs / extentUs) * 100;
          const span = ((b.endUs - b.startUs) / extentUs) * 100;
          return (
            <div
              key={b.key}
              data-testid="mini-change"
              data-change-class={b.cls}
              data-cut={b.cut || undefined}
              data-user={b.user || undefined}
              data-count={b.marks.length}
              className={`mini-change mini-change-${b.cls}${b.cut ? " mini-change-cut" : ""}${b.user ? " mini-change-user" : ""}${changeMark(b)}`}
              // A cut point at the film's start hangs from its edge, not half off it.
              style={b.cut ? { left: `${left}%`, ...(b.startUs <= 0 ? { marginLeft: 0 } : {}) } : { left: `${left}%`, width: `${Math.max(0, span)}%` }}
            />
          );
        })}
        {durationUs > 0 && onFocus !== undefined && changeItems.length > 0 && (
          <div
            data-testid="mini-change-band"
            className="mini-band-hit mini-band-hit-changes"
            {...bandHandlers("range", (e) => bandItemAt(changeItems, e), blockLabel, changeItems, (key, tUs) => {
              const b = blockOf(key);
              const m = b === undefined ? null : blockRangeAt(b, tUs);
              return m === null ? null : rangeKey(m.range);
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
            }, tackItems)}
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
