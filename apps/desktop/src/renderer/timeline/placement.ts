import type { TrackSummary } from "../ipc";
import {
  layerOverlapClass,
  type LayerOverlapClass,
} from "./geometry";

/// `"spawn"` is the placement policy's fourth answer: no lane can take this
/// clip, so one is made for it. It is what the command path has always done
/// internally (`main/state/commands.ts`'s reverse scan appends a lane when
/// nothing is free) and what the drop path could not say — see ADR 0042.
export type PlacementValidity = "valid" | "collision" | "locked" | "spawn";

/// Placement target standing in for "a lane that does not exist yet" — the drop
/// strip. Keeping it a target id rather than a flag is what makes the strip's
/// answer structural: it travels the same evaluation, the same claim/release
/// drop-target protocol and the same ghost geometry a lane does, and no drop
/// surface has to special-case it.
export const SPAWN_TRACK_ID = "__weftcut-spawn-track__";

/// Which row a live drag's preview chip belongs in, given its resolved
/// destination and the lane the clip is still on.
///
/// `SPAWN_TRACK_ID` is a row like any other here — the drop strip draws the
/// raise's ghost itself (`DropStrip.tsx`), so the answer is the sentinel and
/// every lane filters the chip out, the SOURCE lane included. That last part is
/// the point rather than a side effect: a raise is LEAVING that lane, and a chip
/// left sitting on it said the opposite.
///
/// This used to answer the source lane, on two grounds that have both since
/// expired: the strip was too thin to stand in for a chip (the
/// cross-Panel ghost draws in exactly that band, `ForeignDragGhost.tsx`), and a
/// raise carried its times verbatim so the chip already sat where it would land
/// (`move_layers_to_new_track` takes a landing now). Between them they made the
/// strip the one destination in the timeline where the clip jumped BACK to where
/// it started as the pointer arrived.
///
/// `null` still answers the source lane: it means the pointer is over no row at
/// all, and it is also the destination WITHHELD from a duplicate over the strip
/// (`useLayerDrag`). Nothing is leaving in either case, so the chip stays home.
export function previewTrackId(
  destinationTrackId: string | null,
  sourceTrackId: string,
): string {
  return destinationTrackId ?? sourceTrackId;
}

/// Whether a verdict refuses the placement. `"spawn"` is committable, so
/// `!== "valid"` stopped meaning "refused" the moment the strip existed — a drag
/// over it would otherwise wear the collision chrome and be blocked at release.
/// Both refusing verdicts out-rank `"spawn"` below, which is why a lock or a
/// self-overlap still reaches this predicate on a drop-strip placement.
export function placementRefuses(validity: PlacementValidity): boolean {
  return validity === "collision" || validity === "locked";
}

export interface TimelinePlacement {
  layerId: string;
  trackId: string;
  tStartUs: number;
  tEndUs: number;
  overlapClass: LayerOverlapClass;
  locked: boolean;
}

export interface TimelinePlacementEvaluation {
  validity: PlacementValidity;
  conflictingLayerIds: string[];
  sharesLane: boolean;
}

function rangesOverlap(
  aStartUs: number,
  aEndUs: number,
  bStartUs: number,
  bEndUs: number,
): boolean {
  return aEndUs > bStartUs && bEndUs > aStartUs;
}

/**
 * Evaluate projected layer positions against the committed timeline and one
 * another. `replacedLayerIds` removes the subjects' old positions before the
 * projections are checked, which prevents a moving clip colliding with itself.
 *
 * This is the shared overlap seam for incoming-media ghosts and existing-layer
 * move ghosts: visual/visual and audio/audio overlap is invalid, visual/audio
 * overlap is a legal shared lane, and touching half-open ranges are legal.
 *
 * A placement on `SPAWN_TRACK_ID` answers `"spawn"`: the lane it names has no
 * committed content to overlap, so a fresh lane is empty by construction.
 */
export function evaluateTimelinePlacements({
  tracks,
  placements,
  replacedLayerIds,
}: {
  tracks: readonly TrackSummary[];
  placements: readonly TimelinePlacement[];
  replacedLayerIds: ReadonlySet<string>;
}): TimelinePlacementEvaluation {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const conflictingLayerIds: string[] = [];
  const conflictSet = new Set<string>();
  let locked = false;
  let sharesLane = false;
  let spawns = false;

  const addConflict = (layerId: string) => {
    if (conflictSet.has(layerId)) return;
    conflictSet.add(layerId);
    conflictingLayerIds.push(layerId);
  };

  for (const placement of placements) {
    if (placement.trackId === SPAWN_TRACK_ID) {
      // A locked SUBJECT still refuses — that is a property of the clip being
      // placed, not of the destination, and the destination has no content.
      if (placement.locked) locked = true;
      spawns = true;
      continue;
    }
    const targetTrack = trackById.get(placement.trackId);
    if (placement.locked || targetTrack?.locked) locked = true;
    if (!targetTrack) continue;

    for (const layer of targetTrack.layers) {
      if (replacedLayerIds.has(layer.id)) continue;
      if (
        !rangesOverlap(
          placement.tStartUs,
          placement.tEndUs,
          layer.t_start_us,
          layer.t_end_us,
        )
      ) {
        continue;
      }
      if (placement.overlapClass === layerOverlapClass(layer)) {
        addConflict(layer.id);
      } else {
        sharesLane = true;
      }
    }
  }

  // A cross-track link move can place the anchor onto a sibling's track.
  // Their committed positions were removed above, so compare every projected
  // pair to preserve the same invariant inside the moving set.
  for (let i = 0; i < placements.length; i += 1) {
    const left = placements[i]!;
    for (let j = i + 1; j < placements.length; j += 1) {
      const right = placements[j]!;
      if (
        left.trackId !== right.trackId ||
        !rangesOverlap(
          left.tStartUs,
          left.tEndUs,
          right.tStartUs,
          right.tEndUs,
        )
      ) {
        continue;
      }
      if (left.overlapClass === right.overlapClass) {
        addConflict(left.layerId);
        addConflict(right.layerId);
      } else {
        sharesLane = true;
      }
    }
  }

  return {
    // `spawn` ranks below collision so a multi-selection that would overlap
    // itself on the one new lane still refuses instead of promising a lane it
    // cannot fill.
    validity: locked
      ? "locked"
      : conflictingLayerIds.length > 0
        ? "collision"
        : spawns
          ? "spawn"
          : "valid",
    conflictingLayerIds,
    sharesLane,
  };
}
