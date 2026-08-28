import { type LayerSummary, type TrackSummary } from "../ipc";

/** Resolve the primary Layer from the Project summary supplied to a tool Panel. */
export function findPanelLayer(
  tracks: TrackSummary[],
  layerId: string | null,
): LayerSummary | null {
  if (!layerId) return null;
  for (const track of tracks) {
    const layer = track.layers.find((candidate) => candidate.id === layerId);
    if (layer) return layer;
  }
  return null;
}

/**
 * Effects render on visual sprite kinds only. The allowlist keeps future
 * non-visual Layer kinds from accidentally inheriting a visual effect chain.
 *
 * A Group belongs here: it is staged as a Sprite like every other visual kind
 * (its composition renders to a texture first), so a filter chain applies to the
 * composite exactly as it applies to a video frame — which is also why an effect
 * on a Group is one of the three things that block Ungroup (ADR 0052 §5).
 */
export function isVisualKind(kind: string): boolean {
  return (
    kind === "Text" ||
    kind === "VideoClip" ||
    kind === "ImageOverlay" ||
    kind === "Color" ||
    kind === "Motif" ||
    kind === "CompositionRef"
  );
}
