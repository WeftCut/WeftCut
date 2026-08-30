import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { tryMutate } from "../errors/tryMutate";
import { formatTimecode } from "../frames";
import { attachMarker, detachMarker, removeMarker } from "../ipc";
import {
  toggleMarkerLaneCollapsed,
  useMarkerLaneCollapsed,
  useMarkersVisible,
} from "../settings/appSettingsStore";
import { useCompositionMarkers } from "../state/projectStore";
import { useMarkerDrag } from "./hooks/useMarkerDrag";
import { MarkerContextMenu } from "./MarkerContextMenu";
import { openMarkerRenamePrompt } from "./markerRenamePrompt";
import {
  MARKER_LANE_COLLAPSED_HEIGHT_PX,
  MARKER_LANE_HEIGHT_PX,
} from "./geometry";
import { useRulerScrollBlockPx } from "./TimelineRuler";
import { computeLaneMarkers, type LaneMarker } from "./rulerModel";

/// The project's markers, in a row of their own directly under the ruler.
///
/// A permanent row in the ruler family: it measures TIME, like the ticks above
/// it, where the drop strip below it belongs to the track family. It shares the
/// ruler's row coordinates and its quantised scroll window, so a glyph and the
/// tick under it are the same x forever.
///
/// The lane EXISTS unconditionally. `markers_visible` governs what it paints and
/// nothing else — binding the row to that flag would reflow the timeline under
/// the pointer, because `M` force-enables it (see `MARKER_LANE_HEIGHT_PX`).
/// Collapse is the one thing that changes its height, and a user asked for it.
///
/// Not a scrub surface. The ruler is the sole one, and it stayed the sole one by
/// giving markers up entirely: two hit regions for one object is what a press
/// here would have to arbitrate, and there is nothing to arbitrate when the
/// glyphs live on exactly one row. That is what pays for the DRAG
/// (`hooks/useMarkerDrag.ts`) — a left-press on a glyph in the ruler would have
/// contested the scrub head-on; here it has one meaning and no rival.

/// Lane height for the current collapse state. One function so the header cell
/// and the body lane cannot disagree — a row painted at two heights out of two
/// columns slides every header below it out of line with its lane.
export function markerLaneHeightPx(collapsed: boolean): number {
  return collapsed ? MARKER_LANE_COLLAPSED_HEIGHT_PX : MARKER_LANE_HEIGHT_PX;
}

/// Box side of the point glyph, which is a SQUARE rotated 45° — so what it
/// paints is the diagonal, `size·√2`, and it is the DIAGONAL that has to fit the
/// lane's height. Sizing against the side instead is how a diamond ends up
/// taller than the row it sits in.
const POINT_SIZE_PX = { expanded: 7, collapsed: 6 } as const;
/// Height of a region's capsule. Expanded it has to hold 9 px text; collapsed it
/// is a bar and nothing more.
const REGION_HEIGHT_PX = { expanded: 13, collapsed: 6 } as const;

/// How far a 45°-rotated square paints beyond its own box on each side: the
/// diagonal is `size·√2`, so the overhang is half the difference. Rotation is
/// what makes the diamond a diamond, so this is not removable — it is
/// compensated for instead (`glyphTranslate`).
const rotationOverhangPx = (sizePx: number): number =>
  (sizePx * (Math.SQRT2 - 1)) / 2;

/// Two concentric hairlines: dark inside, light outside. A marker's colour is
/// whatever its author chose and the lane sits on the near-black `--card`: a
/// near-black marker plus a dark ring is a smudge, not a mark. The dark ring is
/// what separates a BRIGHT colour; the light ring outside it separates a dark
/// one, so no authored colour can vanish into the background.
const OUTLINE_SHADOW =
  "0 0 0 0.5px rgba(0,0,0,0.7), 0 0 0 1.25px rgba(255,255,255,0.4)";

/// Gap between a point's painted tip and the label that runs right from it.
const LABEL_GAP_PX = 3;

/// Where a glyph sits relative to the `left` its view item carries.
///
/// A true point marker is CENTRED on its frame: the frame is a line, and the
/// diamond straddles it the way a playhead would. A degraded region is not — it
/// begins at that x and nothing of it exists before, so it is nudged right by
/// the rotation overhang, putting its painted left edge exactly on the region's
/// start. Getting this backwards paints ~3.5 px of mark over frames the region
/// does not cover, in the one case the shape has already stopped reporting the
/// region's true extent.
function glyphTranslate(view: LaneMarker, sizePx: number): string | undefined {
  if (view.shape === "region") return undefined;
  return view.endTUs === null ? "-50%" : `${rotationOverhangPx(sizePx)}px`;
}

/// Row-local x where a point marker's label starts: clear of the diamond's
/// painted tip, which is half a DIAGONAL out from a centred point and a whole
/// one out from a degraded region (see `glyphTranslate`).
function labelLeftPx(view: LaneMarker, sizePx: number): number {
  const diagonal = sizePx * Math.SQRT2;
  const clearance = view.endTUs === null ? diagonal / 2 : diagonal;
  return view.xPx + clearance + LABEL_GAP_PX;
}

/// Ink that stays legible on an authored fill. A marker's colour is a taxonomy
/// somebody chose, so it spans the whole gamut — one fixed text colour is
/// unreadable on half of it. Rec. 601 luma, which is what every "black or white
/// text" rule of thumb is built on; anything unparsable is treated as dark,
/// since the lane's own surface is.
function readableInk(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null) return "#ffffff";
  const n = Number.parseInt(hex[1]!, 16);
  const luma =
    0.299 * ((n >> 16) & 0xff) +
    0.587 * ((n >> 8) & 0xff) +
    0.114 * (n & 0xff);
  return luma > 150 ? "#101014" : "#ffffff";
}

/// Hover text for one mark: `label · timecode`, or `label · start – end` for
/// anything carrying an `endTUs` — a degraded region included, which is the
/// half of `MARKER_MIN_REGION_PX`'s trade this function has to hold up.
function markerTitle(
  view: LaneMarker,
  fpsNum: number,
  fpsDen: number,
  t: TFunction,
): string {
  const label = view.label.trim() || t("kinds.marker");
  const start = formatTimecode(view.tUs, fpsNum, fpsDen);
  if (view.endTUs === null) {
    return t("timeline.marker_tooltip_point", { label, timecode: start });
  }
  return t("timeline.marker_tooltip_region", {
    label,
    start,
    end: formatTimecode(view.endTUs, fpsNum, fpsDen),
  });
}

/// One marker: a diamond at its frame, or a capsule across its range.
///
/// Painted in the marker's OWN colour — timeline chrome is semantic by kind
/// except where the colour is the content, and a marker's colour is an authored
/// taxonomy (problem / approved / needs-VO).
///
/// SOLID is anchored, HOLLOW is free. No tether line to the anchoring clip: the
/// clip may be several lanes away, so the line would cross the whole lane region
/// to say one bit.
///
/// Two pointer handlers, one per button, which is what "separate by input
/// channel" buys once the glyphs are off the ruler: the LEFT press drags the
/// mark, the RIGHT one opens its menu, and neither has to arbitrate against a
/// scrub. `onContextMenu`'s preventDefault beats the prod-mode global
/// context-menu suppressor (main.tsx); stopPropagation keeps any future
/// lane-level menu from stacking.
function MarkerGlyph({
  view,
  title,
  collapsed,
  dragging,
  onOpenMenu,
  onBeginDrag,
}: {
  view: LaneMarker;
  title: string;
  collapsed: boolean;
  dragging: boolean;
  onOpenMenu: (xPx: number, yPx: number, markerId: string) => void;
  onBeginDrag: (e: React.PointerEvent) => void;
}) {
  const state = collapsed ? "collapsed" : "expanded";
  const laneHeight = markerLaneHeightPx(collapsed);
  const isRegion = view.shape === "region";
  const sizePx = POINT_SIZE_PX[state];
  const height = isRegion ? REGION_HEIGHT_PX[state] : sizePx;
  const label = view.label.trim();
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenMenu(e.clientX, e.clientY, view.id);
  };
  return (
    <>
      <div
        data-testid="timeline-marker"
        data-marker-id={view.id}
        data-shape={view.shape}
        data-anchored={view.anchored ? "true" : "false"}
        data-dragging={dragging ? "true" : undefined}
        title={title}
        onContextMenu={openMenu}
        onPointerDown={onBeginDrag}
        className={`pointer-events-auto absolute overflow-hidden ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        } ${isRegion ? "rounded-[2px]" : "rotate-45"}`}
        style={{
          // `left` is the marker's exact START in every shape — never its
          // range's midpoint, never widened. How the glyph sits around that x is
          // `glyphTranslate`'s call, so this stays the honest number.
          left: view.xPx,
          translate: glyphTranslate(view, sizePx),
          top: (laneHeight - height) / 2,
          width: isRegion ? view.widthPx : sizePx,
          height,
          background: view.anchored ? view.color : "transparent",
          boxShadow: view.anchored
            ? OUTLINE_SHADOW
            : `inset 0 0 0 1.5px ${view.color}, ${OUTLINE_SHADOW}`,
        }}
      >
        {/* A region names itself INSIDE its own capsule, clipped by it. A short
            region loses its text and keeps its hover title — the same trade
            `MARKER_MIN_REGION_PX` already makes for the shape. */}
        {isRegion && !collapsed && label !== "" && (
          <span
            data-testid="timeline-marker-label"
            className="pointer-events-none absolute inset-y-0 left-1 whitespace-nowrap text-[9px] font-medium leading-[13px]"
            style={{ color: view.anchored ? readableInk(view.color) : undefined }}
          >
            {label}
          </span>
        )}
      </div>
      {/* A point has no body to write in, so its label runs right from the
          diamond, stopping where the next mark begins — past that it would read
          as the neighbour's name. It carries the glyph's own two handlers: it is
          the bigger target of the pair, and a name that opened the menu but
          refused to drag would be a target for half the gestures. */}
      {!isRegion && !collapsed && label !== "" && (
        <span
          data-testid="timeline-marker-label"
          data-marker-id={view.id}
          title={title}
          onContextMenu={openMenu}
          onPointerDown={onBeginDrag}
          className={`pointer-events-auto absolute overflow-hidden whitespace-nowrap text-[9px] font-medium leading-none text-foreground/85 ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
          style={{
            left: labelLeftPx(view, sizePx),
            top: (laneHeight - 9) / 2,
            maxWidth:
              view.labelRoomPx === null
                ? undefined
                : Math.max(0, view.labelRoomPx - (labelLeftPx(view, sizePx) - view.xPx)),
          }}
        >
          {label}
        </span>
      )}
    </>
  );
}

/// The lane's sticky-header cell: what the row is, and the collapse toggle.
///
/// Not the drop strip's bare height-parity spacer — this one carries a control —
/// but it answers the same invariant: it must be exactly as tall as the body
/// lane in every state.
export function MarkerLaneHeader() {
  const { t } = useTranslation();
  const collapsed = useMarkerLaneCollapsed();
  const toggleLabel = t("timeline.marker_lane_toggle", {
    defaultValue: "Collapse marker lane",
  });
  return (
    <div
      data-testid="timeline-marker-lane-header"
      className="flex items-center gap-1 border-b border-border-soft bg-card px-1.5"
      style={{ height: markerLaneHeightPx(collapsed) }}
      // The header column is not a timeline surface: a press here must not reach
      // the root's marquee or seek paths (same guard `TrackHeader` carries).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        data-testid="timeline-marker-lane-twirl"
        className="inline-flex size-[14px] shrink-0 items-center justify-center text-muted-foreground/60 hover:text-foreground"
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        onClick={() => void toggleMarkerLaneCollapsed()}
      >
        {collapsed ? (
          <ChevronRight size={11} aria-hidden />
        ) : (
          <ChevronDown size={11} aria-hidden />
        )}
      </button>
      <span className="truncate text-[9px] uppercase tracking-wide text-muted-foreground/70">
        {t("timeline.marker_lane", { defaultValue: "Markers" })}
      </span>
    </div>
  );
}

export function MarkerLane({
  compositionId,
  pxPerSec,
  widthPx,
  viewportWidthPx,
  fpsNum,
  fpsDen,
}: {
  /// The composition this lane belongs to, from the Panel that renders it: its
  /// markers, and its own scroll offset.
  compositionId: string | null;
  pxPerSec: number;
  widthPx: number;
  /// Visible lane-area width (viewport minus the sticky header column) — with
  /// the scroll offset, the interval the painted glyph set has to cover.
  viewportWidthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const collapsed = useMarkerLaneCollapsed();
  const scrollLeftPx = useRulerScrollBlockPx(compositionId);
  // Both read here rather than threaded down from the timeline, for the same
  // reason the scroll store is: the lane is the only surface that paints markers
  // and the only one the flag governs, so neither belongs on the timeline's prop
  // surface. The array changes once per project mutation, not once per frame.
  const markers = useCompositionMarkers(compositionId);
  const markersVisible = useMarkersVisible();
  const { preview, beginMarkerDrag } = useMarkerDrag({ compositionId, pxPerSec });
  // A dragged mark paints where the pointer has it, not where the project still
  // has it. Substituted into the SOURCE list rather than into the computed view,
  // so the window, the paint order and each label's room are all re-derived from
  // the previewed time — a mark that slides past its neighbour has to take the
  // room with it.
  //
  // A region drags WHOLE: its end travels the same delta, which is exactly what
  // the commit's reconcile does to an anchored region's `end_t_us` and what the
  // free one's patch carries explicitly. Edge resize is a gesture of its own and
  // is not this one.
  const previewedMarkers = useMemo(() => {
    if (preview === null) return markers;
    return markers.map((m) =>
      m.id !== preview.markerId
        ? m
        : {
            ...m,
            t_us: preview.tUs,
            end_t_us:
              m.end_t_us === null ? null : m.end_t_us + (preview.tUs - m.t_us),
          },
    );
  }, [markers, preview]);
  // The marker context menu, owned HERE with the glyphs it acts on. The popup
  // portals to the body, so an open menu adds no children to the lane.
  const [markerMenu, setMarkerMenu] = useState<{
    x: number;
    y: number;
    markerId: string;
  } | null>(null);
  // Close it when anything scrolls under it — the popup is anchored to fixed
  // cursor coordinates, so it would float detached over moving content.
  // Outside-click and Escape closing belong to Base UI. Same effect every
  // context-menu call site carries (Timeline, TrackHeader, TimelineRuler).
  useEffect(() => {
    if (!markerMenu) return;
    const onScroll = () => setMarkerMenu(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [markerMenu]);
  // Hover text is composed HERE rather than at each glyph: every title is a pair
  // of `formatTimecode` calls through the wasm frame grid, so composing per
  // glyph would re-run all of them on every render instead of once per window.
  //
  // The visibility flag short-circuits HERE rather than at the JSX: with the
  // marks off there is no reason to window them or format a timecode at all —
  // and a project an agent has sprayed hundreds of markers across is exactly
  // when someone reaches for the toggle.
  const markerViews = useMemo(
    () =>
      markersVisible
        ? computeLaneMarkers({
            markers: previewedMarkers,
            pxPerSec,
            scrollLeftPx,
            viewportWidthPx,
          }).map((view) => ({
            view,
            title: markerTitle(view, fpsNum, fpsDen, t),
          }))
        : [],
    [
      markersVisible,
      previewedMarkers,
      pxPerSec,
      scrollLeftPx,
      viewportWidthPx,
      fpsNum,
      fpsDen,
      t,
    ],
  );

  return (
    <>
      {/* `overflow-hidden` is load-bearing, as it is on the ruler: a label is
          `whitespace-nowrap`, so the rightmost one would spill past widthPx and
          inflate the parent's scrollWidth, leaving a few px of phantom
          horizontal scroll at fit-zoom that no amount of zooming clears. */}
      <div
        data-testid="timeline-marker-lane"
        data-collapsed={collapsed ? "true" : "false"}
        className="relative flex-none select-none overflow-hidden border-b border-border-soft bg-card"
        style={{ width: widthPx, height: markerLaneHeightPx(collapsed) }}
        // Neither a scrub surface nor a selection surface: the scroll body above
        // starts a marquee on pointerdown, and the ruler seeks. A press on this
        // row is neither, so it stops here rather than becoming one of them.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Rendered only when it has marks, which is what makes "hidden" mean
            GONE: with the toggle off or the project empty the lane holds
            nothing, rather than an empty layer that would leave "painted
            transparently" and "not painted" indistinguishable. `inset-0` so its
            children share the lane's row coordinates. */}
        {markerViews.length > 0 && (
          <div
            data-testid="timeline-marker-layer"
            className="pointer-events-none absolute inset-0"
          >
            {markerViews.map(({ view, title }) => (
              <MarkerGlyph
                key={view.id}
                view={view}
                title={title}
                collapsed={collapsed}
                dragging={preview?.markerId === view.id}
                onOpenMenu={(x, y, markerId) =>
                  setMarkerMenu({ x, y, markerId })
                }
                onBeginDrag={beginMarkerDrag(view.id)}
              />
            ))}
          </div>
        )}
      </div>
      {markerMenu !== null && (
        <MarkerContextMenu
          x={markerMenu.x}
          y={markerMenu.y}
          compositionId={compositionId}
          markerId={markerMenu.markerId}
          onClose={() => setMarkerMenu(null)}
          onRename={() => {
            setMarkerMenu(null);
            openMarkerRenamePrompt(markerMenu.markerId);
          }}
          onDelete={() => {
            setMarkerMenu(null);
            // No confirm dialog: deletion is RECORDED, so it is one undo away.
            void tryMutate(
              () => removeMarker(markerMenu.markerId),
              "remove_marker",
            );
          }}
          onAttach={(layerId) => {
            setMarkerMenu(null);
            void tryMutate(
              () => attachMarker(markerMenu.markerId, layerId),
              "attach_marker",
            );
          }}
          onDetach={() => {
            setMarkerMenu(null);
            void tryMutate(
              () => detachMarker(markerMenu.markerId),
              "detach_marker",
            );
          }}
        />
      )}
    </>
  );
}
