import { useSyncExternalStore } from "react";

import { settledRendererCapability, subscribeRendererCapability, type RendererCapability } from "./rendererCapability";

/// The shared renderer capability (`rendererCapability.ts`) for React; null
/// until the one query settles.
export function useRendererCapability(): RendererCapability | null {
  return useSyncExternalStore(subscribeRendererCapability, settledRendererCapability);
}
