// On-lane value-curve renderer + in-place tangent-handle editor for one
// keyframed property of one layer. Curve + handles live in an SVG overlay
// (absolute, ruler-px coordinates); keyframe dots are HTML spans on top so
// they keep the `.kf-sublane-diamond` contract the e2e suite asserts.
// Two segment classes: spline (Linear/Spline — draggable handles on Spline) and
// procedural (Elastic/Bounce — read-only sampled curve, --keyframe tint +
// badge, params edited in the EasingMenu popover). A segment's shape is the
// LEFT key's class + leaving tangent and the RIGHT key's arriving tangent.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import { applySegmentEasing } from "../../shared/easing";
import { interpGlyphClass, isProceduralSegment } from "../keyframe/curve";
import { useEasingPreviewStore } from "../keyframe/easingPreviewStore";
import {
  computeValueRange, segmentPolyline, segmentHandles, handleDragToCoeff,
  valueToY, timeToXPx, type CurveGeom, type Seg,
} from "../keyframe/curveGraph";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

export function KeyframeCurveGraph({
  track,
  layerTStartUs,
  clipDurationUs,
  pxPerSec,
  height,
  editable,
  isSelected,
  onSelectSeek,
  onRetime,
  onSetSegmentCoeffs,
  onOpenMenu,
}: {
  track: KeyframedTrack;
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
  /// drag a handle: the segment leaving `kfId` becomes this cubic (both sides
  /// Free; the caller commits through `setSegmentCoeffs`).
  onSetSegmentCoeffs: (kfId: string, coeffs: [number, number, number, number]) => void;
  /// right-click a dot or the curve: open the preset/Smooth menu.
  onOpenMenu: (clientX: number, clientY: number, kfId: string) => void;
}) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => () => teardownRef.current?.(), []);

  const keys = track.value;

  // Live easing from the easing popover's Elastic sliders / gallery hover. Keyed
  // by kfId (UUIDs — at most one graph's track holds it), so a non-matching
  // preview is inert here. Read-only: the menu owns the store's set/clear
  // lifecycle. Applied to the segment LEAVING that key through the same bridge
  // a commit would take (`applySegmentEasing`).
  const menuPreview = useEasingPreviewStore((s) => s.preview);

  // In-flight tangent-handle drag: holds the dragged segment's cubic locally so
  // the curve previews live WITHOUT committing per pointermove. A per-move commit
  // would fire one async actor round-trip and one undo entry per move (60+ for a
  // single gesture). We commit once on pointerup; this preview survives until the
  // committed track catches up (see the clear effect below), so there's no
  // flicker back to the pre-drag curve while the async commit is in flight.
  const [preview, setPreview] = useState<{ owner: string; coeffs: [number, number, number, number] } | null>(null);

  // Keys as rendered: a previewed segment (handle drag, or the popover's
  // easing) shows its preview shape on BOTH of its keys; everything else is the
  // committed track. Drives geom + segments so the value-range and handle
  // positions track the drag live. The local drag preview is applied last so
  // it wins should both ever target one key.
  const renderKeys = useMemo(() => {
    if (!preview && !menuPreview) return keys;
    const out: Keyframe<number>[] = keys.slice();
    const applyLeaving = (kfId: string, e: Interpolation) => {
      const i = out.findIndex((k) => k.id === kfId);
      if (i < 0) return;
      const [l, r] = applySegmentEasing(out[i]!, out[i + 1], e);
      out[i] = l;
      if (r) out[i + 1] = r;
    };
    if (menuPreview) applyLeaving(menuPreview.kfId, menuPreview.interp);
    if (preview) {
      const [x1, y1, x2, y2] = preview.coeffs;
      applyLeaving(preview.owner, { kind: "Bezier", p1: [x1, y1], p2: [x2, y2] });
    }
    return out;
  }, [keys, preview, menuPreview]);

  // Drop the preview once the committed track reflects it (or the segment is
  // gone). Until then the preview stands in for the not-yet-arrived commit.
  useEffect(() => {
    if (!preview) return;
    const i = keys.findIndex((x) => x.id === preview.owner);
    const k = keys[i];
    const next = keys[i + 1];
    const [x1, y1, x2, y2] = preview.coeffs;
    const committed =
      k !== undefined && next !== undefined && k.segment.kind === "Spline" &&
      k.out.x === x1 && k.out.y === y1 && next.in.x === x2 && next.in.y === y2;
    if (!k || !next || committed) setPreview(null);
  }, [keys, preview]);

  const geom: CurveGeom = useMemo(() => {
    const { vmin, vmax } = computeValueRange(renderKeys);
    return { pxPerSec, layerTStartUs, height, vmin, vmax };
  }, [renderKeys, pxPerSec, layerTStartUs, height]);

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

  function dragHandle(owner: string, which: "p1" | "p2", seg: Seg, e: React.PointerEvent) {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    // Start from what's on screen (preview if a prior commit is still in flight,
    // else the committed shape), so the math is single-valued from the grab.
    // Handles only exist on Spline segments (segmentHandles), so anything else
    // here means the segment changed under the pointer — drop the drag.
    const i = renderKeys.findIndex((k) => k.id === owner);
    const left = renderKeys[i];
    const right = renderKeys[i + 1];
    if (!left || !right || left.segment.kind !== "Spline") return;
    const current: [number, number, number, number] = [left.out.x, left.out.y, right.in.x, right.in.y];
    let nextCoeffs: [number, number, number, number] | null = null;
    const move = (me: PointerEvent) => {
      const p = svgPoint(me);
      nextCoeffs = handleDragToCoeff(which, p.x, p.y, seg, geomRef.current, current);
      setPreview({ owner, coeffs: nextCoeffs });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
      if (nextCoeffs) onSetSegmentCoeffs(owner, nextCoeffs);
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

  return (
    <>
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        data-testid="kf-curve-graph"
      >
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
              {handles && (["p1", "p2"] as const).map((which) => {
                const at = which === "p1" ? handles.p1 : handles.p2;
                const anchor = which === "p1"
                  ? { x: timeToXPx(seg.aTUs, geom), y: valueToY(seg.aVal, geom) }
                  : { x: timeToXPx(seg.bTUs, geom), y: valueToY(seg.bVal, geom) };
                return (
                  <g key={which}>
                    <line x1={anchor.x} y1={anchor.y} x2={at.x} y2={at.y}
                      stroke="var(--ring, #6b6bff)" strokeWidth={1} opacity={0.7} />
                    <circle
                      cx={at.x} cy={at.y} r={5}
                      fill="var(--ring, #6b6bff)"
                      className="pointer-events-auto cursor-grab"
                      data-testid="kf-handle"
                      onPointerDown={(e) => dragHandle(owner, which, seg, e)}
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
      {keys.map((k) => {
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
    </>
  );
}
