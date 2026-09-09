// What is described, per source — the state behind the shot rows' text column
// and behind the search index's description entries.
//
// Deliberately separate from `projectStore`, for `shotsStore`'s reason: a
// description belongs to a source rather than to the project, and folding it
// into the summary would strap the read onto the refetch that runs on every
// edit whether a Panel is open or not.
//
// LIFETIME IS THE PROJECT'S, not any Panel's: the palette indexes these, and a
// search corpus that emptied whenever the Shots Panel closed would be a corpus
// nobody could rely on. Invalidation is therefore per source and belongs to
// `syncDescriptions` — a relink points one media id at different footage, and
// that, not a Panel unmount, is what makes an answer wrong.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: reading a description never computes
// one. `hydrateDescription` goes through `getMediaDescription`, which reports a
// cache miss; `describeClip` spends a run against a local 2.5 GB model and is
// reachable only from a deliberate press — the describe command, or one of the
// Shots Panel's buttons — never from a read on this module's path.

import { create } from "zustand";

import { getMediaDescription, type DescSegment } from "../ipc";
import { LatestRequestCoordinator } from "../state/latestRequest";

/// The window a run is going against: a source id and a source-time span.
///
/// A SPAN and not just a media id, because a run is now scoped to one shot as
/// often as to a whole clip — and a per-shot run that greyed every row of the
/// column would report work on thirty shots that nobody asked for. The span is
/// in source time, which is the domain the rows and the cache already share, so
/// "is this row waiting" is the same intersection the prose itself is found by.
export interface DescribingSpan {
  mediaId: string;
  srcStartUs: number;
  srcEndUs: number;
}

interface DescriptionsState {
  /// Segments by media id. A present `null` means the read came back with
  /// nothing — known not described, as opposed to an absent key, which means
  /// nobody has asked yet. Both render as "not described"; the distinction is
  /// what keeps `hydrateDescription` from re-reading a source it has an answer
  /// for.
  segments: ReadonlyMap<string, readonly DescSegment[] | null>;
  /// The window a description run is going against, or null. Read by the rows:
  /// a cell with nothing to show says whether one is on its way.
  ///
  /// ONE at a time, and that is a property of the runs rather than of this
  /// field: every entry point checks it before starting, because the engine is
  /// a local 2.5 GB model and two concurrent spawns would contend for the same
  /// VRAM to answer half as fast.
  describing: DescribingSpan | null;
  /// The last run's failure, for the Shots Panel's own slot — the engine's
  /// sentence verbatim, or `""`.
  ///
  /// Here rather than on `shotsStore.error`, whose one slot is documented as
  /// exclusive between the scan, a measurement and an apply. A describe run is
  /// none of those and greys none of them, so it would be the first thing able
  /// to overwrite a refusal the reviewer had not read yet.
  ///
  /// Not surfaced by the DIALOG, which keeps its own inline copy: it stays open
  /// on a failure so the parameters survive, and it owns the one remedy button.
  error: string;
  /// A shot-by-shot sweep's progress, or null when none is running.
  ///
  /// Separate from `describing`, which goes null between the sweep's runs — a
  /// counter is the only honest progress a sweep of N local model runs
  /// has, and without it the button would blink back to its idle label between
  /// shots. `done` counts FINISHED runs, so it reads 0 while the first is going.
  batch: { done: number; total: number } | null;
}

const INITIAL: DescriptionsState = {
  segments: new Map(),
  describing: null,
  error: "",
  batch: null,
};

export const useDescriptionsStore = create<DescriptionsState>(() => ({
  ...INITIAL,
}));

/// One coordinator for the SUBJECT reads, so a slower answer for a source the
/// user has navigated away from cannot publish over the newest one.
const reads = new LatestRequestCoordinator();

/// Sources with a read in the air. The idempotence guard the rest of this
/// module states over `segments` only closes once an answer has landed, so
/// without this a Panel selecting a clip while the index is sweeping the pool
/// would probe the same source twice.
const inFlight = new Set<string>();

/// The file each answered source pointed at when it was last looked at.
/// `segments` is keyed by media id, and a relink keeps the id while changing
/// the footage — see `syncDescriptions`, which owns that rule.
const readAtPath = new Map<string, string>();

function put(
  mediaId: string,
  value: readonly DescSegment[] | null,
): void {
  const next = new Map(useDescriptionsStore.getState().segments);
  next.set(mediaId, value);
  useDescriptionsStore.setState({ segments: next });
}

/// Read one source's cached description, under the view the app's settings name.
/// Idempotent on a source already answered for, so the Panel may call it from an
/// effect.
///
/// NEVER calls `describeClip`: opening the Panel on an undescribed clip must
/// cost a cache probe and not a model run.
export async function hydrateDescription(mediaId: string): Promise<void> {
  if (useDescriptionsStore.getState().segments.has(mediaId)) return;
  if (inFlight.has(mediaId)) return;
  inFlight.add(mediaId);
  try {
    await reads.run(
      () => getMediaDescription(mediaId),
      (cache) => put(mediaId, cache === null ? null : cache.segments),
    );
  } catch (err) {
    // A read that cannot even be asked leaves the column saying "not
    // described" — the honest answer, since nothing is known to be on disk.
    // Recorded and not surfaced: a description is an extra on a row that is
    // legible without it, and the status log is where a describe failure belongs.
    console.warn("[descriptionsStore] description read failed", err);
    put(mediaId, null);
  } finally {
    inFlight.delete(mediaId);
  }
}

/// Bring the store in line with the project's video sources: what the search
/// index needs, which is every source's cached prose rather than one Panel's
/// subject. `sources` maps media id to the file that id points at now.
///
/// THE RELINK RULE LIVES HERE, with the key it is about. A relink keeps the
/// media id and changes the footage, and the description cache belongs to the
/// file — so a source whose path has moved under us forgets its answer and
/// reads again, and a source that has left the project is dropped rather than
/// indexed forever. An id nobody has recorded a path for yet is left alone: a
/// first sight is not a relink.
///
/// NOT through `reads`: that coordinator lets only the newest request publish,
/// which is right for one subject replacing another and wrong for a fan-out —
/// every answer here is about a different source and lands under its own key,
/// so all of them must publish. `inFlight` is the guard a fan-out does need.
///
/// NEVER calls `describeClip`, for `hydrateDescription`'s reason: the palette
/// must cost a cache probe per source and not a model run.
export async function syncDescriptions(
  sources: ReadonlyMap<string, string>,
): Promise<void> {
  const stale = [...readAtPath].filter(([id, path]) => sources.get(id) !== path);
  if (stale.length > 0) {
    // One new map for the whole batch: each `setState` is a store tick, and
    // the index marks itself dirty on every one of them.
    const next = new Map(useDescriptionsStore.getState().segments);
    for (const [id] of stale) {
      next.delete(id);
      readAtPath.delete(id);
    }
    useDescriptionsStore.setState({ segments: next });
  }
  for (const [id, path] of sources) readAtPath.set(id, path);
  await Promise.all(
    [...sources.keys()].map(async (mediaId) => {
      if (useDescriptionsStore.getState().segments.has(mediaId)) return;
      if (inFlight.has(mediaId)) return;
      inFlight.add(mediaId);
      try {
        const cache = await getMediaDescription(mediaId);
        put(mediaId, cache === null ? null : cache.segments);
      } catch (err) {
        // Same answer a failed subject read gives — nothing is known to be on
        // disk, so nothing is indexed. Recorded and not surfaced: a palette
        // missing a row it could not have known about is not a refusal.
        console.warn("[descriptionsStore] description sweep read failed", err);
        put(mediaId, null);
      } finally {
        inFlight.delete(mediaId);
      }
    }),
  );
}

/// Forget every held description because the VIEW changed, then read them all
/// again under the new one.
///
/// This store mirrors `media://{id}/description`, which serves ONE view. Change
/// the sampling, the focus or the interface language and every segment held here
/// belongs to a view nobody is asking for any more — so without this the rows go
/// on showing the previous view's prose, which is the exact failure
/// `vlm::cache_key` puts all three in the key to prevent, one layer up.
///
/// Clears the SEGMENTS only. Run state (`describing`, `batch`) is deliberately
/// untouched: with no dialog holding the window, a setting can be changed while
/// a run is in flight, and dropping the in-flight flag would let the gate go
/// live and a second model spawn start beside the first.
///
/// Takes its sources the way `syncDescriptions` does, so this module still knows
/// nothing about the project store — `search/searchIndexStore.ts` owns that
/// projection and the one-line caller that uses it.
export async function resyncDescriptionsForView(
  sources: ReadonlyMap<string, string>,
): Promise<void> {
  readAtPath.clear();
  useDescriptionsStore.setState({ segments: new Map() });
  await syncDescriptions(sources);
}

/// Re-read one source past the idempotence guard — what a finished run calls.
///
/// A run answers for the window it was asked about, and the cache on disk holds
/// every window ever described of that source; re-reading is how a clip's rows
/// pick up prose an earlier run on a neighbouring clip of the same source
/// produced.
///
/// Publishes only a non-empty answer. A `null` here would mean the read could
/// not see what the run just wrote, and dropping prose already on screen for
/// that is strictly worse than a column that is one window behind.
export async function reloadDescription(mediaId: string): Promise<void> {
  try {
    await reads.run(
      () => getMediaDescription(mediaId),
      (cache) => {
        if (cache !== null) put(mediaId, cache.segments);
      },
    );
  } catch (err) {
    console.warn("[descriptionsStore] description re-read failed", err);
  }
}

/// Publish a finished run's segments OVER the window it answered for, keeping
/// everything outside that window.
///
/// The optimistic fill, and only that: it shows the prose the moment the model
/// is done, and `reloadDescription` widens it a round trip later. There is no
/// longer a setting at which a run lands in a view no read can find — main
/// injects the view into both sides of the cache key — so this is a head start
/// on the disk copy, never the only one.
///
/// WINDOWED, and it has to be: a run against one shot answers for that shot's
/// span alone, so a whole-map replace would delete the prose of every other shot
/// of the source — and of every other clip cut from it. The replace-intersecting
/// rule and the half-open predicate are Rust's `DescriptionCache::merge_window`
/// and `segments_in`, deliberately: this is an OVERLAY on the same cache, and an
/// overlay that folded segments differently from the file underneath it would
/// flicker on the reload that follows. Authority stays on disk; `reloadDescription`
/// is what publishes it.
export function mergeDescription(
  mediaId: string,
  srcStartUs: number,
  srcEndUs: number,
  fresh: readonly DescSegment[],
): void {
  const prior = useDescriptionsStore.getState().segments.get(mediaId) ?? [];
  const kept = prior.filter(
    (s) => !(s.t_start_us < srcEndUs && s.t_end_us > srcStartUs),
  );
  put(
    mediaId,
    [...kept, ...fresh].sort((a, b) => a.t_start_us - b.t_start_us),
  );
}

export function setDescribing(span: DescribingSpan | null): void {
  useDescriptionsStore.setState({ describing: span });
}

export function setDescribeError(error: string): void {
  useDescriptionsStore.setState({ error });
}

export function setDescribeBatch(
  batch: { done: number; total: number } | null,
): void {
  useDescriptionsStore.setState({ batch });
}

/// Forget everything — the state every test of this module starts from, and
/// the hook a hard project boundary would take.
///
/// NOT a Panel-close hook, and no production caller needs it today: the palette
/// indexes what is held here, so the map outlives the Shots Panel by design,
/// and a project switch already cleans itself through `syncDescriptions` —
/// none of the outgoing project's sources appear among the incoming one's, so
/// each is dropped by the same rule that catches a relink.
export function resetDescriptionsStore(): void {
  reads.invalidate();
  inFlight.clear();
  readAtPath.clear();
  // `INITIAL.segments` is never mutated — every write above builds a new map —
  // so restoring it by reference keeps the selectors from re-rendering on a
  // reset that changed nothing.
  useDescriptionsStore.setState({ ...INITIAL });
}

// ===== Atomic selector helpers ============================================
// One subscription each, every one yielding a stable reference: a selector that
// built a fresh array would re-render on every store tick and eventually loop
// (`feedback_zustand_composite_selector`).

/// One source's segments, or `null` when there are none to show — whether
/// because the read said so or because nobody has asked yet. A cell has one
/// empty state, so the two collapse here rather than in the component.
export const useDescription = (
  mediaId: string | null,
): readonly DescSegment[] | null =>
  useDescriptionsStore((s) =>
    mediaId === null ? null : s.segments.get(mediaId) ?? null,
  );

export const useDescribing = (): DescribingSpan | null =>
  useDescriptionsStore((s) => s.describing);

export const useDescribeError = (): string =>
  useDescriptionsStore((s) => s.error);

export const useDescribeBatch = (): { done: number; total: number } | null =>
  useDescriptionsStore((s) => s.batch);

/// Whether a run is going against a window that OVERLAPS `[srcStartUs, srcEndUs)`
/// of `mediaId` — what one row asks to decide whether it is waiting.
///
/// The same half-open intersection `segmentsForSpan` finds prose by, so a row
/// that will receive the run's answer is exactly a row that says it is waiting.
/// A whole-clip run therefore lights every row of that clip, and a per-shot run
/// lights the one shot plus any neighbour the span reaches into.
export function isDescribingSpan(
  describing: DescribingSpan | null,
  mediaId: string,
  srcStartUs: number,
  srcEndUs: number,
): boolean {
  return (
    describing !== null &&
    describing.mediaId === mediaId &&
    describing.srcStartUs < srcEndUs &&
    describing.srcEndUs > srcStartUs
  );
}
