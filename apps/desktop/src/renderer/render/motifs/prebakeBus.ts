// Decouples the timeline's "Pre-bake now" context-menu action (React) from the
// renderer demand adapter for main-owned preparation. The Compositor subscribes on
// construction; the menu calls `requestPrebake(layerId)`. Module-level singleton
// — there is one Compositor and one timeline per window.

type Listener = (layerId: string) => void;

const listeners = new Set<Listener>();
/** Requests made while no Compositor is subscribed: the preview builds one
 * only after its Application initializes, at mount and on every rebuild. */
const unheard = new Set<string>();

/// Request full pre-bake at the queue front for a Motif or a Group's Motifs.
/// Without a subscribed Compositor the request waits for the next one.
export function requestPrebake(layerId: string): void {
  if (listeners.size === 0) { unheard.add(layerId); return; }
  for (const l of listeners) l(layerId);
}

/// Subscribe (Compositor), receiving the requests that waited for one.
/// Returns an unsubscribe fn for teardown.
export function onPrebakeRequest(listener: Listener): () => void {
  listeners.add(listener);
  const waiting = [...unheard];
  unheard.clear();
  for (const layerId of waiting) listener(layerId);
  return () => listeners.delete(listener);
}
