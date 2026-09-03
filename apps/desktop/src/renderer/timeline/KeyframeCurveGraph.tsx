// On-lane value-curve renderer + in-place tangent-handle editor for one
// keyframed property of one layer. Curve, handles and the dashed extrapolated
// tails live in an SVG overlay (absolute, ruler-px coordinates); keyframe dots
// and the extrapolation marks are HTML spans on top so the dots keep the
// `.kf-sublane-diamond` contract the e2e suite asserts.
// Two segment classes: spline (Linear/Spline — draggable handles on Spline) and
// procedural (Elastic/Bounce — read-only sampled curve, --keyframe tint +
// badge, params edited in the EasingMenu popover). A segment's shape is the
// LEFT key's class + leaving tangent and the RIGHT key's arriving tangent; a
// handle belongs to ONE key's side, so a drag writes that side (`setTangent`)
// and a right-click on it sets that key's continuity.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, Continuity, Keyframe } from "../ipc";
import {
  EXTRAP_GLYPH_GAP_PX,
  extrapolateClass,
  extrapolateGlyph,
  extrapolateLabelKey,
  interpGlyphClass,
  isProceduralSegment,
} from "../keyframe/curve";
import { useNumberTrackPreview } from "../keyframe/easingPreviewStore";
import { setTangent } from "../keyframe/edits";
import {
  computeValueRange, extrapolationSampleCount, handleDragToCoeff, sampleExtrapolation,
  samplesToPolyline, segmentHandles, segmentPolyline, timeToXPx, valueToY,
  type CurveGeom, type Seg, type TimeValue,
} from "../keyframe/curveGraph";
import { ContinuityMenu } from "./ContinuityMenu";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

export type TangentSide = "in" | "out";

const NO_TAILS: { before: TimeValue[]; after: TimeValue[] } = { before: [], after: [] };

export function KeyframeCurveGraph({
  track,
  layerId,
  paramKey,
  layerTStartUs,
  clipDurationUs,
  pxPerSec,
  height,
  editable,
  isSelected,
  onSelectSeek,
  onRetime,
  onSetTangent,
  onSetContinuity,
  onOpenMenu,
}: {
  track: KeyframedTrack;
  /// The address a gesture previews this track under (`easingPreviewStore`).
  layerId: string;
  paramKey: string;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
  editable: boolean;
  /// Is this curve's key `kfId` selected? A predicate rather than an id
  /// because the selection is a set; asking per key keeps the render path O(1).
  isSelected: (kfId: string) => boolean;
  /// click a dot (no drag): select it + seek the transport to its time.
  onSelectSeek: (kfId: string) => void;
  /// drag a dot horizontally: retime to a new layer-local µs (caller commits).
  onRetime: (kfId: string, newTUsLocal: number) => void;
  /// drag a handle: key `kfId`'s `side` becomes this Free point (the caller
  /// commits through `setTangent`, once per gesture).
  onSetTangent: (kfId: string, side: TangentSide, xy: { x: number; y: number }) => void;
  /// right-click a handle, pick a row: key `kfId`'s continuity (the caller
  /// commits through `setContinuity`).
  onSetContinuity: (kfId: string, continuity: Continuity) => void;
  /// right-click a dot or the curve: open the preset/Smooth menu.
  onOpenMenu: (clientX: number, clientY: number, kfId: string) => void;
}) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => () => teardownRef.current?.(), []);

  const keys = track.value;

  // A gesture's preview of this track — a menu row armed over the selection,
  // an Elastic slider mid-drag, a batch retime in flight — read by address.
  // Read-only: the gesture owns the store's set/clear lifecycle.
  const menuPreview = useNumberTrackPreview(layerId, paramKey);

  // In-flight tangent-handle drag: the whole track as `setTangent` returns it
  // (the dragged side Free, a Smooth key's other side rotated with it), held
  // locally so the curve previews live WITHOUT committing per pointermove. A
  // per-move commit would fire one async actor round-trip and one undo entry
  // per move (60+ for a single gesture). We commit once on pointerup; this
  // preview stands in until the committed track changes under it (the commit
  // landing, or anything else) — `baseKeys` is the committed array it was
  // built over, and IPC re-materializes that array on every change.
  const [drag, setDrag] = useState<{ baseKeys: readonly Keyframe<number>[]; track: KeyframedTrack } | null>(null);
  useEffect(() => {
    if (drag && keys !== drag.baseKeys) setDrag(null);
  }, [keys, drag]);

  const [continuityMenu, setContinuityMenu] = useState<{ x: number; y: number; kfId: string } | null>(null);

  // What is drawn: the local drag preview wins, then the gesture preview, then
  // the committed track. Keys, extrapolation and the value range all come
  // from the same track, so handles, dots and tails move together.
  const renderTrack: KeyframedTrack =
    drag?.track ?? (menuPreview !== null && menuPreview.mode === "Keyframed" ? menuPreview : track);
  const renderKeys = renderTrack.value;

  // The track outside its keys, where a non-Hold side extrapolates: sampled
  // through the engine from the layer's start to the first key and from the
  // last key to the layer's end. A single key never extrapolates.
  const tails = useMemo(() => {
    const first = renderKeys[0];
    const last = renderKeys[renderKeys.length - 1];
    if (!first || !last || renderKeys.length < 2) return NO_TAILS;
    const ex = renderTrack.extrapolate;
    if (ex.before === "Hold" && ex.after === "Hold") return NO_TAILS;
    const period = last.t_us - first.t_us;
    const segments = renderKeys.length - 1;
    const before = ex.before !== "Hold" && first.t_us > 0
      ? sampleExtrapolation(renderTrack, 0, first.t_us, first.value,
          extrapolationSampleCount(first.t_us, period, segments))
      : [];
    const after = ex.after !== "Hold" && last.t_us < clipDurationUs
      ? sampleExtrapolation(renderTrack, last.t_us, clipDurationUs, last.value,
          extrapolationSampleCount(clipDurationUs - last.t_us, period, segments))
      : [];
    return { before, after };
  }, [renderTrack, renderKeys, clipDurationUs]);

  const geom: CurveGeom = useMemo(() => {
    const tailValues = tails.before.concat(tails.after).map((s) => s.v);
    const { vmin, vmax } = computeValueRange(renderKeys, 0.1, 32, tailValues);
    return { pxPerSec, layerTStartUs, height, vmin, vmax };
  }, [renderKeys, tails, pxPerSec, layerTStartUs, height]);

  // Keep the latest geom reachable from drag closures created at pointerdown
  // (the timeline can zoom/rescale mid-drag → captured geom would go stale).
  const geomRef = useRef(geom);
  useLayoutEffect(() => {
    geomRef.current = geom;
  }, [geom]);

  // Segments: each is owned by its LEFT key (class + leaving tangent), and reads
  // the RIGHT key's arriving tangent.
  const segments = useMemo(() => {
    const out: { owner: string; seg: Seg; left: Keyframe<number>; right: Keyframe<number> }[] = [];
    for (let i = 0; i < renderKeys.length - 1; i++) {
      const a = renderKeys[i]!;
      const b = renderKeys[i + 1]!;
      out.push({
        owner: a.id,
        seg: { aTUs: a.t_us, aVal: a.value, bTUs: b.t_us, bVal: b.value },
        left: a,
        right: b,
      });
    }
    return out;
  }, [renderKeys]);

  function svgPoint(e: PointerEvent | React.PointerEvent): { x: number; y: number } {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /// Drag the `side` handle of the segment `owner` leaves: `out` is the owner's
  /// own leaving side, `in` its right neighbour's arriving side.
  function dragHandle(owner: string, side: TangentSide, seg: Seg, e: React.PointerEvent) {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    // Start from what's on screen (a preview if a prior commit is still in
    // flight, else the committed shape), so the math is single-valued from the
    // grab. Handles only exist on Spline segments (segmentHandles), so anything
    // else here means the segment changed under the pointer — drop the drag.
    const i = renderKeys.findIndex((k) => k.id === owner);
    const left = renderKeys[i];
    const right = renderKeys[i + 1];
    if (!left || !right || left.segment.kind !== "Spline") return;
    const kfId = side === "out" ? left.id : right.id;
    const current: [number, number, number, number] = [left.out.x, left.out.y, right.in.x, right.in.y];
    const base = renderTrack;
    const baseKeys = keys;
    let nextXY: { x: number; y: number } | null = null;
    const move = (me: PointerEvent) => {
      const p = svgPoint(me);
      const c = handleDragToCoeff(side === "out" ? "p1" : "p2", p.x, p.y, seg, geomRef.current, current);
      nextXY = side === "out" ? { x: c[0], y: c[1] } : { x: c[2], y: c[3] };
      const next = setTangent(base, kfId, side, nextXY);
      if (next.mode === "Keyframed") setDrag({ baseKeys, track: next });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
      if (nextXY) onSetTangent(kfId, side, nextXY);
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragDot(kfId: string, startTUs: number, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectSeek(kfId);
    const startClientX = e.clientX;
    let nextTUs: number | null = null;
    const move = (me: PointerEvent) => {
      const dxUs = ((me.clientX - startClientX) / geomRef.current.pxPerSec) * 1_000_000;
      nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
      if (nextTUs != null && nextTUs !== startTUs) onRetime(kfId, nextTUs);
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const first = renderKeys[0];
  const last = renderKeys[renderKeys.length - 1];

  return (
    <>
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        data-testid="kf-curve-graph"
      >
        {(["before", "after"] as const).map((side) => {
          const pts = tails[side];
          if (pts.length < 2) return null;
          return (
            <polyline
              key={side}
              points={samplesToPolyline(pts, geom).map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="var(--ring, #9a9aff)"
              strokeWidth={editable ? 2 : 1}
              className="kf-curve-extrap"
              data-testid="kf-curve-extrap"
              data-side={side}
            />
          );
        })}
        {segments.map(({ owner, seg, left, right }) => {
          const pts = segmentPolyline(seg, left, right, geom).map((p) => `${p.x},${p.y}`).join(" ");
          const handles = editable ? segmentHandles(seg, left, right, geom) : null;
          // Procedural (Elastic/Bounce) segments are the read-only parameter-
          // curve class: no handles (segmentHandles is already null), and the
          // --keyframe domain tint sets them apart from spline segments.
          const procedural = isProceduralSegment(left.segment);
          return (
            <g key={owner}>
              <polyline
                points={pts}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                className="pointer-events-auto cursor-context-menu"
                data-testid="kf-segment-hit"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenMenu(e.clientX, e.clientY, owner);
                }}
              />
              <polyline
                points={pts}
                fill="none"
                stroke={procedural ? "var(--keyframe, #facc15)" : "var(--ring, #9a9aff)"}
                strokeWidth={editable ? 2 : 1}
                opacity={editable ? 1 : 0.5}
              />
              {handles && (["out", "in"] as const).map((side) => {
                const at = side === "out" ? handles.out : handles.in;
                const key = side === "out" ? left : right;
                const anchor = side === "out"
                  ? { x: timeToXPx(seg.aTUs, geom), y: valueToY(seg.aVal, geom) }
                  : { x: timeToXPx(seg.bTUs, geom), y: valueToY(seg.bVal, geom) };
                const auto = at.mode === "Auto";
                return (
                  <g key={side}>
                    <line
                      x1={anchor.x} y1={anchor.y} x2={at.x} y2={at.y}
                      className={
                        `kf-handle-stem kf-handle-stem-${key.continuity === "Smooth" ? "smooth" : "broken"}` +
                        (auto ? " kf-handle-stem-auto" : "")
                      }
                    />
                    <circle
                      cx={at.x} cy={at.y} r={5}
                      className={`pointer-events-auto cursor-grab kf-handle${auto ? " kf-handle-auto" : ""}`}
                      data-testid="kf-handle"
                      data-kf-id={key.id}
                      data-side={side}
                      data-mode={at.mode}
                      onPointerDown={(e) => dragHandle(owner, side, seg, e)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContinuityMenu({ x: e.clientX, y: e.clientY, kfId: key.id });
                      }}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {/* Parameter-curve badge on procedural segments — only in the expanded
          editor (the collapsed lanes keep just the tint) so 24px rows stay
          quiet. No convert-to-bezier affordance anywhere, by design. */}
      {editable && segments.map(({ owner, seg, left }) =>
        !isProceduralSegment(left.segment) ? null : (
          <span
            key={`badge-${owner}`}
            className="kf-procedural-badge"
            data-testid="kf-procedural-badge"
            style={{ left: (timeToXPx(seg.aTUs, geom) + timeToXPx(seg.bTUs, geom)) / 2 }}
          >
            {t("keyframe.procedural_badge")}
          </span>
        ),
      )}
      {renderKeys.map((k) => {
        const glyph = interpGlyphClass(k.segment.kind);
        return (
          <span
            key={k.id}
            className={`kf-diamond kf-sublane-diamond${glyph ? ` ${glyph}` : ""}${isSelected(k.id) ? " is-selected" : ""}`}
            style={{ left: timeToXPx(k.t_us, geom), top: valueToY(k.value, geom) }}
            data-kf-id={k.id}
            onPointerDown={(e) => dragDot(k.id, k.t_us, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Right-click operates on the selection, so a diamond already in
              // it is left alone — the menu reaches every selected key, and
              // re-running the click path would seek away from what the user is
              // about to edit. The same rule the clip context menu applies.
              if (!isSelected(k.id)) onSelectSeek(k.id);
              onOpenMenu(e.clientX, e.clientY, k.id);
            }}
          />
        );
      })}
      {/* Extrapolation marks beside the end keys — the whole announcement of a
          non-Hold side; no ghost diamonds are drawn past the key range. */}
      {first && last && renderKeys.length > 1 && (["before", "after"] as const).map((side) => {
        const mode = renderTrack.extrapolate[side];
        if (mode === "Hold") return null;
        const k = side === "before" ? first : last;
        const dx = side === "before" ? -EXTRAP_GLYPH_GAP_PX : EXTRAP_GLYPH_GAP_PX;
        return (
          <span
            key={`extrap-${side}`}
            className={extrapolateClass(mode)}
            data-testid="kf-extrap"
            data-side={side}
            title={t(extrapolateLabelKey(mode))}
            style={{ left: timeToXPx(k.t_us, geom) + dx, top: valueToY(k.value, geom) }}
          >
            {extrapolateGlyph(mode)}
          </span>
        );
      })}
      {continuityMenu && (() => {
        const k = renderKeys.find((x) => x.id === continuityMenu.kfId);
        if (!k) return null;
        return (
          <ContinuityMenu
            x={continuityMenu.x}
            y={continuityMenu.y}
            continuity={k.continuity}
            onPick={(c) => onSetContinuity(continuityMenu.kfId, c)}
            onClose={() => setContinuityMenu(null)}
          />
        );
      })()}
    </>
  );
}
