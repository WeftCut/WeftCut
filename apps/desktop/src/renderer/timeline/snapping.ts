import type { LinkSummary, TrackSummary } from "../ipc";
import { adjacentFrameBoundaryUs, snapFrameRound } from "../frames";

const US_PER_SEC = 1_000_000;

export type TimelineDragSnapKind = "move" | "trim-start" | "trim-end";

interface MoveSnapPlacement {
  anchor: { tStartUs: number; tEndUs: number };
}

export interface TimelineTimeSnapResult {
  timeUs: number;
  boundaryUs: number | null;
}

export interface TimelineDragSnapState {
  kind: TimelineDragSnapKind;
  layerId: string;
  originalTStart: number;
  originalTEnd: number;
  escapeLink: boolean;
  subjects?: readonly { layerId: string }[];
}

interface TimelineSnapOptions {
  visibleTracks: readonly TrackSummary[];
  links: readonly LinkSummary[];
  linkByLayerId: ReadonlyMap<string, string>;
  /// The playhead as a snap target, on the SAME clock as `visibleTracks`'
  /// layer boundaries — the Panel's own composition
  /// (`state/playheadProjection.ts`). Handing the root's raw playhead in would
  /// offer a target one Group-offset away from where the line is drawn.
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  pxPerSec: number;
  enabled: boolean;
  strengthPx: number;
}

interface TimelineSnapBoundaryOptions extends TimelineSnapOptions {
  layerId?: string;
  escapeLink?: boolean;
  isValidSnap?: (boundaryUs: number) => boolean;
}

function thresholdUs(strengthPx: number, pxPerSec: number): number {
  if (pxPerSec <= 0) return 0;
  return (Math.max(0, strengthPx) / pxPerSec) * US_PER_SEC;
}

function ignoredLayerIds(
  layerId: string | undefined,
  escapeLink: boolean,
  links: readonly LinkSummary[],
  linkByLayerId: ReadonlyMap<string, string>,
): Set<string> {
  const ignored = new Set<string>();
  if (!layerId) return ignored;
  ignored.add(layerId);
  if (!escapeLink) {
    const linkId = linkByLayerId.get(layerId);
    const link = linkId ? links.find((g) => g.id === linkId) : null;
    for (const memberId of link?.layer_ids ?? []) {
      ignored.add(memberId);
    }
  }
  return ignored;
}

function timelineBoundaries(
  opts: TimelineSnapOptions,
  ignored: ReadonlySet<string>,
): number[] {
  const boundaries: number[] = [];
  for (const track of opts.visibleTracks) {
    for (const layer of track.layers) {
      if (ignored.has(layer.id)) continue;
      boundaries.push(snapFrameRound(layer.t_start_us, opts.fpsNum, opts.fpsDen));
      boundaries.push(snapFrameRound(layer.t_end_us, opts.fpsNum, opts.fpsDen));
    }
  }
  boundaries.push(snapFrameRound(opts.currentTimeUs, opts.fpsNum, opts.fpsDen));
  return boundaries;
}

/// Where the dragged edge / clip-start actually lands, after the constraints the
/// kind imposes: a move never starts before zero, and a trim never crosses its
/// own opposite edge (one frame of clip always survives).
export function constrainedAnchorUs(
  state: TimelineDragSnapState,
  deltaUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  switch (state.kind) {
    case "move":
      return Math.max(0, state.originalTStart + deltaUs);
    case "trim-start":
      return Math.max(
        0,
        Math.min(
          state.originalTStart + deltaUs,
          adjacentFrameBoundaryUs(state.originalTEnd, -1, fpsNum, fpsDen),
        ),
      );
    case "trim-end":
      return Math.max(
        adjacentFrameBoundaryUs(state.originalTStart, 1, fpsNum, fpsDen),
        state.originalTEnd + deltaUs,
      );
  }
}

export function resolveTimelineDragSnap<Placement extends MoveSnapPlacement>(
  opts: TimelineSnapOptions & {
    state: TimelineDragSnapState;
    frameDeltaUs: number;
    preserveTime?: boolean;
    projectMove?: ((deltaUs: number) => Placement) | undefined;
  },
): { deltaUs: number; boundaryUs: number | null; placement: Placement | undefined } {
  const { state, fpsNum, fpsDen, preserveTime, projectMove } = opts;
  const deltaUs = preserveTime ? 0 : opts.frameDeltaUs;
  const fallback = () => ({ deltaUs, boundaryUs: null, placement: projectMove?.(deltaUs) });
  const maxDistanceUs = thresholdUs(opts.strengthPx, opts.pxPerSec);
  if (!opts.enabled || maxDistanceUs <= 0) return fallback();

  const ignored = ignoredLayerIds(state.layerId, state.escapeLink, opts.links, opts.linkByLayerId);
  for (const subject of state.subjects ?? []) ignored.add(subject.layerId);

  // A track-only move has one possible placement. Test that landing's edges
  // on the composition grid before ranking targets by distance.
  const fixed = preserveTime ? fallback() : null;
  const edges: ("tStartUs" | "tEndUs")[] =
    state.kind === "move" ? ["tStartUs", "tEndUs"] :
      state.kind === "trim-start" ? ["tStartUs"] : ["tEndUs"];
  const frameTime = (timeUs: number) => snapFrameRound(timeUs, fpsNum, fpsDen);
  const anchors = edges.map((edge) => {
    const originalUs = edge === "tStartUs" ? state.originalTStart : state.originalTEnd;
    const requestedUs = originalUs + deltaUs;
    const desiredUs = fixed?.placement?.anchor[edge] ??
      (state.kind === "move" ? Math.max(0, requestedUs) : requestedUs);
    return { edge, originalUs, desiredUs, frameUs: frameTime(desiredUs) };
  });
  const candidates: { deltaUs: number; boundaryUs: number; distanceUs: number; edge: typeof edges[number] }[] = [];
  for (const boundaryUs of new Set(timelineBoundaries(opts, ignored))) {
    for (const anchor of anchors) {
      const distanceUs = Math.abs(boundaryUs - anchor.desiredUs);
      if (preserveTime ? boundaryUs !== anchor.frameUs : distanceUs > maxDistanceUs) continue;
      candidates.push({
        deltaUs: preserveTime ? 0 : boundaryUs - anchor.originalUs,
        boundaryUs,
        distanceUs,
        edge: anchor.edge,
      });
    }
  }

  candidates.sort((a, b) => a.distanceUs - b.distanceUs);
  for (const candidate of candidates) {
    const { deltaUs, boundaryUs, edge } = candidate;
    const placement = fixed ? fixed.placement : projectMove?.(deltaUs);
    // Reachability only, never the placement's validity: the lane under the
    // pointer must not choose the target, or a straight vertical move would
    // change the clip's time. A blocked landing shows as a collision at the
    // aligned position instead.
    if (placement) {
      if (frameTime(placement.anchor[edge]) !== boundaryUs) continue;
    } else if (!preserveTime) {
      const originalUs = edge === "tStartUs" ? state.originalTStart : state.originalTEnd;
      const landedUs = constrainedAnchorUs(state, deltaUs, fpsNum, fpsDen);
      if (state.kind === "move" ? state.originalTStart + deltaUs < 0 : landedUs !== originalUs + deltaUs) continue;
    }
    return { deltaUs, boundaryUs, placement };
  }

  return fixed ?? fallback();
}

export function resolveTimelineTimeSnap(
  opts: TimelineSnapBoundaryOptions & { timeUs: number },
): TimelineTimeSnapResult {
  if (!opts.enabled) return { timeUs: opts.timeUs, boundaryUs: null };
  const maxDistanceUs = thresholdUs(opts.strengthPx, opts.pxPerSec);
  if (maxDistanceUs <= 0) return { timeUs: opts.timeUs, boundaryUs: null };

  const ignored = ignoredLayerIds(
    opts.layerId,
    opts.escapeLink ?? false,
    opts.links,
    opts.linkByLayerId,
  );
  const boundaries = timelineBoundaries(opts, ignored);

  let bestBoundaryUs: number | null = null;
  let bestDistanceUs = Number.POSITIVE_INFINITY;
  for (const boundaryUs of boundaries) {
    if (opts.isValidSnap && !opts.isValidSnap(boundaryUs)) continue;
    const distanceUs = Math.abs(boundaryUs - opts.timeUs);
    if (distanceUs <= maxDistanceUs && distanceUs < bestDistanceUs) {
      bestDistanceUs = distanceUs;
      bestBoundaryUs = boundaryUs;
    }
  }

  return { timeUs: bestBoundaryUs ?? opts.timeUs, boundaryUs: bestBoundaryUs };
}
