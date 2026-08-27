// One outline around every member of a link, drawn in the canvas overlay layer
// beside the marquee — not per block — so the lanes between two members are
// not painted. Shown while the pointer rests on a member (`linkHoverStore.ts`)
// or the whole link is selected; never idle, because anything idle on the
// timeline reads as a lane the editor should manage; and never during a drag,
// where the ghosts are the feedback.

import { useLayoutEffect, useMemo, useState } from "react";
import type { LinkSummary, TrackSummary } from "../ipc";
import {
  linkHue,
  linkHullRect,
  type LinkHullRect,
  type MeasuredTrackRow,
} from "./geometry";
import { useHoveredLinkId } from "./linkHoverStore";
import { useLinkOverride } from "../state/linkOverrideStore";

interface HullBox extends LinkHullRect {
  linkId: string;
}

const sameBoxes = (a: readonly HullBox[], b: readonly HullBox[]): boolean =>
  a.length === b.length &&
  a.every((box, i) => {
    const other = b[i]!;
    return (
      box.linkId === other.linkId &&
      box.x === other.x &&
      box.width === other.width &&
      box.top === other.top &&
      box.bottom === other.bottom
    );
  });

export function LinkHull({
  links,
  tracks,
  selectedLayerIds,
  suppressed,
  measureRows,
  pxPerSec,
}: {
  links: readonly LinkSummary[];
  tracks: readonly TrackSummary[];
  selectedLayerIds: ReadonlySet<string>;
  /// A layer drag is live — the ghosts carry the feedback.
  suppressed: boolean;
  /// The rendered lanes' canvas-relative bands, measured on call — the
  /// marquee's own source (`Timeline.measureMarqueeRows`), so the hull and the
  /// box agree on where a lane is.
  measureRows: () => MeasuredTrackRow[];
  pxPerSec: number;
}) {
  const hoveredLinkId = useHoveredLinkId();
  // Under the link override the accent dims to 40 % (`LayerBlock` does the
  // same to its border) — the canvas itself says links are not in force.
  const accentAlpha = useLinkOverride() ? 0.4 : 1;

  const activeLinks = useMemo(() => {
    const out: LinkSummary[] = [];
    for (const link of links) {
      const hovered = link.id === hoveredLinkId;
      const wholeSelected =
        link.layer_ids.length > 0 &&
        link.layer_ids.every((id) => selectedLayerIds.has(id));
      if (hovered || wholeSelected) out.push(link);
    }
    return out;
  }, [links, hoveredLinkId, selectedLayerIds]);

  const membersByLinkId = useMemo(() => {
    const layerById = new Map<
      string,
      { tStartUs: number; tEndUs: number; trackId: string }
    >();
    for (const track of tracks) {
      for (const layer of track.layers) {
        layerById.set(layer.id, {
          tStartUs: layer.t_start_us,
          tEndUs: layer.t_end_us,
          trackId: track.id,
        });
      }
    }
    return new Map(
      activeLinks.map((link) => [
        link.id,
        link.layer_ids.flatMap((id) => {
          const m = layerById.get(id);
          return m ? [m] : [];
        }),
      ]),
    );
  }, [activeLinks, tracks]);

  // Measured after EVERY render rather than under a dependency list: a lane's
  // band moves on a height drag or a sub-lane expand, neither of which changes
  // any prop here, and a render is the only signal that layout may have. The
  // value guard keeps the re-measure from re-rendering when nothing moved.
  const [boxes, setBoxes] = useState<HullBox[]>([]);
  useLayoutEffect(() => {
    if (suppressed || activeLinks.length === 0) {
      setBoxes((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const rows = measureRows();
    const pxPerUs = pxPerSec / 1_000_000;
    const next: HullBox[] = [];
    for (const link of activeLinks) {
      const rect = linkHullRect(membersByLinkId.get(link.id) ?? [], rows, pxPerUs);
      if (rect) next.push({ linkId: link.id, ...rect });
    }
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
  });

  if (boxes.length === 0) return null;
  return (
    <>
      {boxes.map((box) => {
        const hue = linkHue(box.linkId);
        const edge = `hsl(${hue} 75% 60% / ${0.8 * accentAlpha})`;
        return (
          <div
            key={box.linkId}
            data-testid="link-hull"
            data-link-id={box.linkId}
            aria-hidden="true"
            className="pointer-events-none absolute z-[3]"
            style={{
              left: box.x,
              top: box.top,
              width: box.width,
              height: box.bottom - box.top,
              backgroundColor: `hsl(${hue} 75% 60% / ${0.06 * accentAlpha})`,
              borderTop: `1px solid ${edge}`,
              borderBottom: `1px solid ${edge}`,
              borderLeft: `1px dashed ${edge}`,
              borderRight: `1px dashed ${edge}`,
            }}
          />
        );
      })}
    </>
  );
}
