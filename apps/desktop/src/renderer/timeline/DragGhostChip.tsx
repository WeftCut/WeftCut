// What a dragged clip looks like where it is GOING — one rendition, for every
// surface that draws that promise.
//
// Two of them do, and they cannot share a parent: the cross-Panel ghost lives in
// the destination's `timeline-canvas` and is positioned in canvas coordinates
// (`ForeignDragGhost.tsx`), while a raise's ghost lives inside the drop strip and
// is positioned against that row (`DropStrip.tsx`). What they CAN share is what a
// ghost is, and they must: the two draw the same gesture arriving at the same
// row, so a difference between them reads as two different things happening.
//
// The rendition is a chip mid-drag, deliberately — `LayerBlock`'s own dragging
// branch is `rounded`, `border-white/25` and that shadow. A ghost promising a
// chip should look like the chip it promises.
//
// What is NOT shared is the band, and that is the point of `dragGhostBand`: a
// lane and the drop strip really are different boxes, and the row decides, not
// the gesture that reached it.

import { useTranslation } from "react-i18next";

import { formatTimecode } from "../frames";
import type { LayerParamsView } from "../ipc";
import { layerSliceRect, MIN_TRACK_HEIGHT } from "./geometry";
import { timelineLayerTheme } from "./layerTheme";
import {
  placementRefuses,
  SPAWN_TRACK_ID,
  type PlacementValidity,
} from "./placement";

/// The colour hint `timelineLayerTheme` consults for a `Color` layer only. A
/// ghost is not a mirror of the clip — no filmstrip, no waveform, no link
/// chrome, because none of those answer a question the drop asks — so it carries
/// no fill to offer, and every kind reads as its type colour.
export const GHOST_NEUTRAL_SURFACE = "#22262b";

/// How opaque the fill is. On the FILL rather than on the element, which is the
/// whole point: `opacity` multiplies everything inside the box, so the 15 % it
/// takes off the surface it also takes off the border, the head cap, the refusal
/// outline and the label — every part of the ghost that is supposed to be a
/// crisp line over a dark lane. Fading only what is being faded leaves them all
/// at full strength. The `color-mix` convention is `app.css`'s.
const GHOST_FILL_PERCENT = 85;

/// The head marker's width. The head is THE number a drop sends — every other
/// edge on the ghost is derived from it (the tail is a duration away, a sibling
/// is a phase away) — and a chip bordered uniformly says none of that: it reads
/// as a box, and a box has two ends that look alike.
///
/// `border-box` sizing is what makes this exact rather than approximate: the cap
/// grows INWARD from the element's left edge, so its outer edge is still the
/// landing time itself and not two pixels after it.
export const GHOST_HEAD_CAP_PX = 2;

/// Near-white, and it does NOT follow a refusal. A refused ghost is already red
/// or amber on every other edge, so a cap that joined in would leave the head
/// indistinguishable exactly when the user most needs to read it — "where would
/// this land, and why is that wrong" are two questions, and the chrome answers
/// them in two places.
const GHOST_HEAD_CAP_COLOR = "rgb(255 255 255 / 0.92)";

/// A ghost shorter than this is a bar and nothing else: `text-[10px]` needs a box
/// this tall before a label is legible rather than clipped.
///
/// Derived, not chosen. It is the smallest band a LANE can produce, so the rule
/// it expresses is "a lane labels its ghost, the drop strip cannot" — with no
/// height in between for the two to disagree about, and no constant to drift out
/// of step with `MIN_TRACK_HEIGHT`.
const LABEL_MIN_HEIGHT_PX = layerSliceRect(MIN_TRACK_HEIGHT, "full").height;

/// The band a ghost occupies in a row, in that ROW's own coordinates — a caller
/// positioned elsewhere adds its own origin.
///
/// A lane gives the ghost the padded interior a real chip sits in. The drop strip
/// gives it the whole row: the strip is not a lane and has no interior to speak
/// of — 14 px less two 4 px pads is under `layerSliceRect`'s own floor, so asking
/// it for a chip band there returns a box that overflows the padding it was meant
/// to respect. Taking the row is also what the media-pool ghost already does on
/// that row, so this is one rule where there were two.
export function dragGhostBand(
  rowHeight: number,
  trackId: string,
): { top: number; height: number } {
  return trackId === SPAWN_TRACK_ID
    ? { top: 0, height: rowHeight }
    : layerSliceRect(rowHeight, "full");
}

export interface DragGhostChipProps {
  /// Distinguishes the two surfaces for locators, and nothing else — the ghost
  /// itself is the same on both.
  testId: string;
  layerId: string;
  /// The row it lands on, `SPAWN_TRACK_ID` included; published as a data
  /// attribute so a test can read the destination off the ghost.
  trackId: string;
  /// The clip's display name, resolved where the layer lives. Null when nobody
  /// could resolve one — a promise redrawn after the gesture ended — and unread
  /// at strip height either way.
  name: string | null;
  kind: LayerParamsView["kind"];
  tStartUs: number;
  tEndUs: number;
  validity: PlacementValidity;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  /// The band, from `dragGhostBand`, in the coordinate space of whatever this is
  /// mounted in.
  top: number;
  height: number;
}

export function DragGhostChip({
  testId,
  layerId,
  trackId,
  name,
  kind,
  tStartUs,
  tEndUs,
  validity,
  pxPerSec,
  fpsNum,
  fpsDen,
  top,
  height,
}: DragGhostChipProps): React.ReactNode {
  const { t } = useTranslation();
  const theme = timelineLayerTheme(kind, GHOST_NEUTRAL_SURFACE);
  // Not `!== "valid"`: over the drop strip the verdict is `"spawn"`, a
  // destination being created rather than a refusal (ADR 0042).
  const refused = placementRefuses(validity);
  const refusalLabel =
    validity === "collision"
      ? t("timeline.drop_collision", { defaultValue: "Overlap" })
      : validity === "locked"
        ? t("timeline.drop_locked", { defaultValue: "Locked" })
        : null;
  const labelled = height >= LABEL_MIN_HEIGHT_PX;
  const timecodes = `${formatTimecode(tStartUs, fpsNum, fpsDen)} → ${formatTimecode(tEndUs, fpsNum, fpsDen)}`;
  return (
    <div
      data-testid={testId}
      data-layer-id={layerId}
      data-track-id={trackId}
      data-validity={validity}
      data-start-us={tStartUs}
      data-end-us={tEndUs}
      aria-hidden="true"
      // Square at the head, rounded at the tail — the two ends of a ghost are
      // not the same kind of thing, and a corner radius is the cheapest way to
      // stop them looking alike. `rounded-r-[4px]` is what `rounded` would have
      // given both ends.
      className="pointer-events-none absolute z-[5] flex items-center gap-1 overflow-hidden rounded-l-[1px] rounded-r-[4px] border border-white/25 px-2 text-[10px] font-semibold text-white shadow-[0_4px_10px_rgba(0,0,0,0.45)]"
      style={{
        left: (tStartUs / 1_000_000) * pxPerSec,
        top,
        // The DESTINATION's zoom, always — recomputing the width is the
        // difference between showing a duration and lying about one, since the
        // source Panel's px/sec would draw the same clip a different length.
        width: Math.max(4, ((tEndUs - tStartUs) / 1_000_000) * pxPerSec),
        height,
        backgroundColor: `color-mix(in srgb, ${theme.surface} ${GHOST_FILL_PERCENT}%, transparent)`,
        // The red / amber every lane wears, so one vocabulary covers every
        // surface a drop can be refused on.
        //
        // LANDMINE: this shorthand sets all four sides, so it must stay ABOVE
        // the head cap's longhands. Below them, a refusal would silently repaint
        // the cap and take the head marker away at the one moment the user is
        // hunting for it.
        borderColor:
          validity === "collision"
            ? "rgb(252 165 165)"
            : validity === "locked"
              ? "rgb(252 211 77)"
              : undefined,
        borderLeftWidth: GHOST_HEAD_CAP_PX,
        borderLeftColor: GHOST_HEAD_CAP_COLOR,
        outline:
          validity === "collision"
            ? "2px solid rgb(248 113 113)"
            : validity === "locked"
              ? "2px solid rgb(251 191 36)"
              : undefined,
        outlineOffset: refused ? -2 : undefined,
      }}
      title={name === null ? timecodes : `${name}: ${timecodes}`}
    >
      {labelled && name !== null && (
        <span className="min-w-0 truncate">{name}</span>
      )}
      {labelled && refusalLabel !== null && (
        <span className="ml-auto shrink-0 rounded bg-black/35 px-1 py-0.5">
          {refusalLabel}
        </span>
      )}
    </div>
  );
}
