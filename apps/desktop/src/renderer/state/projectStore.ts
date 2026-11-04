import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { shareSnapshot } from './shareSnapshot';
import { listen, type UnlistenFn } from "@/bridge/events";
import { EDIT_TRACE_ARG, EditTrace, editTraceId } from '../../shared/editTrace';
import { reportAfterFrameOpportunity } from '../diagnostics/editTrace';

import {
  type CompositionSummary,
  type LayerSummary,
  type MarkerSummary,
  type MediaSummary,
  type ProjectSummary,
  type RoleMixView,
} from "../ipc";
import { compositionOrRoot, rootCompositionOf } from "../ipc/compositions";
import { compositionRefCounts } from "../lib/compositionRefs";
import { groupOrdinals } from "../lib/layerName";
import { mediaRefCounts } from "../lib/mediaRefs";
import {
  reconcileCompositionAnchors,
  useCompositionAnchorStore,
} from "./compositionAnchorStore";
import { restorePrecomposeSelection } from "./precomposeSelection";
import {
  retainCompositionSelection,
  retainGapSelection,
  retainLayerSelection,
  retainMediaSelection,
  retainTransitionSelection,
} from "./selectionStore";
import { isGapOn } from "../ripple/gap";
import { invokeRaw } from '../bridge/ipc';
import { PUBLICATION_BASE_ARG, type ProjectPublicationReply, type ProjectVersion } from '../../shared/projectPublication';
import {
  ProjectPublicationClient, attachProjectPublication,
  refreshActiveProjectPublication, settleActiveProjectPublication,
} from './projectPublication';
import { retainTrackViewState } from "./viewState";

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
  /// timeline tab and every search entry asks the same question, and the
  /// answer depends on the WHOLE composition set, not on the layer asking.
  groupOrdinals: ReadonlyMap<string, number>;
  /// `composition_id → ref_count` (`lib/compositionRefs.ts`). Indexed here for
  /// the same reason the ordinals are: the media pool's cards, the
  /// inspector and the Delete gate all ask it, the answer spans every
  /// composition, and a Map rebuilt per render would be a fresh reference on
  /// every store tick.
  compositionRefCounts: ReadonlyMap<string, number>;
  /// `media_id → ref_count` (`lib/mediaRefs.ts`) — the same index on the pool's
  /// other kind, indexed here for the same reasons.
  mediaRefCounts: ReadonlyMap<string, number>;
  /// True after the initial `project_publication` fetch + subscription is
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
const EMPTY_REF_COUNTS: ReadonlyMap<string, number> = new Map();

function buildIndices(summary: ProjectSummary | null): {
  mediaById: Map<string, MediaSummary>;
  layerById: Map<string, LayerSummary>;
  trackIdByLayerId: Map<string, string>;
  compositionIdByLayerId: Map<string, string>;
  compositionIdByTrackId: Map<string, string>;
  groupOrdinals: ReadonlyMap<string, number>;
  compositionRefCounts: ReadonlyMap<string, number>;
  mediaRefCounts: ReadonlyMap<string, number>;
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
    compositionRefCounts: summary
      ? compositionRefCounts(summary.compositions)
      : EMPTY_REF_COUNTS,
    mediaRefCounts: summary
      ? mediaRefCounts(summary.compositions)
      : EMPTY_REF_COUNTS,
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
>((set, get) => ({
  summary: null,
  mediaById: new Map(),
  layerById: new Map(),
  trackIdByLayerId: new Map(),
  compositionIdByLayerId: new Map(),
  compositionIdByTrackId: new Map(),
  groupOrdinals: EMPTY_ORDINALS,
  compositionRefCounts: EMPTY_REF_COUNTS,
  mediaRefCounts: EMPTY_REF_COUNTS,
  ready: false,

  apply: (summary) => {
    const previous = get();
    const indices = buildIndices(summary);
    // Index subscribers should wake only when their entries changed, too.
    for (const key of Object.keys(indices) as (keyof typeof indices)[]) {
      if (shallow(previous[key], indices[key])) Object.assign(indices, { [key]: previous[key] });
    }
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
    retainCompositionSelection(summary ? Object.keys(summary.compositions) : []);
    retainMediaSelection(indices.mediaById.keys());
    // The gap is re-derived, not looked up: it has no id, so "still there" means
    // the same span is still exactly a gap on the same lane.
    retainGapSelection((trackId) => {
      if (!summary) return null;
      for (const c of Object.values(summary.compositions)) {
        const track = c.tracks.find((t) => t.id === trackId);
        if (track !== undefined) return track.layers;
      }
      return null;
    }, isGapOn);
    // After the indices and the retained selections: the fallback switch this
    // may run clears the selection, and reads the summary just published.
    reconcileCompositionAnchors(summary);
    // After the reconcile, which is where a project change drops the outgoing
    // project's view state entirely — pruning it against the incoming
    // project's tracks would delete a document that is no longer ours.
    retainTrackViewState(indices.compositionIdByTrackId.keys());
    // After the switch, for the same reason: undoing a pre-compose from inside
    // the Group it created lands here having just cleared the selection, and
    // this is what puts the grouped layers back in it.
    restorePrecomposeSelection(summary);
  },
}));

/** Deliberate re-read, including derived filesystem availability at the same version. */
export const refreshProjectStore = refreshActiveProjectPublication;

/** Legacy onMutated callbacks join publication; they do not fetch another snapshot. */
export const settleProjectStore = settleActiveProjectPublication;

/** One workspace owner. Version ordering, coalescing and command barriers live
 * behind ProjectPublicationClient; UI consumers never sequence reads themselves. */
export async function wireProjectStore(): Promise<UnlistenFn> {
  let trace: EditTrace | undefined;
  const discardTrace = () => {
    if (trace) { trace.fact('applied', false); trace.report(false); trace = undefined; }
  };
  const client = new ProjectPublicationClient<ProjectSummary>({
    read: async (traceId, base) => {
      discardTrace();
      trace = traceId ? new EditTrace(traceId, 'renderer.refresh') : undefined;
      const end = trace?.span('summary_ipc');
      try {
        const args = { ...(traceId ? { [EDIT_TRACE_ARG]: traceId } : {}), ...(base === null ? {} : { [PUBLICATION_BASE_ARG]: base }) };
        const reply = await invokeRaw<ProjectPublicationReply<ProjectSummary>>('project_publication',
          Object.keys(args).length > 0 ? args : undefined);
        end?.();
        if ('patches' in reply) trace?.fact('patches', reply.patches.length);
        return reply;
      } catch (error) { end?.(false); discardTrace(); throw error; }
    },
    adopt: (held, next) => next?.project_id === held?.project_id ? shareSnapshot(held, next) : next,
    apply: (summary) => {
      if (trace) {
        trace.measure('store_apply', () => useProjectStore.getState().apply(summary));
        trace.fact('applied', true);
        reportAfterFrameOpportunity(trace);
        trace = undefined;
      } else useProjectStore.getState().apply(summary);
    },
    onError: (error) => {
      discardTrace();
      // A transport failure is not a closed project. Keep the last good view.
      useProjectStore.setState({ ready: true });
      console.error('[project publication]', error);
    },
  });
  const detach = attachProjectPublication(client);
  // Subscribe before seeding; a receipt can also request the same version.
  let unlisten: UnlistenFn;
  try {
    unlisten = await listen<{ publication: ProjectVersion; [EDIT_TRACE_ARG]?: unknown }>(
      'project:changed', event => client.observe(event.payload.publication,
        editTraceId(event.payload[EDIT_TRACE_ARG])));
  } catch (error) { detach(); client.stop(); throw error; }
  await client.settle().catch(() => {}); // onError retains/reports, later reads can recover
  return () => { detach(); client.stop(); discardTrace(); unlisten(); };
}

// ===== Atomic selector helpers ============================================
// Each returns ONE field (or a value derived from one field) so React's
// `useSyncExternalStore` doesn't infinite-loop on referential equality.

export const useProjectSummary = (): ProjectSummary | null =>
  useProjectStore((s) => s.summary);

export const useAudioRoles = (): RoleMixView[] =>
  useProjectStore((s) => s.summary?.audio_roles ?? EMPTY_ROLES);

/// One composition's markers — a marker lane paints the markers of the timeline
/// it belongs to, not of whichever timeline has focus. Reads through the empty
/// sentinel pre-workspace.
export const useCompositionMarkers = (
  compositionId: string | null,
): MarkerSummary[] => useComposition(compositionId)?.markers ?? EMPTY_MARKERS;

// ===== Compositions =========================================================

export { compositionOrRoot, rootCompositionOf };

/// Imperative read of the FOCUSED composition for event-time callers (shortcut
/// handlers, command predicates) — the non-hook twin of `useOpenComposition`.
export function currentOpenComposition(): CompositionSummary | null {
  return compositionOrRoot(
    useProjectStore.getState().summary,
    useCompositionAnchorStore.getState().focusedId,
  );
}

/// The FOCUSED composition — the one whose timeline Panel last held the
/// keyboard (`compositionAnchorStore.ts`), which is what the inspector, the
/// Playhead Panel and every timeline-scoped command act on. A timeline Panel
/// reads `useComposition` with its OWN id instead: it renders the composition
/// it is bound to whether or not it has focus.
///
/// Two atomic subscriptions rather than one composite selector: each yields a
/// stable reference (the id is a string, the composition a sub-object of the
/// summary), so an unrelated store tick bails out instead of re-rendering.
export const useOpenComposition = (): CompositionSummary | null => {
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) => compositionOrRoot(s.summary, focusedId));
};

/// One NAMED composition, for the Panels that carry their own id. `null` — the
/// timeline row the Dock builds before a summary names a root — reads as the
/// root, which is `compositionOrRoot`'s rule everywhere else too.
export const useComposition = (
  compositionId: string | null,
): CompositionSummary | null =>
  useProjectStore((s) => compositionOrRoot(s.summary, compositionId));

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

/// How many Groups the project holds — every composition but the root. A count,
/// not a list, so a subscriber re-renders only when one arrives or leaves.
export const useGroupCount = (): number =>
  useProjectStore((s) =>
    s.summary ? Object.keys(s.summary.compositions).length - 1 : 0,
  );

/// Reference counts per composition, for React. One Map reference per summary,
/// like the ordinals. `get(id) ?? 0` — an orphan has no entry.
export const useCompositionRefCounts = (): ReadonlyMap<string, number> =>
  useProjectStore((s) => s.compositionRefCounts);

/// Reference counts per media item, for React. One Map reference per summary,
/// like the composition twin. `get(id) ?? 0` — an unplaced item has no entry,
/// and that is the ordinary case, not a defect (`lib/mediaRefs.ts`).
export const useMediaRefCounts = (): ReadonlyMap<string, number> =>
  useProjectStore((s) => s.mediaRefCounts);

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
