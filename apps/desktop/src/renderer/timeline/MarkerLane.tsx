import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { tryMutate } from "../errors/tryMutate";
import { formatTimecode } from "../frames";
import { attachMarker, detachMarker, removeMarker } from "../ipc";
import { useMarkersVisible } from "../settings/appSettingsStore";
import { useCompositionMarkers } from "../state/projectStore";
import { useMarkerDrag } from "./hooks/useMarkerDrag";
import { MarkerContextMenu } from "./MarkerContextMenu";
import { openMarkerRenamePrompt } from "./markerRenamePrompt";
import { MARKER_LANE_HEIGHT_PX } from "./geometry";
import { useRulerScrollBlockPx } from "./TimelineRuler";
import { computeLaneMarkers, type LaneMarker } from "./rulerModel";

/// The project's markers, in a row of their own directly under the ruler.
///
/// A row in the ruler family: it measures TIME, like the ticks above it, where
/// the drop strip below it belongs to the track family. It shares the ruler's
/// row coordinates and its quantised scroll window, so a glyph and the tick
/// under it are the same x forever.
///
/// The lane's EXISTENCE is `markers_visible`. One switch owns the whole row:
/// off, the 20 px go back to the tracks and there is nothing here to read past.
/// The reflow that costs is what the switch is for, and every way to flip it —
/// `M`, the View menu, the Quick Actions strip — is a deliberate act.
///
/// Both halves of the row read that one flag: this lane and `MarkerLaneHeader`,
/// which Timeline renders into the sticky header column. A row that vanished
/// from one column and stayed in the other would slide every header below it out
/// of line with its lane, silently.
///
/// Not a scrub surface. The ruler is the sole one, and it stayed the sole one by
/// giving markers up entirely: two hit regions for one object is what a press
/// here would have to arbitrate, and there is nothing to arbitrate when the
/// glyphs live on exactly one row. That is what pays for the DRAG
/// (`hooks/useMarkerDrag.ts`) — a left-press on a glyph in the ruler would have
/// contested the scrub head-on; here it has one meaning and no rival.

// ===== The L =================================================================
//
// A point marker is an L: a hairline STEM whose left edge is the marker's frame,
// and a FOOT running right from its base, under the name. Two strokes of ink
// where a filled diamond was, which is what a lane full of an agent's marks
// needs — and the stem states the position outright instead of asking the eye to
// find a rotated square's centre.
//
// It also collapses a whole branch: a diamond had to be nudged right by its
// rotation overhang when it stood in for a too-narrow region, or it painted over
// frames the region does not cover. An L has nothing to nudge. Its left edge IS
// the start, for a true point and a degraded region alike.

/// Stroke width of both arms.
const L_STROKE_PX = 2;
/// Painted width of the whole glyph, stem included — so the foot runs
/// `L_WIDTH_PX - L_STROKE_PX` to the right of the frame.
const L_WIDTH_PX = 6;
/// Where the foot's underside sits, measured up from the lane's bottom border.
/// Every L in the row rests on this one line, so the feet read as a baseline and
/// the names sit on a shelf.
const L_FOOT_INSET_PX = 2;
/// Stem height, which is the whole anchored/free distinction: an anchored mark
/// runs nearly the row's full height — it is tied to material several lanes
/// below and reads as tied — while a free one is a short tick on the same foot.
/// Ink, not colour, carries the bit; the colour is the author's taxonomy and is
/// needed for something else.
const L_STEM_PX = { anchored: 15, free: 8 } as const;

/// Height of a region's capsule: enough to hold the 9 px name inside it.
const REGION_HEIGHT_PX = 13;

/// Two concentric hairlines around a region's capsule: dark inside, light
/// outside. A marker's colour is whatever its author chose and the lane sits on
/// the near-black `--card`: a near-black fill plus a dark ring is a smudge, not
/// a mark. The L does not get this — a drop-shadow hugging two strokes reads as
/// a halo, and the stem is already a hard edge against the row.
const OUTLINE_SHADOW =
  "0 0 0 0.5px rgba(0,0,0,0.7), 0 0 0 1.25px rgba(255,255,255,0.4)";

/// Gap between the foot's end and the name that runs on from it.
const LABEL_GAP_PX = 3;

/// Row-local x where a point marker's name starts: clear of the foot, which is
/// the glyph's full painted width out from the frame. One rule for a true point
/// and for a degraded region, because the L sits the same way in both.
function labelLeftPx(view: LaneMarker): number {
  return view.xPx + L_WIDTH_PX + LABEL_GAP_PX;
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

/// One marker: an L at its frame, or a capsule across its range.
///
/// Painted in the marker's OWN colour — timeline chrome is semantic by kind
/// except where the colour is the content, and a marker's colour is an authored
/// taxonomy (problem / approved / needs-VO).
///
/// ANCHORED carries more ink than free, in the form each shape can hold: the L
/// grows its stem, the capsule fills instead of ringing. No tether line to the
/// anchoring clip: the clip may be several lanes away, so the line would cross
/// the whole lane region to say one bit.
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
  dragging,
  onOpenMenu,
  onBeginDrag,
}: {
  view: LaneMarker;
  title: string;
  dragging: boolean;
  onOpenMenu: (xPx: number, yPx: number, markerId: string) => void;
  onBeginDrag: (e: React.PointerEvent) => void;
}) {
  const laneHeight = MARKER_LANE_HEIGHT_PX;
  const isRegion = view.shape === "region";
  const stemPx = L_STEM_PX[view.anchored ? "anchored" : "free"];
  const height = isRegion ? REGION_HEIGHT_PX : stemPx;
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
        className={`pointer-events-auto absolute ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        } ${isRegion ? "overflow-hidden rounded-[2px]" : ""}`}
        style={{
          // `left` is the marker's exact START in every shape — never its
          // range's midpoint, never widened, and never offset. The stem's left
          // edge and the capsule's left edge both land here.
          left: view.xPx,
          // A capsule is centred in the row; an L rests on the row's foot line,
          // so anchored and free hang from different heights off one baseline.
          top: isRegion
            ? (laneHeight - height) / 2
            : laneHeight - L_FOOT_INSET_PX - height,
          width: isRegion ? view.widthPx : L_WIDTH_PX,
          height,
          // The L is drawn as two BORDERS of an empty box — border-box sizing
          // (Tailwind's preflight) keeps `width`/`height` the painted extent, so
          // the numbers above stay the ones the geometry talks about. The empty
          // interior still hit-tests, which makes the drag target the whole
          // 6 px box rather than a 2 px hairline.
          ...(isRegion
            ? {
                background: view.anchored ? view.color : "transparent",
                boxShadow: view.anchored
                  ? OUTLINE_SHADOW
                  : `inset 0 0 0 1.5px ${view.color}, ${OUTLINE_SHADOW}`,
              }
            : {
                borderLeft: `${L_STROKE_PX}px solid ${view.color}`,
                borderBottom: `${L_STROKE_PX}px solid ${view.color}`,
              }),
        }}
      >
        {/* A region names itself INSIDE its own capsule, clipped by it. A short
            region loses its text and keeps its hover title — the same trade
            `MARKER_MIN_REGION_PX` already makes for the shape. */}
        {isRegion && label !== "" && (
          <span
            data-testid="timeline-marker-label"
            className="pointer-events-none absolute inset-y-0 left-1 whitespace-nowrap text-[9px] font-medium leading-[13px]"
            style={{ color: view.anchored ? readableInk(view.color) : undefined }}
          >
            {label}
          </span>
        )}
      </div>
      {/* A point has no body to write in, so its name runs on from the foot,
          stopping where the next mark begins — past that it would read as the
          neighbour's name. It carries the glyph's own two handlers: it is the
          bigger target of the pair, and a name that opened the menu but refused
          to drag would be a target for half the gestures. */}
      {!isRegion && label !== "" && (
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
            left: labelLeftPx(view),
            top: (laneHeight - 9) / 2,
            maxWidth:
              view.labelRoomPx === null
                ? undefined
                : Math.max(0, view.labelRoomPx - (labelLeftPx(view) - view.xPx)),
          }}
        >
          {label}
        </span>
      )}
    </>
  );
}

/// The lane's sticky-header cell: what the row is.
///
/// Not the drop strip's bare height-parity spacer — this one names the row —
/// but it answers the same invariant: it must be exactly as tall as the body
/// lane, and it must exist in the same states. Both halves read
/// `markers_visible`; a cell that stayed after its lane vanished would slide
/// every header below it out of line with its lane.
export function MarkerLaneHeader() {
  const { t } = useTranslation();
  const markersVisible = useMarkersVisible();
  if (!markersVisible) return null;
  return (
    <div
      data-testid="timeline-marker-lane-header"
      className="flex items-center border-b border-border-soft bg-card px-1.5"
      style={{ height: MARKER_LANE_HEIGHT_PX }}
      // The header column is not a timeline surface: a press here must not reach
      // the root's marquee or seek paths (same guard `TrackHeader` carries).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
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
  // The visibility flag short-circuits the windowing here as well as the JSX
  // return below: with the marks off there is no reason to window them or
  // format a timecode at all — and a project an agent has sprayed hundreds of
  // markers across is exactly when someone reaches for the toggle.
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

  // The row itself, not merely its contents: off, there is no 20 px here and
  // the tracks move up. Returning null (rather than a zero-height lane) is what
  // keeps a vanished row from still being a hit target or a border. The header
  // cell does the same, from the same flag.
  if (!markersVisible) return null;

  return (
    <>
      {/* `overflow-hidden` is load-bearing, as it is on the ruler: a label is
          `whitespace-nowrap`, so the rightmost one would spill past widthPx and
          inflate the parent's scrollWidth, leaving a few px of phantom
          horizontal scroll at fit-zoom that no amount of zooming clears. */}
      <div
        data-testid="timeline-marker-lane"
        className="relative flex-none select-none overflow-hidden border-b border-border-soft bg-card"
        style={{ width: widthPx, height: MARKER_LANE_HEIGHT_PX }}
        // Neither a scrub surface nor a selection surface: the scroll body above
        // starts a marquee on pointerdown, and the ruler seeks. A press on this
        // row is neither, so it stops here rather than becoming one of them.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Rendered only when it has marks, which is what makes an empty visible
            lane hold nothing: an empty wrapper would leave "painted
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
