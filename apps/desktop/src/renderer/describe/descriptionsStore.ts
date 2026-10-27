// What is described, per source and purpose. Clip content feeds its own panel
// section and search; shot descriptions feed only the shot rows. Result maps
// and subject-read coordinators are separate; model run admission is shared.
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

import { getMediaDescription, type DescSegment, type DescriptionCache, type RunSummary } from "../ipc";
import { LatestRequestCoordinator } from "../state/latestRequest";
import type { DescriptionPurpose } from "../../shared/description";

/// The window a run is going against: a source id and a source-time span.
///
/// A SPAN and not just a media id, because a run is now scoped to one shot as
/// often as to a whole clip — and a per-shot run that greyed every row of the
/// column would report work on thirty shots that nobody asked for. The span is
/// in source time, which is the domain the rows and the cache already share, so
/// "is this row waiting" is the same intersection the prose itself is found by.
export interface DescribingSpan {
  purpose?: DescriptionPurpose;
  mediaId: string;
  srcStartUs: number;
  srcEndUs: number;
  /// The run's call tag (ADR 0121): `useComputeJobForRequest` turns it into the
  /// job the run started or joined, and that job's phase.
  requestId?: string;
}

interface DescriptionsState {
  /// Clip content by media id. A present `null` means the read came back with
  /// nothing — known not described, as opposed to an absent key, which means
  /// nobody has asked yet. Both render as "not described"; the distinction is
  /// what keeps `hydrateDescription` from re-reading a source it has an answer
  /// for.
  segments: ReadonlyMap<string, readonly DescSegment[] | null>;
  /// Individual-shot results only; never fall back to clip content.
  shotSegments: ReadonlyMap<string, readonly DescSegment[] | null>;
  /// Clip content's run summaries by media id, newest first, published with
  /// `segments` from the same read. Shots have none.
  summaries: ReadonlyMap<string, readonly RunSummary[]>;
  /// The window a description run is going against, or null. Read by the rows:
  /// a cell with nothing to show says whether one is on its way.
  ///
  /// ONE at a time, and that is a property of the runs rather than of this
  /// field: every entry point checks it before starting, because the engine is
  /// a local 2.5 GB model and two concurrent spawns would contend for the same
  /// VRAM to answer half as fast.
  describing: DescribingSpan | null;
  /// Last failure per purpose. The Shots Panel reads/clears only `shot`;
  /// clip failures are handled by the clip command and status log.
  errors: Readonly<Record<DescriptionPurpose, string>>;
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
  shotSegments: new Map(),
  summaries: new Map(),
  describing: null,
  errors: { clip: "", shot: "" },
  batch: null,
};

export const useDescriptionsStore = create<DescriptionsState>(() => ({
  ...INITIAL,
}));

/// One coordinator for the SUBJECT reads, so a slower answer for a source the
/// user has navigated away from cannot publish over the newest one.
const reads = new LatestRequestCoordinator();
const shotReads = new LatestRequestCoordinator();
// Remember requested shot views even while a read is in flight, so a settings
// change or relink can re-read them without waiting for a panel remount.
const requestedShots = new Set<string>();

function segmentsForPurpose(purpose: DescriptionPurpose) {
  const state = useDescriptionsStore.getState();
  return purpose === "shot" ? state.shotSegments : state.segments;
}

function readDescription(mediaId: string, purpose: DescriptionPurpose) {
  return purpose === "clip" ? getMediaDescription(mediaId) : getMediaDescription(mediaId, purpose);
}

/// Which view/source mapping the maps hold, as a counter. Bumped on settings
/// changes and relinks; captured by every read before it is issued and
/// compared before it publishes.
///
/// A read already in the air when the view changes answers about the view being
/// LEFT, and publishing that answer would put back exactly the prose the resync
/// just dropped — the stale-view failure again, one round trip late. Comparing
/// generations is how an answer says which question it was to.
let viewGeneration = 0;

/// The generation the run in flight started under. Read by `mergeDescription`,
/// which runs just AFTER `setDescribing(null)` — so this deliberately survives
/// that call rather than being cleared by it.
let runGeneration = 0;

/// Sources with a read in the air, and the generation that issued it. The
/// idempotence guard the rest of this module states over `segments` only closes
/// once an answer has landed, so without this a Panel selecting a clip while the
/// index is sweeping the pool would probe the same source twice.
///
/// The generation is what keeps it from becoming a BLOCK: after a view change
/// the read it names can no longer publish, so its entry must not stop the
/// resync from issuing the read that can.
const inFlight = new Map<string, number>();

/// Publish a read's answer only if the view it was asked under is still the one
/// the map holds: its segments, and — clip content only — its summaries, so the
/// two never come from different reads.
function putReadIfCurrent(
  generation: number,
  mediaId: string,
  cache: DescriptionCache | null,
  purpose: DescriptionPurpose = "clip",
): void {
  if (generation !== viewGeneration) return;
  put(mediaId, cache === null ? null : cache.segments, purpose);
  if (purpose === "clip") {
    const next = new Map(useDescriptionsStore.getState().summaries);
    const summaries = cache?.summaries ?? [];
    if (summaries.length === 0) next.delete(mediaId);
    else next.set(mediaId, summaries);
    useDescriptionsStore.setState({ summaries: next });
  }
}

/// The file each answered source pointed at when it was last looked at.
/// `segments` is keyed by media id, and a relink keeps the id while changing
/// the footage — see `syncDescriptions`, which owns that rule.
const readAtPath = new Map<string, string>();

function put(
  mediaId: string,
  value: readonly DescSegment[] | null,
  purpose: DescriptionPurpose = "clip",
): void {
  const next = new Map(segmentsForPurpose(purpose));
  next.set(mediaId, value);
  useDescriptionsStore.setState(purpose === "shot" ? { shotSegments: next } : { segments: next });
}

/// Read one source's cached description, under the view the app's settings name.
/// Idempotent on a source already answered for, so the Panel may call it from an
/// effect.
///
/// NEVER calls `describeClip`: opening the Panel on an undescribed clip must
/// cost a cache probe and not a model run.
export async function hydrateDescription(mediaId: string, purpose: DescriptionPurpose = "clip"): Promise<void> {
  if (purpose === "shot") requestedShots.add(mediaId);
  if (segmentsForPurpose(purpose).has(mediaId)) return;
  const generation = viewGeneration;
  const readKey = purpose === "clip" ? mediaId : `shot:${mediaId}`;
  if (inFlight.get(readKey) === generation) return;
  inFlight.set(readKey, generation);
  try {
    await (purpose === "shot" ? shotReads : reads).run(
      () => readDescription(mediaId, purpose),
      (cache) => putReadIfCurrent(generation, mediaId, cache, purpose),
    );
  } catch (err) {
    // A read that cannot even be asked leaves the column saying "not
    // described" — the honest answer, since nothing is known to be on disk.
    // Recorded and not surfaced: a description is an extra on a row that is
    // legible without it, and the status log is where a describe failure belongs.
    console.warn("[descriptionsStore] description read failed", err);
    putReadIfCurrent(generation, mediaId, null, purpose);
  } finally {
    if (inFlight.get(readKey) === generation) inFlight.delete(readKey);
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
    // Reject pending reads/runs from the previous source mapping. The sweep
    // below reissues missing reads under this generation for both purposes.
    viewGeneration += 1;
    // One new map for the whole batch: each `setState` is a store tick, and
    // the index marks itself dirty on every one of them.
    const next = new Map(useDescriptionsStore.getState().segments);
    const nextShots = new Map(useDescriptionsStore.getState().shotSegments);
    const nextSummaries = new Map(useDescriptionsStore.getState().summaries);
    for (const [id] of stale) {
      next.delete(id);
      nextShots.delete(id);
      nextSummaries.delete(id);
      readAtPath.delete(id);
      if (!sources.has(id)) requestedShots.delete(id);
    }
    useDescriptionsStore.setState({ segments: next, shotSegments: nextShots, summaries: nextSummaries });
  }
  for (const [id, path] of sources) readAtPath.set(id, path);
  const generation = viewGeneration;
  await Promise.all(
    [...sources.keys()].map(async (mediaId) => {
      if (useDescriptionsStore.getState().segments.has(mediaId)) return;
      if (inFlight.get(mediaId) === generation) return;
      inFlight.set(mediaId, generation);
      try {
        const cache = await getMediaDescription(mediaId);
        putReadIfCurrent(generation, mediaId, cache);
      } catch (err) {
        // Same answer a failed subject read gives — nothing is known to be on
        // disk, so nothing is indexed. Recorded and not surfaced: a palette
        // missing a row it could not have known about is not a refusal.
        console.warn("[descriptionsStore] description sweep read failed", err);
        putReadIfCurrent(generation, mediaId, null);
      } finally {
        if (inFlight.get(mediaId) === generation) inFlight.delete(mediaId);
      }
    }),
  );
  for (const id of requestedShots) {
    if (generation !== viewGeneration) return;
    if (sources.has(id)) await hydrateDescription(id, "shot");
  }
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
/// live and a second model spawn start beside the first. What that run PRODUCES
/// is a different matter — the generation bump below is what keeps its answer,
/// which is about the view being left, from landing on the rows.
///
/// Takes its sources the way `syncDescriptions` does, so this module still knows
/// nothing about the project store — `search/searchIndexStore.ts` owns that
/// projection and the one-line caller that uses it.
export async function resyncDescriptionsForView(
  sources: ReadonlyMap<string, string>,
): Promise<void> {
  viewGeneration += 1;
  readAtPath.clear();
  useDescriptionsStore.setState({ segments: new Map(), shotSegments: new Map(), summaries: new Map() });
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
export async function reloadDescription(mediaId: string, purpose: DescriptionPurpose = "clip"): Promise<void> {
  if (purpose === "shot") requestedShots.add(mediaId);
  const generation = viewGeneration;
  try {
    await (purpose === "shot" ? shotReads : reads).run(
      () => readDescription(mediaId, purpose),
      (cache) => {
        if (cache !== null) putReadIfCurrent(generation, mediaId, cache, purpose);
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
  purpose: DescriptionPurpose = "clip",
): void {
  // Dropped outright when the view moved while the run was in flight. A setting
  // can be changed mid-run — nothing holds the window any more — and these
  // segments answer the question that was asked at the press, not the one the
  // rows are asking now. `reloadDescription` behind it reads the new view, so
  // the row lands on the right answer rather than on a merge of two.
  if (runGeneration !== viewGeneration) return;
  if (purpose === "shot") requestedShots.add(mediaId);
  const prior = segmentsForPurpose(purpose).get(mediaId) ?? [];
  const kept = prior.filter(
    (s) => !(s.t_start_us < srcEndUs && s.t_end_us > srcStartUs),
  );
  put(
    mediaId,
    [...kept, ...fresh].sort((a, b) => a.t_start_us - b.t_start_us),
    purpose,
  );
}

export function setDescribing(span: DescribingSpan | null): void {
  // A run is pinned to the view it STARTED under, which is the view its answer
  // will be about — see `mergeDescription`. Recorded on the start alone: the
  // clear runs first on the way out, and zeroing it there would unpin the very
  // answer that is about to be merged.
  if (span !== null) runGeneration = viewGeneration;
  useDescriptionsStore.setState({ describing: span });
}

export function setDescribeError(purpose: DescriptionPurpose, error: string): void {
  useDescriptionsStore.setState((s) => ({ errors: { ...s.errors, [purpose]: error } }));
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
  shotReads.invalidate();
  requestedShots.clear();
  inFlight.clear();
  readAtPath.clear();
  // Bumped rather than zeroed: a read issued before the reset is still in the
  // air, and restarting the count would let its answer look current again.
  viewGeneration += 1;
  runGeneration = viewGeneration;
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
  purpose: DescriptionPurpose = "clip",
): readonly DescSegment[] | null =>
  useDescriptionsStore((s) =>
    mediaId === null ? null : (purpose === "shot" ? s.shotSegments : s.segments).get(mediaId) ?? null,
  );

const NO_SUMMARIES: readonly RunSummary[] = [];

/// One source's clip-content summaries, newest first; a stable empty list when
/// there are none.
export const useClipSummaries = (mediaId: string | null): readonly RunSummary[] =>
  useDescriptionsStore((s) => (mediaId === null ? NO_SUMMARIES : s.summaries.get(mediaId) ?? NO_SUMMARIES));

/// The summary a clip's content section leads with: the run over exactly the
/// clip's `[srcInUs, srcOutUs]` window, else the newest one whose window covers
/// it (a wider clip of the same source), else none — a narrower run's summary
/// does not speak for the whole clip.
export function summaryForWindow(
  summaries: readonly RunSummary[],
  srcInUs: number,
  srcOutUs: number,
): string | null {
  const exact = summaries.find((s) => s.window[0] === srcInUs && s.window[1] === srcOutUs);
  if (exact) return exact.text;
  const covering = summaries.find((s) => s.window[0] <= srcInUs && s.window[1] >= srcOutUs);
  return covering ? covering.text : null;
}

export const useDescribing = (): DescribingSpan | null =>
  useDescriptionsStore((s) => s.describing);

export const useDescribeError = (purpose: DescriptionPurpose): string =>
  useDescriptionsStore((s) => s.errors[purpose]);

export const useDescribeBatch = (): { done: number; total: number } | null =>
  useDescriptionsStore((s) => s.batch);

/// Whether a run is going against a window that OVERLAPS `[srcStartUs, srcEndUs)`
/// of `mediaId` — what one row asks to decide whether it is waiting.
///
/// The same half-open intersection `segmentsForSpan` finds prose by, so a row
/// that will receive the run's answer is exactly a row that says it is waiting.
/// The purpose must match too: clip content cannot make shot rows wait for
/// descriptions that will never be published to their cache.
export function isDescribingSpan(
  describing: DescribingSpan | null,
  mediaId: string,
  srcStartUs: number,
  srcEndUs: number,
  purpose: DescriptionPurpose = "clip",
): boolean {
  return (
    describing !== null &&
    (describing.purpose ?? "clip") === purpose &&
    describing.mediaId === mediaId &&
    describing.srcStartUs < srcEndUs &&
    describing.srcEndUs > srcStartUs
  );
}
