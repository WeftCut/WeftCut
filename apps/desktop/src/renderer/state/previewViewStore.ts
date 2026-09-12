import { create } from "zustand";

// Session-only view of the preview: how big the picture is drawn and where it
// sits. Neither changes composition coordinates, history or export geometry.
//
// ZOOM IS DEVICE PIXELS PER COMPOSITION PIXEL — the percentage every NLE
// monitor shows, where 1 is one composition pixel per device pixel, and the
// one reading that means something absolute ("am I looking at real detail?").
// `"fit"` is a MODE, not a captured number: the panel-relative scale is
// recomputed on every layout pass, so Fit survives a panel resize the way
// Premiere's and Resolve's Fit do. A number frozen at fit time would not.
//
// The RENDERER publishes the resolved fit here (`setPreviewFit`) because it is
// the only place that knows the host's device-pixel box (ADR 0071); every
// other reader takes it as given rather than measuring the DOM again.
//
// Pan is in CSS pixels from the panel centre. The math below is UNCLAMPED: the
// clamp needs the canvas and host extents, which only the gesture layer
// (measured, live) and `fittedCanvasBox` (authoritative, at paint) have. A
// stored overshoot is therefore possible after a panel shrink and is what we
// want — the pan is remembered and re-clamped for display, not discarded.

/// A scale, or the mode that recomputes one. See the header.
export type PreviewZoom = number | "fit";

export interface Pan {
  x: number;
  y: number;
}

export interface PreviewView {
  zoom: PreviewZoom;
  pan: Pan;
  /// Renderer-published: composition pixels the panel can show, per device
  /// pixel. 1 until the first layout.
  fit: number;
}

/// The labelled stops — 25 % … 400 %, the range Premiere's and Resolve's
/// monitor menus offer. The wheel roams continuously PAST both ends
/// (`PREVIEW_ZOOM_MIN`/`MAX`); these are only what the menu and the stepping
/// commands land on.
export const PREVIEW_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export const PREVIEW_ZOOM_MIN = 0.05;
export const PREVIEW_ZOOM_MAX = 8;

const CENTRE: Pan = { x: 0, y: 0 };

export const usePreviewViewStore = create<PreviewView>(() => ({
  zoom: "fit",
  pan: CENTRE,
  fit: 1,
}));

/// What `"fit"` currently means. Everything that needs a number — the wheel,
/// the readout, the raster density — resolves through here.
export function resolvePreviewZoom(zoom: PreviewZoom, fit: number): number {
  return zoom === "fit" ? fit : zoom;
}

/// The live scale, for event-time callers that must not subscribe.
export function previewScale(): number {
  const { zoom, fit } = usePreviewViewStore.getState();
  return resolvePreviewZoom(zoom, fit);
}

/// Renderer-only. Guarded so re-applying an unchanged fit costs no
/// notification — `applyPreviewFit` calls this from inside this store's own
/// subscriber, and an unguarded write there would re-enter it every pan frame.
export function setPreviewFit(fit: number): void {
  if (!(fit > 0)) return;
  if (usePreviewViewStore.getState().fit !== fit) usePreviewViewStore.setState({ fit });
}

/// Where the pan has to land for the composition point under `anchor` to stay
/// under it across a scale change — `anchor` in CSS pixels from the panel
/// centre, so the centre-anchored case is `{x: 0, y: 0}` and falls out of the
/// same expression. Derivation: a point sits at `pan + p × scale`; holding
/// that fixed for the point under the anchor gives `pan × r + anchor × (1 − r)`.
export function panAfterZoom(pan: Pan, from: number, to: number, anchor: Pan): Pan {
  const r = from > 0 ? to / from : 1;
  return {
    x: pan.x * r + anchor.x * (1 - r),
    y: pan.y * r + anchor.y * (1 - r),
  };
}

/// The gesture layer's write: it has already measured the extents and clamped.
export function setPreviewView(zoom: PreviewZoom, pan: Pan): void {
  usePreviewViewStore.setState({ zoom, pan });
}

function rungBeyond(scale: number, direction: -1 | 1): number | undefined {
  // An epsilon so a scale that IS a rung steps off it rather than sticking to
  // its own floating-point neighbourhood.
  const from = scale * (direction > 0 ? 1 + 1e-6 : 1 - 1e-6);
  const rungs = direction > 0 ? PREVIEW_ZOOM_STEPS : [...PREVIEW_ZOOM_STEPS].reverse();
  return rungs.find((step) => (direction > 0 ? step > from : step < from));
}

export function canStepPreviewZoom(direction: -1 | 1): boolean {
  return rungBeyond(previewScale(), direction) !== undefined;
}

/// One rung, anchored on the panel centre — a command has no pointer to anchor
/// on, which is exactly what Premiere's `Alt + wheel` asks for explicitly.
/// Stepping off `"fit"` picks the first rung past wherever Fit currently sits.
export function stepPreviewZoom(direction: -1 | 1): void {
  const { zoom, pan, fit } = usePreviewViewStore.getState();
  const from = resolvePreviewZoom(zoom, fit);
  const to = rungBeyond(from, direction);
  if (to === undefined) return;
  setPreviewView(to, panAfterZoom(pan, from, to, CENTRE));
}

/// The readout menu's write. Fit recentres — it is the "show me everything"
/// answer, and a remembered pan would hide part of what it just fitted.
export function setPreviewZoom(zoom: PreviewZoom): void {
  const state = usePreviewViewStore.getState();
  if (zoom === "fit") {
    resetPreviewView();
    return;
  }
  const from = resolvePreviewZoom(state.zoom, state.fit);
  setPreviewView(zoom, panAfterZoom(state.pan, from, zoom, CENTRE));
}

export function resetPreviewView(): void {
  usePreviewViewStore.setState({ zoom: "fit", pan: CENTRE });
}

/// Half the overhang, per axis: the picture may be dragged until its edge
/// meets the panel's, and no further. An axis that fits is pinned centred.
export function clampPreviewPan(pan: number, canvasExtent: number, hostExtent: number): number {
  const limit = Math.max(0, (canvasExtent - hostExtent) / 2);
  return Math.max(-limit, Math.min(limit, pan));
}
