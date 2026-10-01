import { HEADER_COL_PX, trackIdAtClientY, type VisualTrack } from "./geometry";
import { SPAWN_TRACK_ID } from "./placement";

/** A visible drop surface. Scrolled-out rows still have DOM rects, so checking
 * row bands alone can send a drop on the ruler to a hidden track. The strip
 * owns its exact rectangle; only the track viewport owns inter-row bands. */
export function timelineDestination(
  surfaces: {
    viewport: HTMLElement | null;
    strip: HTMLElement | null;
    lanes: ReadonlyMap<string, HTMLElement>;
    orderedTracks: readonly VisualTrack[];
  },
  clientX: number,
  clientY: number,
): { trackId: string; rect: DOMRect } | null {
  const strip = surfaces.strip?.getBoundingClientRect();
  const viewport = surfaces.viewport?.getBoundingClientRect();
  if (!viewport || clientX < viewport.left + HEADER_COL_PX || clientX >= viewport.right) return null;
  if (strip && clientX >= strip.left && clientX < strip.right && clientY >= strip.top && clientY < strip.bottom) {
    return { trackId: SPAWN_TRACK_ID, rect: strip };
  }
  if (clientY < viewport.top || clientY >= viewport.bottom) return null;
  const rects = new Map<string, DOMRect>();
  const rows = [];
  for (const { track } of surfaces.orderedTracks) {
    const rect = surfaces.lanes.get(track.id)?.getBoundingClientRect();
    if (!rect) continue;
    rects.set(track.id, rect);
    rows.push({ trackId: track.id, top: rect.top, bottom: rect.bottom });
  }
  const trackId = trackIdAtClientY(rows, clientY);
  return trackId === null ? null : { trackId, rect: rects.get(trackId)! };
}
