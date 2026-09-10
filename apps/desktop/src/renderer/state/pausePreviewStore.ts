// Which clip's candidate pauses the timeline should draw, and which of them are
// being auditioned. The Pauses section of the Attribute Panel publishes while
// its body is mounted — the section is collapsed by default and collapsing
// unmounts the body, so "mounted" already IS "expanded", the same rule
// `audioRegionFocusStore` states for the denoise band. The timeline reads.
//
// Boundary: the section publishes, `timeline/PauseBands` draws. Detection
// parameters, the writes and the audition all belong to the section; this store
// carries only what a band needs to be drawn. Spec `.scratch/pauses/spec.md`
// Decisions 5 and 7.
//
// Session state, deliberately NOT persisted: which section is open is where you
// are in a work session, not a property of the project.

import { create } from "zustand";

/// One candidate pause in the SUBJECT's own composition clock — timeline
/// absolute and already clipped to the layer's span, the shape `detect_pauses`
/// returns. Declared here rather than imported from `../ipc` so the store has no
/// dependency on the IPC module's rename landing first.
export interface PausePreviewRegion {
  t_start_us: number;
  t_end_us: number;
}

export interface PausePreview {
  /// The Audio layer the pauses were measured on — never a delegating
  /// VideoClip. A band is drawn on this block and on no other.
  subjectLayerId: string;
  pauses: readonly PausePreviewRegion[];
  /// `pad_us` at the time of the detection: the band's darker core is
  /// `[start + padUs, end − padUs)`, the part *Remove* would cut. A pause whose
  /// core collapses draws no core.
  padUs: number;
  /// Indices into `pauses` whose joins the result audition is currently
  /// playing; those bands draw brighter. Empty when nothing plays.
  auditioning: readonly number[];
}

interface State {
  /// Null = no Pauses section is expanded anywhere.
  preview: PausePreview | null;
}

export const usePausePreviewStore = create<State>(() => ({ preview: null }));

/// Publish (or republish) the section's current answer. Called on every
/// detection that lands and on every audition start/stop.
export function setPausePreview(preview: PausePreview): void {
  usePausePreviewStore.setState({ preview });
}

/// Unmount. Guarded by subject so a stale cleanup — the section re-mounted for
/// another clip before the old effect's cleanup ran — never blanks the newer
/// publication.
export function clearPausePreview(subjectLayerId: string): void {
  const { preview } = usePausePreviewStore.getState();
  if (preview === null || preview.subjectLayerId !== subjectLayerId) return;
  usePausePreviewStore.setState({ preview: null });
}

/// Subscribe for ONE block. Returns the STORED object when it is about this
/// layer and `null` otherwise, so every other block bails out on reference
/// equality and re-renders on nothing (`feedback_zustand_composite_selector`).
export const usePausePreview = (layerId: string): PausePreview | null =>
  usePausePreviewStore((s) =>
    s.preview !== null && s.preview.subjectLayerId === layerId
      ? s.preview
      : null,
  );

/// Imperative read for event-time callers.
export function pausePreviewSnapshot(): PausePreview | null {
  return usePausePreviewStore.getState().preview;
}
