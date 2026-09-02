// What is described, per source — the state behind the shot rows' text column.
//
// Deliberately separate from `projectStore`, for `shotsStore`'s reason: a
// description belongs to a source rather than to the project, and folding it
// into the summary would strap the read onto the refetch that runs on every
// edit whether a Panel is open or not.
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

/// One coordinator for the reads, so a slower answer for a source the user has
/// navigated away from cannot publish over the newest one.
const reads = new LatestRequestCoordinator();

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
  }
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

/// Back to the pre-open state. The map is keyed by media id and a relink points
/// that id at different footage, so a Panel that closes forgets rather than
/// trusting the join across a reopen.
export function resetDescriptionsStore(): void {
  reads.invalidate();
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
