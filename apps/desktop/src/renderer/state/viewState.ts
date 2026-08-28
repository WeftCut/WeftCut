// The project's `view.json` while the app is running: the tab intent every
// timeline Panel is derived from, each tab's zoom and scroll, and the
// project-wide track heights — held once, and written once.
//
// ONE owner, not one per Panel. Several timeline Panels can stand open (ADR
// 0053) and they share a single file, so N debounced writers would each save
// the whole document and whichever fired last would win, silently reverting
// the others. The Panels patch this module; this module alone calls
// `view_state_set`.
//
// It does NOT decide which compositions have a Panel — `compositionAnchorStore`
// does, and publishes the answer here — and it holds no Dock geometry: that
// lives in the app-level workspaces.json, where a composition id may never
// appear.
//
// Plain module state, not a store: nothing here is read during render. A Panel
// awaits `loadViewState()` once and keeps its own React state afterwards, which
// is what keeps `scroll_left_px` — a value that moves at wheel rate — off every
// render path above a leaf (see `timelineScrollStore.ts`).

import {
  DEFAULT_TIMELINE_PX_PER_SEC,
  viewStateDefaults,
  type CompositionTabView,
  type ViewState,
} from "../../shared/view-state";
import { viewStateGet, viewStateSet } from "../ipc";

/// Debounce window after the last edit before we hit disk. A resize drag and a
/// wheel scroll both fire ~60×/sec; 200 ms keeps the file write off the
/// critical drag path while still landing within a beat of the user stopping.
export const VIEW_SAVE_DEBOUNCE_MS = 200;

/// One open timeline Panel, as `compositionAnchorStore` reports it.
export interface OpenTabIntent {
  compositionId: string;
  /// The Group clip the Panel was entered through; null for the root and for a
  /// composition opened by id.
  anchorLayerId: string | null;
}

/// False until this project's `view.json` has been read. EVERY mutator below
/// bails out while it is false: a Panel mounts and the Dock reports its tabs
/// before the read lands, and taking those as the truth would write a
/// one-tab-at-default-zoom document over the one being loaded.
let loaded = false;
/// The in-flight (or settled) read, so N Panels mounting together share one.
let pending: Promise<ViewState> | null = null;

let tabs: CompositionTabView[] = [];
let activeCompositionId: string | null = null;
let trackHeights: Record<string, number> = {};
let expandedTracks = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  saveTimer = null;
  viewStateSet({
    composition_tabs: tabs.map((tab) => ({ ...tab })),
    active_composition_id: activeCompositionId,
    track_heights: { ...trackHeights },
    expanded_tracks: [...expandedTracks],
  }).catch((e) => console.warn("view_state save failed:", e));
}

function markDirty(): void {
  if (!loaded) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, VIEW_SAVE_DEBOUNCE_MS);
}

/// The entry for one composition, created on demand. A Panel can report its
/// zoom before the Dock has reported its tab; the entry is then adopted or
/// dropped by the next `publishCompositionTabs`, which is the one caller that
/// knows whether the composition still has a Panel.
function tabFor(compositionId: string): CompositionTabView {
  const found = tabs.find((tab) => tab.composition_id === compositionId);
  if (found) return found;
  const fresh: CompositionTabView = {
    composition_id: compositionId,
    anchor_layer_id: null,
    px_per_sec: DEFAULT_TIMELINE_PX_PER_SEC,
    scroll_left_px: 0,
  };
  tabs.push(fresh);
  return fresh;
}

/// Read this project's `view.json`, once. Resolves with defaults rather than
/// rejecting: the file is a convenience, and a timeline that refuses to mount
/// because a zoom level could not be read would be the worse failure.
export function loadViewState(): Promise<ViewState> {
  if (pending !== null) return pending;
  const request: Promise<ViewState> = viewStateGet()
    .catch((e) => {
      console.warn("view_state load failed:", e);
      return viewStateDefaults();
    })
    .then((state) => {
      // A read that lands after the project moved on belongs to nobody:
      // `resetViewState` dropped this promise, and seeding the incoming
      // project's document from the outgoing one's file would carry another
      // project's composition ids across.
      if (pending !== request) return state;
      tabs = state.composition_tabs.map((tab) => ({ ...tab }));
      activeCompositionId = state.active_composition_id;
      trackHeights = { ...state.track_heights };
      expandedTracks = new Set(state.expanded_tracks);
      loaded = true;
      return state;
    });
  pending = request;
  return request;
}

/// Drop everything and disarm the writer — the project is closing or another
/// one is opening. A pending write is CANCELLED rather than flushed: main
/// resolves `<workspace>/view.json` when it handles the call, so a late write
/// for the project being left would land in the one being opened.
export function resetViewState(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  loaded = false;
  pending = null;
  tabs = [];
  activeCompositionId = null;
  trackHeights = {};
  expandedTracks = new Set();
}

/// The tabs this project asks for, in order. Empty until the read lands, which
/// reads as "the root alone" — the Panel the layout snapshot already carries.
export function compositionTabIntent(): readonly CompositionTabView[] {
  return tabs;
}

function sameTabs(a: readonly CompositionTabView[], b: readonly CompositionTabView[]): boolean {
  return (
    a.length === b.length &&
    a.every((tab, i) => {
      const other = b[i]!;
      return (
        tab.composition_id === other.composition_id &&
        tab.anchor_layer_id === other.anchor_layer_id &&
        tab.px_per_sec === other.px_per_sec &&
        tab.scroll_left_px === other.scroll_left_px
      );
    })
  );
}

/// Record which compositions have a Panel, in tab order, and which one holds
/// the keyboard.
///
/// `aliveCompositionIds` separates the two ways a tab can leave the Dock, which
/// look identical from the Dock's side and mean opposite things: a composition
/// the project still carries that no longer has a Panel was CLOSED, and its
/// intent goes with it; one the project no longer carries was undone away, and
/// its entry is kept so the redo brings the tab back with its zoom (ADR 0053).
///
/// Called on every Dock layout change, a splitter-drag frame included, so an
/// unchanged publication must not arm the writer.
export function publishCompositionTabs(
  open: readonly OpenTabIntent[],
  aliveCompositionIds: ReadonlySet<string>,
  activeId: string | null,
): void {
  if (!loaded) return;
  const remaining = new Map(tabs.map((tab) => [tab.composition_id, tab]));
  const next: CompositionTabView[] = [];
  for (const { compositionId, anchorLayerId } of open) {
    const previous = remaining.get(compositionId);
    remaining.delete(compositionId);
    next.push({
      composition_id: compositionId,
      anchor_layer_id: anchorLayerId,
      px_per_sec: previous?.px_per_sec ?? DEFAULT_TIMELINE_PX_PER_SEC,
      scroll_left_px: previous?.scroll_left_px ?? 0,
    });
  }
  for (const tab of tabs) {
    if (remaining.has(tab.composition_id) && !aliveCompositionIds.has(tab.composition_id)) {
      next.push(tab);
    }
  }
  if (activeCompositionId === activeId && sameTabs(tabs, next)) return;
  tabs = next;
  activeCompositionId = activeId;
  markDirty();
}

/// One tab's zoom. `null` is the unbound timeline row the Dock builds before a
/// summary names a root; it shows no composition, so it remembers nothing.
export function noteTabZoom(compositionId: string | null, pxPerSec: number): void {
  if (!loaded || compositionId === null) return;
  const tab = tabFor(compositionId);
  if (tab.px_per_sec === pxPerSec) return;
  tab.px_per_sec = pxPerSec;
  markDirty();
}

/// One tab's horizontal scroll. Arrives at wheel rate from the timeline's one
/// scroll publisher, so it stays a plain field write plus a timer restart —
/// nothing here re-renders.
export function noteTabScroll(compositionId: string | null, scrollLeftPx: number): void {
  if (!loaded || compositionId === null) return;
  const tab = tabFor(compositionId);
  if (tab.scroll_left_px === scrollLeftPx) return;
  tab.scroll_left_px = scrollLeftPx;
  markDirty();
}

/// Row heights, MERGED rather than replaced: a Panel reports the rows it draws,
/// and the map spans the whole project, so replacing it would delete every
/// other Panel's rows.
export function noteTrackHeights(heights: Readonly<Record<string, number>>): void {
  if (!loaded) return;
  let changed = false;
  for (const [id, px] of Object.entries(heights)) {
    if (trackHeights[id] === px) continue;
    trackHeights[id] = px;
    changed = true;
  }
  if (changed) markDirty();
}

/// One row's keyframe sub-lane. A single-key patch for the same reason the
/// heights are merged — a whole-set replacement from one Panel would collapse
/// every other Panel's expanded rows.
export function noteTrackExpanded(trackId: string, expanded: boolean): void {
  if (!loaded) return;
  if (expandedTracks.has(trackId) === expanded) return;
  if (expanded) expandedTracks.add(trackId);
  else expandedTracks.delete(trackId);
  markDirty();
}

/// Forget the rows the project no longer has, so `view.json` does not
/// accumulate entries for deleted tracks. The project summary is the only
/// place the live set is known, which is why this is pushed in rather than
/// pulled — and why it is the ONE prune: a Panel reports only its own rows and
/// never removes anything, so no caller has to defend a row it cannot see.
export function retainTrackViewState(liveTrackIds: Iterable<string>): void {
  if (!loaded) return;
  const live = new Set(liveTrackIds);
  let dropped = false;
  for (const id of Object.keys(trackHeights)) {
    if (live.has(id)) continue;
    delete trackHeights[id];
    dropped = true;
  }
  for (const id of [...expandedTracks]) {
    if (live.has(id)) continue;
    expandedTracks.delete(id);
    dropped = true;
  }
  if (dropped) markDirty();
}
