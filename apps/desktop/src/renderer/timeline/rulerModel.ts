import {
  approxFrameDurUs,
  formatTimecode,
  frameCount,
  frameIndexCeil,
  frameIndexFloor,
  timeUsAtFrame,
} from "../frames";
import { formatRulerLabel } from "./geometry";
import { UI_METRICS } from "../settings/uiMetrics";
import type { TackKind } from "../../shared/agent-activity";

/// View model for the two rows that measure TIME rather than content — the
/// ruler's ticks and the marker lane's glyphs — for one (rate, zoom, viewport)
/// triple. Pure and DOM/React-free, so the long-timeline behaviour (24 h at
/// 60 fps) is asserted by unit tests instead of an e2e measurement.
///
/// The two rows live in one module because they share the VIEWPORT WINDOW: same
/// row pixels, same quantised scroll offset, same overscan. Stated twice they
/// would drift, and a mark that appeared at a different scroll offset than the
/// ticks around it is exactly what that drift looks like.
///
/// Owns: the two tick regimes, the major-tick stride, tick labels, marker
/// geometry and its degrade threshold, and the window that bounds both sets.
/// Does not own: how `scrollLeftPx` gets here (the components subscribe to
/// `state/timelineScrollStore`), the frame grid itself (`renderer/frames.ts`),
/// nor marker hover text — that needs a locale, so it composes in `MarkerLane`.
/// See ADR 0037 (the frame grid) and ADR 0056 (markers).
///
/// Frame-mode tick times come from the composition frame grid, so the ruler and
/// the edited content are the same grid.

// Major-tick candidates: classic 1/2/5 decade ladder extended into sub-second
// territory for high-zoom cases. Anything above 600 s falls off the top of the
// ladder and clamps to 600.
const NICE_STEPS_SEC = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600,
] as const;
const NICE_STEPS_FRAMES = [1, 2, 5, 10, 30] as const;
const SUBDIVISIONS = 5;
const FRAME_MODE_THRESHOLD_PX = 12;
const US_PER_SEC = 1_000_000;

/// Scroll distance the viewport may travel before the ruler recomputes its
/// window. The tick set is a function of the QUANTIZED scroll offset, so a
/// wheel gesture commits the ruler at most once per block instead of once per
/// event — the cheapest way to keep scroll out of React state above a leaf.
export const RULER_SCROLL_QUANTUM_PX = 200;

/// Extra px painted each side of the viewport. Expressed in pixels, not frames,
/// so it is zoom-invariant.
///
/// INVARIANT: `RULER_OVERSCAN_PX >= RULER_SCROLL_QUANTUM_PX`. The window is
/// built from a scroll offset that can lag the true one by up to a quantum, so
/// the overscan is what still covers the viewport's trailing edge; shrink it
/// below the quantum and ticks visibly stop short of the right edge mid-scroll.
export const RULER_OVERSCAN_PX = 400;

/// The row-pixel interval the ruler paints: the viewport plus an overscan each
/// side, clamped at the row head.
///
/// Ticks and markers MUST agree on this. They are windowed by separate
/// functions, and a marker computed against a wider or narrower interval than
/// the ticks would pop in and out of existence at a different scroll offset than
/// the ticks around it — so the interval is defined once, here, and both call
/// it.
function paintedWindowPx(
  scrollLeftPx: number,
  viewportWidthPx: number,
  overscanPx: number,
): { x0: number; x1: number } {
  const x0 = Math.max(0, scrollLeftPx - overscanPx);
  return {
    x0,
    x1: Math.max(
      x0,
      scrollLeftPx + Math.max(0, viewportWidthPx) + overscanPx,
    ),
  };
}

export type RulerMode = "second" | "frame";

/// One painted tick.
export interface RulerTick {
  /// Frame index in frame mode, minor-step index in second mode. Also the
  /// React key.
  frame: number;
  /// Left offset (px) at the current zoom, in row coordinates (x = 0 is time 0).
  xPx: number;
  /// The tick's time. In frame mode this is the canonical grid µs of frame
  /// `frame`, i.e. the same integer the actor's snap writes for a clip edge on
  /// that frame — that identity is what keeps a tick under the edit it marks an
  /// hour into the timeline.
  tUs: number;
  isMajor: boolean;
  /// Major ticks only: SMPTE `HH:MM:SS:FF` in frame mode, `mm:ss[.cs]` in
  /// second mode.
  label?: string;
}

export interface RulerModel {
  mode: RulerMode;
  /// The ticks inside the viewport window and nothing else — the length scales
  /// with viewport width and zoom, never with composition length.
  ticks: RulerTick[];
  /// Major spacing in seconds — second mode only (0 in frame mode).
  majorSec: number;
  /// Major spacing in frames — frame mode only (0 in second mode).
  strideFrames: number;
}

/// Inputs to `computeRulerModel`. `totalSec` is the row's right bound and is
/// independent of the viewport window the other fields describe.
export interface RulerModelInput {
  fpsNum: number;
  fpsDen: number;
  pxPerSec: number;
  /// Painted row extent in seconds (`computeTimelineExtent().totalSec`).
  totalSec: number;
  /// Row-local px offset of the visible lane area's left edge. The sticky
  /// track-header column covers the first `headerColumnPx()` of the scroll
  /// viewport, which makes the scroll root's `scrollLeft` exactly this offset —
  /// the same identity `registerScrollToTime` centres a time with.
  scrollLeftPx: number;
  viewportWidthPx: number;
  overscanPx?: number;
  /// UI text density changes label spacing, never the time-to-pixel mapping.
  uiScale?: number;
}

const EMPTY: RulerModel = {
  mode: "second",
  ticks: [],
  majorSec: 0,
  strideFrames: 0,
};

/// Tick layout for one (zoom, extent, rate, viewport).
export function computeRulerModel(input: RulerModelInput): RulerModel {
  const { fpsNum, fpsDen, pxPerSec, totalSec, scrollLeftPx, viewportWidthPx } =
    input;
  const overscanPx = input.overscanPx ?? RULER_OVERSCAN_PX;
  // Zoom is the px↔time conversion for every tick below; a non-positive one has
  // no layout to compute.
  if (!(pxPerSec > 0)) return EMPTY;

  // The window, in row pixels then in time. Both regimes turn these two times
  // into an index range and walk only that — nothing iterates the project.
  const { x0, x1 } = paintedWindowPx(scrollLeftPx, viewportWidthPx, overscanPx);
  const startUs = (x0 / pxPerSec) * US_PER_SEC;
  const endUs = (x1 / pxPerSec) * US_PER_SEC;

  // px-per-frame is a DISPLAY DENSITY: it picks the regime and the major
  // stride, and never becomes a tick's time. That is the only use
  // `approxFrameDurUs` is licensed for — it is a rounded nominal width and
  // `i * approxFrameDurUs` walks off the grid (see its doc comment). Tick
  // times below come from `timeUsAtFrame`.
  const approxDurUs = approxFrameDurUs(fpsNum, fpsDen);
  const pxPerFrame = (approxDurUs / US_PER_SEC) * pxPerSec;
  // Degenerate fps has no grid to paint, so it stays on the second ladder
  // rather than collapsing every frame tick onto time 0.
  const frameMode =
    fpsNum > 0 && fpsDen > 0 && pxPerFrame >= FRAME_MODE_THRESHOLD_PX;

  if (frameMode) {
    // Pick the smallest stride in NICE_STEPS_FRAMES whose major-tick spacing
    // clears the target px (the descending walk has no break, so the last
    // assignment wins). Falls back to 1 when none of them do — very low zoom
    // for a high-fps comp, rare.
    // Annotated `number` (not the `as const` literal `1`) so the loop can
    // assign any element of NICE_STEPS_FRAMES below.
    let stride: number = NICE_STEPS_FRAMES[0]!;
    for (let i = NICE_STEPS_FRAMES.length - 1; i >= 0; i--) {
      if (NICE_STEPS_FRAMES[i]! * pxPerFrame >= UI_METRICS.timeline.rulerMajorSpacingFrameMode * (input.uiScale ?? 1)) {
        stride = NICE_STEPS_FRAMES[i]!;
      }
    }
    // Minor ticks at every frame; majors at every `stride` frames. The row's
    // last index comes from the same grid as the times: `frameCount` is how
    // many frames fall strictly inside the row, so its value is the index of
    // the first frame at or past the end — the deliberate trailing tick.
    const totalUs = Math.ceil(Math.max(0, totalSec) * US_PER_SEC);
    const lastFrame = frameCount(0, totalUs, fpsNum, fpsDen);
    // Window edges in frame-index space. `floor`/`ceil` (not `round`) so the
    // first tick sits at or left of the window and the last at or right of it —
    // the set always covers the window it was asked for.
    const first = Math.min(
      lastFrame,
      Math.max(0, frameIndexFloor(startUs, fpsNum, fpsDen)),
    );
    const last = Math.min(
      lastFrame,
      Math.max(first, frameIndexCeil(endUs, fpsNum, fpsDen)),
    );
    const ticks: RulerTick[] = [];
    for (let f = first; f <= last; f++) {
      const tUs = timeUsAtFrame(f, fpsNum, fpsDen);
      const isMajor = f % stride === 0;
      ticks.push({
        frame: f,
        xPx: (tUs / US_PER_SEC) * pxPerSec,
        tUs,
        isMajor,
        ...(isMajor ? { label: formatTimecode(tUs, fpsNum, fpsDen) } : {}),
      });
    }
    return { mode: "frame", ticks, majorSec: 0, strideFrames: stride };
  }

  const targetSec = UI_METRICS.timeline.rulerMajorSpacing * (input.uiScale ?? 1) / pxPerSec;
  let major = NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1] ?? 1;
  for (const s of NICE_STEPS_SEC) {
    if (s >= targetSec) {
      major = s;
      break;
    }
  }
  const minorUs = Math.round((major * US_PER_SEC) / SUBDIVISIONS);
  // Allow a half-step over `totalSec` so the trailing major lands on a clean
  // number if the timeline ends mid-interval — visually it gets clipped by the
  // canvas width, but the major label stays on its grid until the very end.
  const limitUs = Math.max(0, totalSec) * US_PER_SEC + minorUs * 0.5;
  const lastIdx = Math.floor(limitUs / minorUs);
  const first = Math.min(lastIdx, Math.max(0, Math.floor(startUs / minorUs)));
  const last = Math.min(lastIdx, Math.max(first, Math.ceil(endUs / minorUs)));
  const ticks: RulerTick[] = [];
  for (let i = first; i <= last; i++) {
    const tUs = i * minorUs;
    const isMajor = i % SUBDIVISIONS === 0;
    ticks.push({
      frame: i,
      xPx: (tUs / US_PER_SEC) * pxPerSec,
      tUs,
      isMajor,
      ...(isMajor
        ? { label: formatRulerLabel(tUs / US_PER_SEC, major) }
        : {}),
    });
  }
  return { mode: "second", ticks, majorSec: major, strideFrames: 0 };
}

// ===== Markers =============================================================
//
// The marker lane's glyphs. Same window as the ticks, same px↔time identity,
// and — like the ticks — decided here rather than in the component, so the
// degrade threshold and the windowing are asserted without a DOM.
//
// Marker times need no snapping on the way in: ADR 0037 quantises them
// structurally (`validate` rejects an off-grid marker, an fps change re-snaps
// them), so `t_us` is already a frame anchor and maps straight to pixels.

/// Painted width below which a region marker is drawn with the POINT shape
/// instead of a capsule, so a two-frame region does not vanish at fit zoom.
///
/// The trade is deliberate and this constant owns the reasoning: the shape lies
/// about point-vs-region at that zoom, the tooltip does not (`endTUs` survives
/// the degrade), and zooming in restores the honest shape. Do not "fix" it with
/// a minimum capsule width instead — that makes a short region LOOK longer than
/// it is, which is the worse lie when the shape is being used to judge a cut.
export const MARKER_MIN_REGION_PX = 3;

/// The fields of a marker this model reads. Structurally satisfied by the wire
/// `MarkerSummary`, and named here so the lane's geometry does not depend on
/// the IPC surface.
export interface LaneMarkerSource {
  id: string;
  t_us: number;
  /// Region end (exclusive), or `null` for a point marker.
  end_t_us: number | null;
  label: string;
  /// `#rrggbb` — the marker's authored colour.
  color_hint: string;
  /// The layer this marker follows, or `null` when it is FREE. The lane draws
  /// the two states differently — solid against hollow — so the distinction has
  /// to survive into the view.
  anchor_layer: string | null;
  /// Anchored at source its layer no longer shows. Retained in state, never
  /// painted: it has no position on this timeline to paint AT.
  hibernating: boolean;
}

/// One painted marker.
export interface LaneMarker {
  /// Also the React key.
  id: string;
  /// Left offset (px) at the current zoom, in row coordinates (x = 0 is time
  /// 0) — the same coordinates the ticks use. Always the marker's START,
  /// degraded regions included.
  xPx: number;
  /// Painted width (px); 0 for the point shape.
  widthPx: number;
  shape: "point" | "region";
  /// The marker's own `color_hint`, verbatim. Marker colour is authored
  /// content (an agent's taxonomy), not chrome, so it is not re-themed here.
  color: string;
  label: string;
  tUs: number;
  /// Region end, or `null` for a point marker. Set independently of `shape`:
  /// a degraded region keeps its end (see `MARKER_MIN_REGION_PX`).
  endTUs: number | null;
  /// True when the marker follows a layer. Solid glyph; a free one is hollow.
  anchored: boolean;
  /// Px available to the label before the next mark's x, or `null` when nothing
  /// follows this one in the window. A label that ran under its neighbour's
  /// glyph would read as that neighbour's name.
  labelRoomPx: number | null;
}

export interface LaneMarkerInput {
  markers: readonly LaneMarkerSource[];
  pxPerSec: number;
  /// Row-local px offset of the visible lane area's left edge — the same
  /// (quantised) offset `computeRulerModel` windows the ticks with.
  scrollLeftPx: number;
  viewportWidthPx: number;
  overscanPx?: number;
}

/// Marker layout for one (markers, zoom, viewport) triple.
///
/// Windowed, hibernating markers dropped, and nothing else: every marker the
/// window can show is emitted, with no clustering and no same-pixel-column
/// dedupe, so dense zoom-outs look like a picket fence by design. Merged marks
/// would have to drop or merge their labels, and the label is what the lane
/// exists to show.
///
/// Hibernation is filtered HERE rather than at the JSX because such a marker's
/// `t_us` names a moment its layer no longer shows: there is no position on this
/// timeline for it, not merely a position that has to be hidden.
export function computeLaneMarkers(input: LaneMarkerInput): LaneMarker[] {
  const { markers, pxPerSec, scrollLeftPx, viewportWidthPx } = input;
  const overscanPx = input.overscanPx ?? RULER_OVERSCAN_PX;
  if (!(pxPerSec > 0)) return [];

  const { x0, x1 } = paintedWindowPx(scrollLeftPx, viewportWidthPx, overscanPx);

  const out: LaneMarker[] = [];
  for (const m of markers) {
    if (m.hibernating) continue;
    const xPx = (m.t_us / US_PER_SEC) * pxPerSec;
    // A non-advancing end is not a range: it has nothing to span and nothing to
    // report, so it is a point all the way down rather than a `start – start`
    // tooltip.
    const endTUs =
      m.end_t_us !== null && m.end_t_us > m.t_us ? m.end_t_us : null;
    const endXPx = endTUs === null ? xPx : (endTUs / US_PER_SEC) * pxPerSec;
    // Interval overlap, not point containment — a region wider than the window
    // has neither edge inside it and must still paint.
    if (endXPx < x0 || xPx > x1) continue;
    const widthPx = endXPx - xPx;
    const isBar = widthPx >= MARKER_MIN_REGION_PX;
    out.push({
      id: m.id,
      xPx,
      widthPx: isBar ? widthPx : 0,
      shape: isBar ? "region" : "point",
      color: m.color_hint,
      label: m.label,
      tUs: m.t_us,
      endTUs,
      anchored: m.anchor_layer !== null,
      // Filled in below — the neighbour it is measured against is only known
      // once the set is ordered.
      labelRoomPx: null,
    });
  }
  // Ascending time, so the later of two overlapping marks paints over the
  // earlier one; id breaks a tie, so a same-time pair has one stable order
  // rather than whichever the project happened to store first.
  out.sort((a, b) => a.tUs - b.tUs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Measured against the NEXT mark's x, not against a fixed budget: what a label
  // may occupy is whatever its neighbour has not claimed. The last mark in the
  // window is unbounded (null) — the row runs on past it.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next !== undefined) out[i]!.labelRoomPx = Math.max(0, next.xPx - out[i]!.xPx);
  }
  return out;
}

// ===== Review lane chips (ADR 0115) =========================================
//
// Tacks paint as chips in a lane of their own, one row high, never stacked: a
// range drawn at 20 % over another 20 % range reads as a third colour, and a
// third colour reads as a third kind of thing. Tacks whose chips would touch
// are drawn as ONE group chip with a count instead — the place is on the
// timeline, which tack is which is the list's (the group's menu, the Tacks
// tab), as comment pins cluster on a zoomed-out canvas. Zooming in parts a
// group whose tacks only met on screen.

/// Clear space kept after a chip before the next one may start, in time-axis
/// px — two chips edge to edge read as one.
export const TACK_CHIP_GAP_PX = 2;

/// Which kind a group chip wears: the one asking most of the user.
const KIND_WEIGHT: Record<TackKind, number> = { issue: 2, question: 1, note: 0 };

/// The fields of a placed tack this model reads (a `TackView` that is visible).
export interface LaneTackSource {
  id: string;
  kind: TackKind;
  t_us: number | null;
  end_t_us: number | null;
  label: string;
}

/// One placed tack, in the same row coordinates as `LaneMarker`.
export interface LaneTack {
  id: string;
  kind: TackKind;
  xPx: number;
  /// The tack's own PAINTED width — the range's, or `minChipPx` when the range
  /// is narrower (a point tack has none) — so a click target never shrinks to
  /// a hairline.
  widthPx: number;
  label: string;
  tUs: number;
  endTUs: number | null;
}

/// One chip on the lane: a single tack, or the tacks whose chips would touch.
export interface LaneTackGroup {
  /// Start order, id on a tie. One member is a plain chip.
  members: LaneTack[];
  /// The single member's kind, or the group's most pressing (`KIND_WEIGHT`).
  kind: TackKind;
  xPx: number;
  /// Painted width: the members' union, and for a group at least
  /// `minGroupPx`, room for its kind icon and count.
  widthPx: number;
}

/// Sweep a composition's tacks into the lane's chips, in start order.
///
/// Over EVERY placed tack, not the viewport's: what joins a group must be a
/// fact about the tack set and the zoom, or scrolling would merge and part
/// chips as neighbours entered and left the window. Culling is
/// `windowLaneTacks`'s job, after this.
///
/// Groups by VISUAL extent — a point is as wide as its chip, a group as wide
/// as its count needs — so two chips are disjoint on screen, which is the
/// whole guarantee. Start order, id on a tie, so one tack set has exactly one
/// layout whatever order the snapshot listed it in.
export function groupLaneTacks(input: {
  tacks: readonly LaneTackSource[];
  pxPerSec: number;
  /// Least painted chip width, in px — what the kind icon needs.
  minChipPx: number;
  /// Least painted group width, in px — the icon plus its count.
  minGroupPx: number;
  gapPx?: number;
}): LaneTackGroup[] {
  const { tacks, pxPerSec, minChipPx, minGroupPx } = input;
  const gapPx = input.gapPx ?? TACK_CHIP_GAP_PX;
  if (!(pxPerSec > 0)) return [];
  const placed: LaneTack[] = [];
  for (const t of tacks) {
    if (t.t_us === null) continue;
    const xPx = (t.t_us / US_PER_SEC) * pxPerSec;
    const endTUs = t.end_t_us !== null && t.end_t_us > t.t_us ? t.end_t_us : null;
    const rangePx = endTUs === null ? 0 : ((endTUs - t.t_us) / US_PER_SEC) * pxPerSec;
    placed.push({
      id: t.id,
      kind: t.kind,
      xPx,
      widthPx: Math.max(rangePx, minChipPx),
      label: t.label,
      tUs: t.t_us,
      endTUs,
    });
  }
  placed.sort((a, b) => a.tUs - b.tUs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups: LaneTackGroup[] = [];
  for (const tack of placed) {
    const last = groups.at(-1);
    if (last !== undefined && tack.xPx < last.xPx + last.widthPx + gapPx) {
      last.members.push(tack);
      if (KIND_WEIGHT[tack.kind] > KIND_WEIGHT[last.kind]) last.kind = tack.kind;
      // A group's floor widens it, which can reach the next tack: that tack
      // joins too, so no two chips ever touch.
      last.widthPx = Math.max(last.widthPx, tack.xPx + tack.widthPx - last.xPx, minGroupPx);
      continue;
    }
    groups.push({ members: [tack], kind: tack.kind, xPx: tack.xPx, widthPx: tack.widthPx });
  }
  return groups;
}

/// The chips the lane paints at one scroll offset, windowed by the very
/// interval the ticks and markers use — a chip that popped in at a different
/// offset than the tick under it would read as a different place. Painted
/// extents, interval overlap: a chip wider than the window still paints.
export function windowLaneTacks(
  groups: readonly LaneTackGroup[],
  view: { scrollLeftPx: number; viewportWidthPx: number; overscanPx?: number },
): LaneTackGroup[] {
  const { x0, x1 } = paintedWindowPx(
    view.scrollLeftPx,
    view.viewportWidthPx,
    view.overscanPx ?? RULER_OVERSCAN_PX,
  );
  return groups.filter((g) => g.xPx + g.widthPx >= x0 && g.xPx <= x1);
}
