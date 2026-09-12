import { create } from "zustand";

// Session-only view of the preview. Zoom is relative to Fit; pan is in CSS
// pixels from the panel centre. Neither changes composition coordinates.
export const PREVIEW_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export interface PreviewView {
  zoom: number;
  pan: { x: number; y: number };
}
export const usePreviewViewStore = create<PreviewView>(() => ({
  zoom: 1,
  pan: { x: 0, y: 0 },
}));

export function canStepPreviewZoom(direction: -1 | 1): boolean {
  const { zoom } = usePreviewViewStore.getState();
  return PREVIEW_ZOOM_STEPS.some((step) => direction > 0 ? step > zoom : step < zoom);
}

export function stepPreviewZoom(direction: -1 | 1): void {
  const { zoom, pan } = usePreviewViewStore.getState();
  const steps = direction > 0 ? PREVIEW_ZOOM_STEPS : [...PREVIEW_ZOOM_STEPS].reverse();
  const next = steps.find((step) => direction > 0 ? step > zoom : step < zoom);
  if (next === undefined) return;
  usePreviewViewStore.setState({
    zoom: next,
    pan: next <= 1 ? { x: 0, y: 0 } : { x: pan.x * next / zoom, y: pan.y * next / zoom },
  });
}

export function resetPreviewView(): void {
  usePreviewViewStore.setState({ zoom: 1, pan: { x: 0, y: 0 } });
}

export function clampPreviewPan(pan: number, canvasExtent: number, hostExtent: number): number {
  const limit = Math.max(0, (canvasExtent - hostExtent) / 2);
  return Math.max(-limit, Math.min(limit, pan));
}
