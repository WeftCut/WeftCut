// The gradient strip a colour sub-lane row draws under its diamonds: the track
// itself, painted. A colour has no single axis to plot, so there is no value
// curve and no tangent handles for this row — what the eye needs is the colour
// at every instant, which is exactly one column per pixel through the same OkLab
// leaf the preview and the export evaluate.
//
// Owns the strip alone. Diamonds, selection, the easing menu and the
// extrapolation marks stay with the row that mounts this.
import { useEffect, useRef } from "react";
import type { AnimTrack, Rgba } from "../ipc";
import { isNumberTrack, useTrackPreview, type PreviewTrack } from "../keyframe/easingPreviewStore";
import { resolveAnimatedColor } from "../render/animated";
import { useDprVersion } from "./hooks/useDprVersion";
import { useSegmentVisibility } from "./hooks/useSegmentVisibility";

/// Max CSS width of one render tile canvas — the same fixed-size-segment
/// pattern as TimelineWaveform's RENDER_TILE_PX (see that file for why).
const RENDER_TILE_PX = 2048;

type KeyframedRgba = Extract<AnimTrack<Rgba>, { mode: "Keyframed" }>;

/// One canvas segment's placement on the strip, in CSS px from the strip's own
/// left edge, plus the zoom that maps it back to time.
export interface StripGeom {
  segmentStartPx: number;
  segmentWidthPx: number;
  pxPerSec: number;
  /// Device pixels per CSS pixel — one sample per DEVICE column, so the strip
  /// is as smooth as the display allows rather than as smooth as CSS px.
  dpr: number;
}

/// Layer-local time at the centre of one device-pixel column. Centre, not edge:
/// a column shows the colour of the instant it covers, so sampling its left
/// edge would shift the whole strip half a pixel early.
export function stripColumnTimeUs(column: number, g: StripGeom): number {
  return ((g.segmentStartPx + (column + 0.5) / g.dpr) / g.pxPerSec) * 1_000_000;
}

/// How many device columns a segment paints.
export function stripColumnCount(g: StripGeom): number {
  return Math.max(1, Math.round(g.segmentWidthPx * g.dpr));
}

/// The colours one segment paints, left to right. Pure — no canvas — so the
/// sampling is testable where a 2d context is not available.
export function sampleStripColors(
  track: AnimTrack<Rgba>,
  fallback: Rgba,
  g: StripGeom,
): Rgba[] {
  const n = stripColumnCount(g);
  const out: Rgba[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = resolveAnimatedColor(track, stripColumnTimeUs(i, g), fallback);
  }
  return out;
}

/// A column's fill. Alpha rides through as a CSS alpha rather than being
/// composited away, so a track keyed down to transparent reads as the lane
/// showing through instead of as a solid colour.
export function cssRgba(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
}

/// A colour strip draws colours, so a preview whose values are numbers cannot
/// be drawn on it and reads as no preview — the mirror of the rule the value
/// graph applies through `isNumberTrack`.
function rgbaPreviewOf(preview: PreviewTrack | null): KeyframedRgba | null {
  if (preview === null || preview.mode !== "Keyframed" || isNumberTrack(preview)) return null;
  return preview as KeyframedRgba;
}

export function ColorLane({
  track,
  layerId,
  paramKey,
  fallback,
  layerTStartUs,
  clipDurationUs,
  pxPerSec,
  height,
}: {
  track: KeyframedRgba;
  /// The address a gesture previews this track under (`easingPreviewStore`).
  layerId: string;
  paramKey: string;
  /// Shown before the first key of an empty stretch — the descriptor's.
  fallback: Rgba;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
}) {
  const preview = rgbaPreviewOf(useTrackPreview(layerId, paramKey));
  // What is drawn: an armed gesture's preview, else the committed track — the
  // same precedence the value graph applies, so a menu row previewed on a
  // numeric lane and on a colour lane arm together.
  const renderTrack = preview ?? track;

  const dprVersion = useDprVersion();
  const { isSegmentVisible, observeSegment, visibilityVersion } = useSegmentVisibility();

  const leftPx = (layerTStartUs / 1_000_000) * pxPerSec;
  const widthPx = (clipDurationUs / 1_000_000) * pxPerSec;
  const segments: number[] = [];
  for (let x = 0; x < widthPx; x += RENDER_TILE_PX) segments.push(x);

  return (
    <div
      // Under the diamonds and out of the way of the pointer: the row owns the
      // marquee, and a strip that swallowed pointerdown would kill it.
      className="pointer-events-none absolute inset-y-0 overflow-hidden"
      style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
      data-testid="kf-color-lane"
    >
      {segments.map((startPx) => (
        <StripSegment
          key={startPx}
          track={renderTrack}
          fallback={fallback}
          geomStartPx={startPx}
          geomWidthPx={Math.min(RENDER_TILE_PX, widthPx - startPx)}
          pxPerSec={pxPerSec}
          height={height}
          visible={isSegmentVisible(startPx)}
          observe={observeSegment}
          // Not read in the body — a bump is what re-runs the paint at the new
          // backing resolution / after a segment scrolls into view.
          dprVersion={dprVersion}
          visibilityVersion={visibilityVersion}
        />
      ))}
    </div>
  );
}

function StripSegment({
  track,
  fallback,
  geomStartPx,
  geomWidthPx,
  pxPerSec,
  height,
  visible,
  observe,
  dprVersion,
  visibilityVersion,
}: {
  track: AnimTrack<Rgba>;
  fallback: Rgba;
  geomStartPx: number;
  geomWidthPx: number;
  pxPerSec: number;
  height: number;
  visible: boolean;
  observe: (el: HTMLCanvasElement, startPx: number) => () => void;
  dprVersion: number;
  visibilityVersion: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, geomStartPx);
  }, [observe, geomStartPx]);

  useEffect(() => {
    // Offscreen segments skip entirely: assigning canvas.width reallocates the
    // backing store, and doing that for every segment of a long clip on every
    // zoom frame is what a strip this wide cannot afford.
    if (!visible) return;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const g: StripGeom = { segmentStartPx: geomStartPx, segmentWidthPx: geomWidthPx, pxPerSec, dpr };
    const cols = stripColumnCount(g);
    canvas.width = cols;
    canvas.height = Math.max(1, Math.round(height * dpr));
    // No `setTransform`: columns are drawn in DEVICE pixels, which is the whole
    // point of sampling one per device column — a CSS-px transform would
    // resample the strip back down to CSS resolution.
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const colors = sampleStripColors(track, fallback, g);
    for (let i = 0; i < cols; i++) {
      ctx.fillStyle = cssRgba(colors[i]!);
      ctx.fillRect(i, 0, 1, canvas.height);
    }
  }, [track, fallback, geomStartPx, geomWidthPx, pxPerSec, height, visible, dprVersion, visibilityVersion]);

  return (
    <canvas
      ref={ref}
      data-testid="kf-color-strip"
      className="absolute inset-y-0"
      style={{
        left: `${geomStartPx}px`,
        width: `${geomWidthPx}px`,
        height: `${height}px`,
        contentVisibility: "auto",
        containIntrinsicSize: `${geomWidthPx}px ${height}px`,
      }}
    />
  );
}
