import type { CompositionSummary } from "../ipc";

/// How many Group layers point at each composition, counted over the whole
/// project — `composition_id → ref_count`.
///
/// Derived in the renderer rather than carried on the wire: it is a count over
/// the layers the summary already ships, and a wire field would be a second
/// answer to a question the summary can only answer one way. `main`'s
/// `compositionRefCount` is the same count on the same data, where a refusal
/// needs it.
///
/// A composition with no entry has no references — an orphan, which is legal
/// (ADR 0052): its last Group clip was deleted and the media pool is where it
/// stays visible and removable. Callers read `get(id) ?? 0`.
export function compositionRefCounts(
  compositions: Readonly<Record<string, CompositionSummary>>,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const comp of Object.values(compositions)) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "CompositionRef") continue;
        const id = layer.params.composition_id;
        out.set(id, (out.get(id) ?? 0) + 1);
      }
    }
  }
  return out;
}
