// Where a media item is used: the clips that point at it, resolved to the names
// the timeline already shows them under.
//
// Owns the resolution and the naming; owns nothing about how a row draws — the
// media inspector (`properties/MediaFields.tsx`) and the pool's removal
// confirmation (`panels/MediaPool.tsx`) each draw their own.

import { formatTimecode } from "../frames";
import type { CompositionSummary, LayerSummary, ProjectSummary } from "../ipc";
import { groupDisplayName } from "../lib/layerName";
import { trackDisplayName } from "../lib/trackName";

type Translate = (key: string, values: Record<string, unknown>) => string;

/// One clip that shows a media item, ready to print.
export interface MediaReference {
  layerId: string;
  /// The clip's own name: its label, else its translated kind, else a short id.
  /// Deliberately NOT `layerDisplayName` — that chain falls back to the media
  /// label, which is the same word on every row of this list.
  name: string;
  /// The Group the clip sits in, under the name its card and its tab print;
  /// null on the root, which is never named in the UI because it IS the
  /// timeline (`workspace/timelineTabName.ts`).
  compositionName: string | null;
  /// The name the track's own header shows.
  trackName: string;
  /// Start on the composition's clock. Null ONLY for a layer the renderer's
  /// snapshot cannot place — there is no track or Group beside it either.
  tStartUs: number | null;
}

function layerMediaId(layer: LayerSummary): string | null {
  switch (layer.params.kind) {
    case "VideoClip":
    case "ImageOverlay":
    case "Audio":
      return layer.params.media_id;
    default:
      return null;
  }
}

/// Root first, then every Group in the summary's own key order.
function compositionsInOrder(summary: ProjectSummary): CompositionSummary[] {
  const root = summary.compositions[summary.root_id];
  const groups = Object.values(summary.compositions).filter(
    (comp) => comp.id !== summary.root_id,
  );
  return root ? [root, ...groups] : groups;
}

/// Resolve the clips showing `mediaId` into human-facing rows.
///
/// Spans EVERY composition, because the pool does and because the backend does:
/// `referencingLayers` (main/state/mutations/media.ts) walks the whole project,
/// so a per-composition list would disagree with what Remove actually deletes
/// and would under-report where an item is used the moment it is used inside a
/// Group.
///
/// With no `onlyLayerIds`, this derives the live references from the snapshot.
/// With ids, it presents the authoritative `MediaInUse.referenced_by` result
/// returned by the guarded remove call.
export function mediaReferencesFor(
  mediaId: string,
  summary: ProjectSummary | null,
  ordinals: ReadonlyMap<string, number>,
  t: Translate,
  onlyLayerIds?: readonly string[],
): MediaReference[] {
  const requested = onlyLayerIds ? new Set(onlyLayerIds) : null;
  const found = new Set<string>();
  const references: MediaReference[] = [];

  for (const comp of summary ? compositionsInOrder(summary) : []) {
    const compositionName =
      comp.id === summary?.root_id
        ? null
        : groupDisplayName(comp.id, comp.label, ordinals, t);
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        const matches = requested
          ? requested.has(layer.id)
          : layerMediaId(layer) === mediaId;
        if (!matches || found.has(layer.id)) continue;
        found.add(layer.id);
        references.push({
          layerId: layer.id,
          name:
            layer.label?.trim() ||
            t(`kinds.${layer.params.kind.toLowerCase()}`, {
              defaultValue: layer.params.kind,
            }),
          compositionName,
          trackName: trackDisplayName(track, comp.tracks, t),
          tStartUs: layer.t_start_us,
        });
      }
    }
  }

  // A project-change notification can race the command rejection. Keep every
  // authoritative id visible even when the stale renderer snapshot cannot yet
  // resolve its name, track or composition.
  for (const layerId of onlyLayerIds ?? []) {
    if (found.has(layerId)) continue;
    references.push({
      layerId,
      name: t("media_pool.reference_unknown_layer", { id: layerId.slice(0, 8) }),
      compositionName: null,
      trackName: t("media_pool.reference_unknown_track", {}),
      tStartUs: null,
    });
  }
  return references;
}

/// The quiet second line of a reference row: where the clip sits, then when.
/// One home for it, because the removal confirmation and the inspector describe
/// the same clip and must not describe it differently.
///
/// The rate is the caller's, not the composition's: every composition inherits
/// the project's frame rate at pre-compose (`main/state/mutations/groups.ts`),
/// so there is one lattice for the whole project — the same assumption the
/// search index states at `search/buildEntries.ts`.
export function mediaReferenceMeta(
  reference: MediaReference,
  fpsNum: number,
  fpsDen: number,
): string {
  return [
    reference.compositionName,
    reference.trackName,
    reference.tStartUs === null
      ? null
      : formatTimecode(reference.tStartUs, fpsNum, fpsDen),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
