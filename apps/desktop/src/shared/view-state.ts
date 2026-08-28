// Per-workspace timeline view state, shared by the Electron main process
// (persistence owner, src/main/view-state.ts) and the renderer (owner of the
// live copy, renderer/state/viewState.ts). One definition → no main↔renderer
// drift.
//
// UI-only knobs: deliberately NOT part of project.json so zooming the timeline
// never dirties the project document, pushes an undo entry, or shows up on the
// MCP tool surface.
//
// Everything here is scoped to ONE project, and that is the boundary worth
// keeping: the Dock's geometry lives in the app-level workspaces.json, which
// spans every project and holds reusable profiles, so no composition id below
// may ever be written there (ADR 0053).

/// The zoom a timeline opens at when nothing has been remembered for it.
/// `renderer/timeline/geometry.ts` re-exports this as `DEFAULT_PX_PER_SEC`.
export const DEFAULT_TIMELINE_PX_PER_SEC = 80;

/// One timeline tab's intent: a composition the user asked to have open, and
/// how its Panel was left. Which Panels actually exist is this list intersected
/// with the compositions the project summary carries (ADR 0053), so an entry
/// OUTLIVES the undo that removed its composition — and the redo that brings
/// the same uuid back gets the tab back with its zoom, scroll and anchor.
export interface CompositionTabView {
  composition_id: string;
  /// The `CompositionRef` layer this tab was entered through, or null when it
  /// was opened by id and takes the shortest path from the root instead. Only
  /// the last step is stored; the rest of the path follows from the project.
  anchor_layer_id: string | null;
  /// Horizontal zoom — pixels per second of this composition's own time.
  px_per_sec: number;
  scroll_left_px: number;
}

export interface ViewState {
  /// Tab order is this array's order. The root's entry belongs here like any
  /// other — its Panel comes from the layout snapshot rather than from this
  /// list, but its zoom and scroll are remembered the same way.
  composition_tabs: CompositionTabView[];
  /// The tab that last held the keyboard. Null before any Panel has taken it,
  /// which reads as "the root".
  active_composition_id: string | null;
  /// The composition the preview is LOCKED to, or null for "follow focus" (the
  /// default). Not a property of any tab — the target may name a composition
  /// with no timeline open at all (ADR 0053 decision 3) — and a target the
  /// project no longer carries falls back to following focus.
  preview_render_target_id: string | null;
  /// Track id (UUID string) → row height in px. Tracks absent from the map
  /// fall back to the frontend default. Keyed project-wide rather than per
  /// tab: a track id names its composition, so open timelines never collide.
  track_heights: Record<string, number>;
  /// Track ids whose keyframe sub-lanes are expanded. Absent ⇒ collapsed.
  expanded_tracks: string[];
}

/** Fresh defaults (new object each call so callers can't share-mutate the
 *  collections). The SINGLE place a field missing from `view.json` gets a
 *  value — a new field left `undefined` reaches the renderer as a blank
 *  screen, so every reader goes through here rather than through `?? …`. */
export function viewStateDefaults(): ViewState {
  return {
    composition_tabs: [],
    active_composition_id: null,
    preview_render_target_id: null,
    track_heights: {},
    expanded_tracks: [],
  };
}
