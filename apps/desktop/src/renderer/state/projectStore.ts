import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";

import {
  projectSummary,
  type CompositionSummary,
  type LayerSummary,
  type MarkerSummary,
  type MediaSummary,
  type ProjectSummary,
  type RoleMixView,
} from "../ipc";
import { compositionOrRoot, rootCompositionOf } from "../ipc/compositions";
import { groupOrdinals } from "../lib/layerName";
import {
  reconcileCompositionScope,
  useCompositionScopeStore,
} from "./compositionScopeStore";
import { restorePrecomposeSelection } from "./precomposeSelection";
import {
  retainLayerSelection,
  retainTransitionSelection,
} from "./selectionStore";
import { LatestRequestCoordinator } from "./latestRequest";

/// Frontend mirror of the main-process TS state actor's project, kept in sync
/// via `project:changed` backend events. The PixiJS preview consumes this
/// directly; there is no separate IR emit target for the preview
/// (see `docs/preview.md`).
///
/// Atomic selectors only — composite-object selectors infinite-loop
/// `useSyncExternalStore` per `feedback_zustand_composite_selector`.
/// Helpers below select a single field at a time; for derived combos
/// use `useShallow` from `zustand/shallow` at the call site.
///
/// Pre-workspace: `summary` is `null`; consumers should guard.

export interface ProjectStoreState {
  summary: ProjectSummary | null;
  /// `media_id → MediaSummary`. Rebuilt on every `summary` change.
  mediaById: Map<string, MediaSummary>;
  /// `layer_id → LayerSummary`. Rebuilt on every `summary` change.
  layerById: Map<string, LayerSummary>;
  /// `layer_id → track_id` reverse index — handy for z-order
  /// (track order) lookups without iterating tracks each time.
  trackIdByLayerId: Map<string, string>;
  /// `layer_id → composition_id` / `track_id → composition_id`. Every index
  /// spans ALL compositions: a search hit or a history row may name a layer
  /// inside a Group, and the answer to "where does it live" has to come
  /// before the scope store can open that Group.
  compositionIdByLayerId: Map<string, string>;
  compositionIdByTrackId: Map<string, string>;
  /// `composition_id → N` for the derived `Group N` name (`lib/layerName.ts`).
  /// Built once per summary rather than per naming call: every Group clip, every
  /// breadcrumb crumb and every search entry asks the same question, and the
  /// answer depends on the WHOLE composition set, not on the layer asking.
  groupOrdinals: ReadonlyMap<string, number>;
  /// True after the initial `project_summary` fetch + subscription is
  /// wired. Distinguishes "no project loaded" (`summary === null`,
  /// `ready === true`) from "haven't fetched yet"
  /// (`summary === null`, `ready === false`).
  ready: boolean;
}

interface ProjectStoreActions {
  /// Apply a fresh summary snapshot, rebuilding lookup indices and dropping
  /// globally selected Layers that no longer exist in the Project.
  /// Idempotent; safe to call from a debounced refresher.
  apply: (summary: ProjectSummary | null) => void;
}

/// Declared HERE, not with the other empty sentinels at the foot of the file:
/// the store initializer below runs at module evaluation, and a `const` further
/// down would still be in its temporal dead zone.
const EMPTY_ORDINALS: ReadonlyMap<string, number> = new Map();

function buildIndices(summary: ProjectSummary | null): {
  mediaById: Map<string, MediaSummary>;
  layerById: Map<string, LayerSummary>;
  trackIdByLayerId: Map<string, string>;
  compositionIdByLayerId: Map<string, string>;
  compositionIdByTrackId: Map<string, string>;
  groupOrdinals: ReadonlyMap<string, number>;
} {
  const mediaById = new Map<string, MediaSummary>();
  const layerById = new Map<string, LayerSummary>();
  const trackIdByLayerId = new Map<string, string>();
  const compositionIdByLayerId = new Map<string, string>();
  const compositionIdByTrackId = new Map<string, string>();
  const indices = {
    mediaById,
    layerById,
    trackIdByLayerId,
    compositionIdByLayerId,
    compositionIdByTrackId,
    groupOrdinals: summary
      ? groupOrdinals(summary.compositions, summary.root_id)
      : EMPTY_ORDINALS,
  };
  if (!summary) return indices;
  for (const m of summary.media) mediaById.set(m.id, m);
  for (const c of Object.values(summary.compositions)) {
    for (const t of c.tracks) {
      compositionIdByTrackId.set(t.id, c.id);
      for (const l of t.layers) {
        layerById.set(l.id, l);
        trackIdByLayerId.set(l.id, t.id);
        compositionIdByLayerId.set(l.id, c.id);
      }
    }
  }
  return indices;
}

export const useProjectStore = create<
  ProjectStoreState & ProjectStoreActions
>((set) => ({
  summary: null,
  mediaById: new Map(),
  layerById: new Map(),
  trackIdByLayerId: new Map(),
  compositionIdByLayerId: new Map(),
  compositionIdByTrackId: new Map(),
  groupOrdinals: EMPTY_ORDINALS,
  ready: false,

  apply: (summary) => {
    const indices = buildIndices(summary);
    set({
      summary,
      ...indices,
      ready: true,
    });
    retainLayerSelection(indices.layerById.keys());
    retainTransitionSelection(
      summary
        ? Object.values(summary.compositions).flatMap((c) => c.transitions.map((tr) => tr.id))
        : [],
    );
    // After the indices and the retained selections: the fallback switch this
    // may run clears the selection, and reads the summary just published.
    reconcileCompositionScope(summary);
    // After the switch, for the same reason: undoing a pre-compose from inside
    // the Group it created lands here having just cleared the selection, and
    // this is what puts the grouped layers back in it.
    restorePrecomposeSelection(summary);
  },
}));

/// One-shot mount wiring: fetch the initial summary, then subscribe to
/// `project:changed`. Returns a teardown function the caller stores
/// + invokes on unmount.
///
/// Idempotent for HMR: a second call replaces the subscription; the
/// initial fetch is harmless re-work.
///
/// Pre-workspace: `project_summary` returns an Err which we treat as
/// "no project loaded" — the store sits with `summary: null, ready: true`
/// and the listener catches the eventual `project:changed` that arrives
/// once a workspace opens.
export async function wireProjectStore(): Promise<UnlistenFn> {
  // `project:changed` fires a re-fetch, and `project_summary` is an async IPC
  // whose responses can resolve out of order. A newly issued request
  // invalidates every earlier request immediately, including while the new
  // response is pending. Otherwise the older snapshot can still publish in
  // that gap and temporarily regress clip geometry or media export routing.
  const requests = new LatestRequestCoordinator();
  const refresh = async () => {
    await requests.run(
      () => projectSummary(),
      (summary) => useProjectStore.getState().apply(summary),
      () => {
        // No project loaded — leave summary null but mark ready so
        // consumers can distinguish from the pre-fetch state.
        useProjectStore.getState().apply(null);
      },
    );
  };
  // Subscribe BEFORE the seed fetch: a `project:changed` emitted between the
  // seed resolving and the listener registering would otherwise be lost, and
  // the store would sit on a stale snapshot until some unrelated later event.
  // An event landing during the seed just runs a second refresh, which the
  // coordinator already serializes newest-wins.
  const unlisten = await listen("project:changed", () => {
    void refresh();
  });
  await refresh();
  return () => {
    requests.invalidate();
    unlisten();
  };
}

// ===== Atomic selector helpers ============================================
// Each returns ONE field (or a value derived from one field) so React's
// `useSyncExternalStore` doesn't infinite-loop on referential equality.

export const useProjectSummary = (): ProjectSummary | null =>
  useProjectStore((s) => s.summary);

export const useAudioRoles = (): RoleMixView[] =>
  useProjectStore((s) => s.summary?.audio_roles ?? EMPTY_ROLES);

/// The OPEN composition's markers — the ruler paints one timeline's markers.
/// Reads through the empty sentinel pre-workspace.
export const useProjectMarkers = (): MarkerSummary[] =>
  useOpenComposition()?.markers ?? EMPTY_MARKERS;

// ===== Compositions =========================================================

export { compositionOrRoot, rootCompositionOf };

/// Imperative read of the open composition for event-time callers (shortcut
/// handlers, command predicates) — the non-hook twin of `useOpenComposition`.
export function currentOpenComposition(): CompositionSummary | null {
  return compositionOrRoot(
    useProjectStore.getState().summary,
    useCompositionScopeStore.getState().openId,
  );
}

/// The open composition, for React. Two atomic subscriptions rather than one
/// composite selector: each yields a stable reference (the id is a string, the
/// composition a sub-object of the summary), so an unrelated store tick bails
/// out instead of re-rendering.
export const useOpenComposition = (): CompositionSummary | null => {
  const openId = useCompositionScopeStore((s) => s.openId);
  return useProjectStore((s) => compositionOrRoot(s.summary, openId));
};

/// Resolve a media item by id without forcing the caller to subscribe
/// to the whole media array. The selector reads from `mediaById`, which
/// only changes when a `summary` apply runs.
export const useMediaById = (id: string | null | undefined): MediaSummary | undefined =>
  useProjectStore((s) => (id ? s.mediaById.get(id) : undefined));

/// The derived-`Group N` ordinals, for `layerDisplayName` / `groupDisplayName`.
/// One Map reference per summary, so a subscriber bails out on every unrelated
/// store tick.
export const useGroupOrdinals = (): ReadonlyMap<string, number> =>
  useProjectStore((s) => s.groupOrdinals);

/// Imperative twin, for the event-time callers (a context-menu row's label, a
/// command's status-log line).
export function currentGroupOrdinals(): ReadonlyMap<string, number> {
  return useProjectStore.getState().groupOrdinals;
}

/// A Group's SOURCE length: the referenced composition's `duration_us`, or null
/// when the summary does not carry it (a composition removed under a stale
/// clip). The bound trim clamps against and the clip's overhang hatch measures
/// from — `sourceWindowTail` reads "unknown" as "draw nothing".
export const useCompositionDurationUs = (
  compositionId: string | null,
): number | null =>
  useProjectStore((s) =>
    compositionId ? (s.summary?.compositions[compositionId]?.duration_us ?? null) : null,
  );

/// The media whose thumbnail stands in for a Group clip: the earliest-starting
/// video clip inside the composition, or inside a Group nested in it. Null when
/// the Group holds no video at all, which is when the clip falls back to its
/// kind glyph.
///
/// Recursive because a Group of Groups is the case where the answer is most
/// wanted and least reachable — and `seen`-guarded because a reference cycle is
/// a validated impossibility, not a structural one (`CompositionCycle`), and an
/// infinite walk here would hang the timeline rather than fail a commit.
function firstVideoMediaIdIn(
  summary: ProjectSummary | null,
  compositionId: string,
  seen: Set<string> = new Set(),
): string | null {
  if (!summary || seen.has(compositionId)) return null;
  seen.add(compositionId);
  const comp = summary.compositions[compositionId];
  if (!comp) return null;
  let earliest: { mediaId: string; tStartUs: number } | null = null;
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.params.kind !== "VideoClip") continue;
      if (earliest === null || layer.t_start_us < earliest.tStartUs) {
        earliest = { mediaId: layer.params.media_id, tStartUs: layer.t_start_us };
      }
    }
  }
  if (earliest !== null) return earliest.mediaId;
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.params.kind !== "CompositionRef") continue;
      const nested = firstVideoMediaIdIn(summary, layer.params.composition_id, seen);
      if (nested !== null) return nested;
    }
  }
  return null;
}

export const useFirstVideoMediaIdIn = (
  compositionId: string | null,
): string | null =>
  useProjectStore((s) =>
    compositionId ? firstVideoMediaIdIn(s.summary, compositionId) : null,
  );

// Reused empty sentinels so `?? []` doesn't allocate a fresh array on
// every render (which would defeat referential-equality short-circuits
// in any caller doing `useShallow` over derived combinations).
const EMPTY_ROLES: RoleMixView[] = [];
const EMPTY_MARKERS: MarkerSummary[] = [];
