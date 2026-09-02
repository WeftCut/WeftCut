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
// cache miss; `describeClip` spends ~20 s against a local 2.5 GB model and is
// reachable only from the describe dialog, which one deliberate press opens.

import { create } from "zustand";

import { getMediaDescription, type DescSegment } from "../ipc";
import { LatestRequestCoordinator } from "../state/latestRequest";

interface DescriptionsState {
  /// Segments by media id. A present `null` means the read came back with
  /// nothing — known not described, as opposed to an absent key, which means
  /// nobody has asked yet. Both render as "not described"; the distinction is
  /// what keeps `hydrateDescription` from re-reading a source it has an answer
  /// for.
  segments: ReadonlyMap<string, readonly DescSegment[] | null>;
  /// The media id a description run is going against, or null. Read by the
  /// rows: a cell with nothing to show says whether one is on its way.
  describing: string | null;
}

const INITIAL: DescriptionsState = {
  segments: new Map(),
  describing: null,
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

/// Read one source's cached description — the default view, which is the only
/// one that survives a session. Idempotent on a source already answered for, so
/// the Panel may call it from an effect.
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
    // legible without it, and the dialog is where a describe failure belongs.
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

/// Re-read one source past the idempotence guard — what a finished DEFAULT-view
/// run calls.
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

/// Publish a finished run's segments. Authoritative for a run at a NON-default
/// sampling or focus, which no read can find — that view is not the one
/// `media://{id}/description` serves, which is what the dialog says out loud.
/// At the default view it is the optimistic fill that shows the prose the moment
/// the model is done, and `reloadDescription` widens it a round trip later.
export function setDescription(
  mediaId: string,
  segments: readonly DescSegment[],
): void {
  put(mediaId, segments);
}

export function setDescribing(mediaId: string | null): void {
  useDescriptionsStore.setState({ describing: mediaId });
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

export const useDescribing = (): string | null =>
  useDescriptionsStore((s) => s.describing);
