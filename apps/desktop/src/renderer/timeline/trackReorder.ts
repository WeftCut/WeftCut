import type { TrackSummary } from "../ipc";

export type TrackMove = "up" | "down" | "top" | "bottom";

// A/B remain reference rows. Every other row, including audio, can be arranged.
export function canReorderTrack(track: TrackSummary): boolean {
  return track.role !== "a-roll" && track.role !== "b-roll" &&
    !track.locked && !track.layers.some((layer) => layer.locked);
}

/** Screen order is the reverse of the stored z order. A gap includes the
 * source row; remove it before converting the landing to a stored index. */
export function trackPositionAtGap(ids: readonly string[], id: string, gap: number): number | null {
  const from = ids.indexOf(id);
  if (from < 0 || gap < 0 || gap > ids.length || gap === from || gap === from + 1) return null;
  const to = gap > from ? gap - 1 : gap;
  return ids.length - 1 - to;
}

export function trackPositionForMove(ids: readonly string[], id: string, move: TrackMove): number | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = move === "top" ? 0 : move === "bottom" ? ids.length - 1 :
    from + (move === "up" ? -1 : 1);
  if (to < 0 || to >= ids.length || to === from) return null;
  return ids.length - 1 - to;
}

/** Vertical-only reveal: never reset the user's horizontal time window. */
export function revealTrackRow(viewport: HTMLElement, row: HTMLElement): void {
  const host = viewport.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  if (rect.top < host.top || rect.height > host.height) viewport.scrollTop += rect.top - host.top;
  else if (rect.bottom > host.bottom) viewport.scrollTop += rect.bottom - host.bottom;
}
