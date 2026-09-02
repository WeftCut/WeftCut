// The candidate score strip and the threshold line that crosses it — the
// control that makes the Shots Panel worth opening.
//
// x is source time across the clip's window, y is the detector's frame-change
// score, and one tick is one candidate the FLOOR scan emitted. The line is the
// threshold: ticks above it are the boundaries the reduce builds shots from,
// ticks below it are what it is throwing away. Reading the strip answers what a
// number cannot — how many candidates are still outside the line, and whether
// this source has any score separation at all.
//
// Boundary: this module draws and reports; it decides nothing. It never merges
// spans and never re-detects — the reduce does that in Rust — and it does not
// clamp the threshold to the scan floor, because `floor` lives in
// `shotsStore.ts` and so does that bound.

import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { formatTimecode } from "../frames";
import type { CutScore } from "../ipc";

/// The plot's user-space box, drawn with `preserveAspectRatio="none"` so it
/// stretches to whatever width the dock gives the Panel. x is deliberately
/// wide: at the narrowest dock width a long source still resolves to distinct
/// tick columns, and the strokes stay screen-width regardless through
/// `vector-effect="non-scaling-stroke"`.
const PLOT_W = 1000;
const PLOT_H = 100;

/// Arrow and Page steps for the line's handle. They are also what makes the
/// control exercisable without a pointer drag — jsdom has no pointer geometry,
/// so the keyboard path is the one a component test can drive.
const NUDGE = 0.01;
const PAGE = 0.1;

/// One thousandth of the score range. Every emitted value passes through this,
/// so a nudged threshold stays a short decimal instead of accumulating float
/// dust over a dozen presses — which is what a persisted value and an
/// `aria-valuenow` both have to read back cleanly.
function quantize(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/// SVG coordinates land in the DOM, so they are trimmed to the same thousandth
/// rather than printing a full float.
function coord(value: number): number {
  return Number(value.toFixed(3));
}

export interface ScoreStripProps {
  /// The floor scan's candidates, source-absolute and unfiltered.
  candidates: readonly CutScore[];
  srcInUs: number;
  srcOutUs: number;
  threshold: number;
  /// The scan floor — the lowest the line may sit, and the slider's minimum.
  floor: number;
  fpsNum: number;
  fpsDen: number;
  /// Live: per pointer move and per key press.
  onThresholdChange: (value: number) => void;
  /// The end of one gesture — pointer release or key release.
  onThresholdCommit: () => void;
}

export function ScoreStrip({
  candidates,
  srcInUs,
  srcOutUs,
  threshold,
  floor,
  fpsNum,
  fpsDen,
  onThresholdChange,
  onThresholdCommit,
}: ScoreStripProps) {
  const { t } = useTranslation();
  const plot = useRef<HTMLDivElement | null>(null);
  const handle = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const span = srcOutUs - srcInUs;
  // Strictly interior, matching `reduce`'s own contract: a candidate on a
  // window edge can never become a boundary, so drawing one would show a tick
  // the line has no power over.
  const visible =
    span <= 0
      ? []
      : candidates.filter((c) => c.t_us > srcInUs && c.t_us < srcOutUs);

  if (visible.length === 0) {
    // Nothing for a threshold to sort. A line dragged over an empty plot would
    // be a control that answers every position identically.
    return (
      <p className="shots-empty" data-testid="shots-no-candidates">
        {t("shots_panel.no_candidates")}
      </p>
    );
  }

  /// Pointer y → score. Clamped to the plot's own [0, 1] range and nothing
  /// narrower: the floor is the store's bound, not the geometry's.
  const scoreAtClientY = (clientY: number): number => {
    const box = plot.current?.getBoundingClientRect();
    if (box === undefined || box.height <= 0) return threshold;
    const fraction = (box.bottom - clientY) / box.height;
    return quantize(Math.min(1, Math.max(0, fraction)));
  };

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    // The prevented pointerdown never becomes the mousedown that would have
    // focused the handle, so focus it here: aiming with the pointer and then
    // fine-tuning with the arrows is one gesture, and without this the arrows
    // would walk the playhead instead.
    handle.current?.focus();
    dragging.current = true;
    // Absent in jsdom, and the drag still works there because no pointer ever
    // leaves the element.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onThresholdChange(scoreAtClientY(e.clientY));
  };

  const continueDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    onThresholdChange(scoreAtClientY(e.clientY));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onThresholdCommit();
  };

  const stepFor = (key: string): number | null => {
    switch (key) {
      case "ArrowUp":
        return threshold + NUDGE;
      case "ArrowDown":
        return threshold - NUDGE;
      case "PageUp":
        return threshold + PAGE;
      case "PageDown":
        return threshold - PAGE;
      case "Home":
        return floor;
      case "End":
        return 1;
      default:
        return null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = stepFor(e.key);
    if (next === null) return;
    // Arrow and Page keys scroll the Panel otherwise, which would slide the row
    // list out from under the line being aimed at.
    e.preventDefault();
    // And stop it here. ArrowUp/ArrowDown/Home/End are the app's bare-key seek
    // bindings (`seekPrevEdit` and friends), dispatched from a bubble-phase
    // window listener that never reads `defaultPrevented` and consults the
    // focused region only for SCOPED actions — and those four have no scope.
    // Without this, aiming the line would also walk the playhead across the
    // edit points.
    e.stopPropagation();
    onThresholdChange(quantize(next));
  };

  /// Release and not press: a held arrow key auto-repeats, and committing per
  /// repeat would turn one gesture into a burst of writes.
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (stepFor(e.key) === null) return;
    onThresholdCommit();
  };

  const xOf = (tUs: number): number => ((tUs - srcInUs) / span) * PLOT_W;
  const yOf = (score: number): number => PLOT_H - score * PLOT_H;

  return (
    <div className="shots-strip" data-testid="shots-score-strip">
      <div
        ref={plot}
        className="shots-strip-plot"
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg
          className="shots-strip-plot-svg"
          viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {visible.map((candidate) => (
            <line
              key={candidate.t_us}
              className="shots-tick"
              // Strict `>`, matching the reduce, which matches ffmpeg's `gt`.
              // A tick reports the LINE's verdict and only that: a candidate
              // above it can still be dropped by the minimum shot length, which
              // is exactly why the two controls do not look alike.
              data-accepted={candidate.score > threshold}
              data-src-us={candidate.t_us}
              x1={coord(xOf(candidate.t_us))}
              x2={coord(xOf(candidate.t_us))}
              y1={PLOT_H}
              y2={coord(yOf(candidate.score))}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {/* The line IS the handle: a slider whose meaning is its position, so
            there is no track to label and no abstract number to read
            backwards. */}
        <div
          ref={handle}
          className="shots-threshold"
          role="slider"
          tabIndex={0}
          style={{ top: `${coord((1 - threshold) * 100)}%` }}
          aria-label={t("shots_panel.threshold_line")}
          aria-orientation="vertical"
          aria-valuemin={floor}
          aria-valuemax={1}
          aria-valuenow={threshold}
          aria-valuetext={t("shots_panel.threshold_value", {
            value: threshold.toFixed(2),
          })}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
        />
      </div>
      <div className="shots-strip-axis">
        {/* Named by what the axis MEASURES. "Sensitivity" is the wire and
            persistence field and reaches no label — a higher value yields FEWER
            cuts, so the word reads backwards to everyone but the detector. */}
        <span>{t("shots_panel.axis_frame_change")}</span>
        <span className="shots-strip-range">
          {formatTimecode(srcInUs, fpsNum, fpsDen)}
          {" – "}
          {formatTimecode(srcOutUs, fpsNum, fpsDen)}
        </span>
      </div>
    </div>
  );
}
