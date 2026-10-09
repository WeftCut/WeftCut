// Decouples the timeline's "Pre-bake now" context-menu action (React) from the
// renderer demand adapter for main-owned preparation. The Compositor subscribes on
// construction; the menu calls `requestPrebake(layerId)`. Module-level singleton
// — there is one Compositor and one timeline per window.

type Listener = (layerId: string) => void;

const listeners = new Set<Listener>();

/// Request full pre-bake at the queue front for a Motif or a Group's Motifs. No-op if no
/// Compositor is subscribed (e.g. before the preview mounts).
export function requestPrebake(layerId: string): void {
  for (const l of listeners) l(layerId);
}

/// Subscribe (Compositor). Returns an unsubscribe fn for teardown.
export function onPrebakeRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
