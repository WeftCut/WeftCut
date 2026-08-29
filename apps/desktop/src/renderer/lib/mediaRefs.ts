import type { CompositionSummary } from "../ipc";

/// How many layers show each media item, counted over the whole project —
/// `media_id → ref_count`. The twin of `lib/compositionRefs.ts`, on the other
/// kind the media pool lists.
///
/// The three kinds counted are the three `referencingLayers`
/// (`main/state/mutations/media.ts`) counts, and that agreement is
/// load-bearing: a count that saw a kind the backend does not would call an
/// item unused that a guarded remove then refuses to delete.
///
/// A media item with no entry is placed nowhere — which is its NORMAL state,
/// not a remnant: everything is unused the moment it is imported, which is why
/// no card marks it and only the pool's opt-in filter asks. Callers read
/// `get(id) ?? 0`.
export function mediaRefCounts(
  compositions: Readonly<Record<string, CompositionSummary>>,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const comp of Object.values(compositions)) {
    for (const track of comp.tracks) {
      for (const { params } of track.layers) {
        if (
          params.kind !== "VideoClip" &&
          params.kind !== "ImageOverlay" &&
          params.kind !== "Audio"
        ) {
          continue;
        }
        out.set(params.media_id, (out.get(params.media_id) ?? 0) + 1);
      }
    }
  }
  return out;
}
