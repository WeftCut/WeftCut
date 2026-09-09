// The store's one load-bearing rule: reading a description never computes one.
//
// A Panel asks for this on every subject change, and `describe_clip` spends a
// run against a local 2.5 GB model — so the assertion that the compute path is
// never touched is the point of this file, not a detail of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMediaDescription: vi.fn(),
  describeClip: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  getMediaDescription: mocks.getMediaDescription,
  describeClip: mocks.describeClip,
}));

import type { DescriptionCache } from "../ipc";
import {
  hydrateDescription,
  reloadDescription,
  resetDescriptionsStore,
  isDescribingSpan,
  mergeDescription,
  resyncDescriptionsForView,
  setDescribing,
  syncDescriptions,
  useDescriptionsStore,
} from "./descriptionsStore";

const CACHE: DescriptionCache = {
  covered_ranges: [[0, 6_000_000]],
  segments: [
    { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: ["interior"] },
  ],
};

function held(mediaId: string) {
  return useDescriptionsStore.getState().segments.get(mediaId);
}

describe("descriptionsStore", () => {
  beforeEach(() => {
    mocks.getMediaDescription.mockReset().mockResolvedValue(CACHE);
    mocks.describeClip.mockReset();
    resetDescriptionsStore();
  });
  afterEach(resetDescriptionsStore);

  it("hydrates from the cache read and never spends a model", async () => {
    await hydrateDescription("m-1");
    expect(mocks.getMediaDescription).toHaveBeenCalledWith("m-1");
    expect(mocks.describeClip).not.toHaveBeenCalled();
    expect(held("m-1")).toEqual(CACHE.segments);
  });

  // `null` is an ANSWER — this source has nothing under the current view — and it
  // has to be held, or the Panel would re-read on every render.
  it("records a source with nothing described, and does not ask twice", async () => {
    mocks.getMediaDescription.mockResolvedValue(null);
    await hydrateDescription("m-1");
    expect(held("m-1")).toBeNull();
    await hydrateDescription("m-1");
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);
  });

  it("does not re-read a source it already has segments for", async () => {
    await hydrateDescription("m-1");
    await hydrateDescription("m-1");
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);
  });

  // A read that cannot even be asked leaves the column saying "not described" —
  // the honest answer — rather than throwing into a Panel render.
  it("records a failed read as not described instead of throwing", async () => {
    mocks.getMediaDescription.mockRejectedValue(new Error("no workspace"));
    await expect(hydrateDescription("m-1")).resolves.toBeUndefined();
    expect(held("m-1")).toBeNull();
  });

  it("re-reads past its own idempotence guard, and still spends no model", async () => {
    await hydrateDescription("m-1");
    await reloadDescription("m-1");
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(2);
    expect(mocks.describeClip).not.toHaveBeenCalled();
  });

  // A read that cannot see what a run just wrote must not take the prose off
  // the screen — a column one window behind beats a column that emptied.
  it("keeps what it holds when a re-read finds nothing", async () => {
    mergeDescription("m-1", 0, 6_000_000, CACHE.segments);
    mocks.getMediaDescription.mockResolvedValue(null);
    await reloadDescription("m-1");
    expect(held("m-1")).toEqual(CACHE.segments);
  });

  it("publishes a finished run's segments directly", () => {
    mergeDescription("m-1", 0, 6_000_000, CACHE.segments);
    expect(held("m-1")).toEqual(CACHE.segments);
  });

  // The rule a per-shot run needs and a whole-clip run never exercised: a run
  // answers for ONE window, so publishing it must leave every other shot's
  // prose — and every other clip's, cut from the same source — where it was.
  it("merges a window's segments and keeps the ones outside it", () => {
    const early = { t_start_us: 0, t_end_us: 1_000_000, text: "a hallway", tags: [] };
    const late = { t_start_us: 8_000_000, t_end_us: 9_000_000, text: "a kitchen", tags: [] };
    mergeDescription("m-1", 0, 10_000_000, [early, late]);
    const fresh = { t_start_us: 8_000_000, t_end_us: 9_000_000, text: "a galley", tags: [] };
    mergeDescription("m-1", 8_000_000, 9_000_000, [fresh]);
    expect(held("m-1")).toEqual([early, fresh]);
  });

  // Sorted by start, whatever order the windows were described in — the rows
  // read this list through `segmentsForSpan`, which sorts too, but the search
  // index reads it raw.
  it("keeps the merged list in time order", () => {
    const late = { t_start_us: 8_000_000, t_end_us: 9_000_000, text: "late", tags: [] };
    const early = { t_start_us: 0, t_end_us: 1_000_000, text: "early", tags: [] };
    mergeDescription("m-1", 8_000_000, 9_000_000, [late]);
    mergeDescription("m-1", 0, 1_000_000, [early]);
    expect(held("m-1")?.map((s) => s.text)).toEqual(["early", "late"]);
  });

  // A segment that merely TOUCHES the window's edge lies outside it — the same
  // half-open predicate `segmentsForSpan` and Rust's `segments_in` use, so an
  // overlay cannot fold a segment differently from the file underneath it.
  it("leaves a segment that only touches the window's edge", () => {
    const abutting = { t_start_us: 0, t_end_us: 2_000_000, text: "before", tags: [] };
    mergeDescription("m-1", 0, 2_000_000, [abutting]);
    mergeDescription("m-1", 2_000_000, 4_000_000, []);
    expect(held("m-1")).toEqual([abutting]);
  });

  it("carries the in-flight window for the rows to read", () => {
    expect(useDescriptionsStore.getState().describing).toBeNull();
    const span = { mediaId: "m-1", srcStartUs: 2_000_000, srcEndUs: 4_000_000 };
    setDescribing(span);
    expect(useDescriptionsStore.getState().describing).toEqual(span);
    setDescribing(null);
    expect(useDescriptionsStore.getState().describing).toBeNull();
  });

  // The rows' own question, and the reason `describing` is a span at all: a
  // per-shot run must not report work on the rows it will not answer for.
  it("says a row is waiting only when the run's window reaches it", () => {
    const span = { mediaId: "m-1", srcStartUs: 2_000_000, srcEndUs: 4_000_000 };
    expect(isDescribingSpan(span, "m-1", 2_000_000, 4_000_000)).toBe(true);
    // Overlaps by a hair — the run's answer will land on this row too.
    expect(isDescribingSpan(span, "m-1", 3_999_999, 6_000_000)).toBe(true);
    // Touches the edge only: half-open, so it is outside.
    expect(isDescribingSpan(span, "m-1", 4_000_000, 6_000_000)).toBe(false);
    expect(isDescribingSpan(span, "m-1", 0, 2_000_000)).toBe(false);
    // Another source entirely.
    expect(isDescribingSpan(span, "m-2", 2_000_000, 4_000_000)).toBe(false);
    expect(isDescribingSpan(null, "m-1", 2_000_000, 4_000_000)).toBe(false);
  });

  // A project boundary, and the state every test in this file starts from —
  // NOT a Panel close, which the search index goes on reading this map past.
  it("forgets everything on reset", async () => {
    await hydrateDescription("m-1");
    setDescribing({ mediaId: "m-1", srcStartUs: 0, srcEndUs: 1 });
    resetDescriptionsStore();
    expect(held("m-1")).toBeUndefined();
    expect(useDescriptionsStore.getState().describing).toBeNull();
  });
});

// The project-wide sweep behind the search palette: many sources at once,
// where `hydrateDescription` serves one Panel subject.
describe("syncDescriptions", () => {
  beforeEach(() => {
    mocks.getMediaDescription.mockReset().mockResolvedValue(CACHE);
    mocks.describeClip.mockReset();
    resetDescriptionsStore();
  });
  afterEach(resetDescriptionsStore);

  // Every answer is about a different source and lands under its own key, so
  // all of them must publish — which is why this path cannot go through the
  // latest-request coordinator the subject read uses.
  it("publishes an answer for every source in the sweep, and spends no model", async () => {
    await syncDescriptions(new Map([["m-1", "a.mp4"], ["m-2", "b.mp4"]]));
    expect(held("m-1")).toEqual(CACHE.segments);
    expect(held("m-2")).toEqual(CACHE.segments);
    expect(mocks.describeClip).not.toHaveBeenCalled();
  });

  it("asks once per source across repeated sweeps", async () => {
    const sources = new Map([["m-1", "a.mp4"]]);
    await syncDescriptions(sources);
    await syncDescriptions(sources);
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);
  });

  // A relink keeps the media id and changes the footage, and the description
  // cache belongs to the FILE — so the held answer is about material that is
  // no longer there.
  it("forgets and re-reads a source whose file has moved under it", async () => {
    await syncDescriptions(new Map([["m-1", "a.mp4"]]));
    mocks.getMediaDescription.mockResolvedValue(null);
    await syncDescriptions(new Map([["m-1", "relinked.mp4"]]));
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(2);
    expect(held("m-1")).toBeNull();
  });

  it("drops a source that has left the project", async () => {
    await syncDescriptions(new Map([["m-1", "a.mp4"], ["m-2", "b.mp4"]]));
    await syncDescriptions(new Map([["m-2", "b.mp4"]]));
    expect(held("m-1")).toBeUndefined();
    expect(held("m-2")).toEqual(CACHE.segments);
  });

  // The subject read's own idempotence guard closes only once an answer has
  // landed, so the two paths need a guard that closes at the request.
  it("does not race the Panel's own read for the same source", async () => {
    let release = (): void => {};
    mocks.getMediaDescription.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(CACHE);
      }),
    );
    const subject = hydrateDescription("m-1");
    const sweep = syncDescriptions(new Map([["m-1", "a.mp4"]]));
    release();
    await Promise.all([subject, sweep]);
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);
    expect(held("m-1")).toEqual(CACHE.segments);
  });

  // Nothing described is the ordinary state, and it is an ANSWER — held, so a
  // sweep on the next edit does not ask the whole pool again.
  it("records a source with nothing described and stops asking", async () => {
    mocks.getMediaDescription.mockResolvedValue(null);
    const sources = new Map([["m-1", "a.mp4"]]);
    await syncDescriptions(sources);
    await syncDescriptions(sources);
    expect(held("m-1")).toBeNull();
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);
  });

  it("records a failed read as not described instead of throwing", async () => {
    mocks.getMediaDescription.mockRejectedValue(new Error("no workspace"));
    await expect(
      syncDescriptions(new Map([["m-1", "a.mp4"]])),
    ).resolves.toBeUndefined();
    expect(held("m-1")).toBeNull();
  });
});

// A change to the sampling, the focus or the interface language re-keys the
// cache this store mirrors, so everything held becomes an answer to a question
// nobody is asking. Caught in the real app: with the Shots Panel open, changing
// the focus left the rows showing the previous view's prose.
describe("resyncDescriptionsForView", () => {
  beforeEach(() => {
    mocks.getMediaDescription.mockReset().mockResolvedValue(CACHE);
    mocks.describeClip.mockReset();
    resetDescriptionsStore();
  });
  afterEach(resetDescriptionsStore);

  it("drops what is held and reads every source again", async () => {
    await hydrateDescription("m-1");
    expect(held("m-1")).toEqual(CACHE.segments);
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);

    // The other view's answer, so a stale hold is visible as a wrong value
    // rather than as an absent one.
    const other = [
      { t_start_us: 0, t_end_us: 2_000_000, text: "wide, static", tags: ["wide"] },
    ];
    mocks.getMediaDescription.mockResolvedValue({ covered_ranges: [[0, 6_000_000]], segments: other });
    await resyncDescriptionsForView(new Map([["m-1", "/a/reel.mp4"]]));

    expect(held("m-1")).toEqual(other);
    // Past the idempotence guard: `syncDescriptions` alone would have seen the
    // id already held and read nothing.
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(2);
    // Never the compute path, this module's one rule.
    expect(mocks.describeClip).not.toHaveBeenCalled();
  });

  // With no dialog holding the window, a setting can be changed WHILE a run is
  // in flight. Dropping the flag would let the gate go live and a second local
  // model spawn start beside the first.
  it("leaves run state alone", async () => {
    const span = { mediaId: "m-1", srcStartUs: 0, srcEndUs: 2_000_000 };
    setDescribing(span);
    await resyncDescriptionsForView(new Map([["m-1", "/a/reel.mp4"]]));
    expect(useDescriptionsStore.getState().describing).toEqual(span);
    expect(isDescribingSpan(useDescriptionsStore.getState().describing, "m-1", 0, 1_000)).toBe(true);
  });

  // …but what that run PRODUCES is about the view it started under. Merging it
  // would put back exactly the prose the resync dropped — the stale-view failure
  // again, one model run late. The optimistic fill is only ever a head start on
  // the disk copy, so skipping it costs nothing: `reloadDescription` behind it
  // reads the view the rows are actually asking about.
  it("drops a run's optimistic fill when the view moved while it was in flight", async () => {
    const stale = [
      { t_start_us: 0, t_end_us: 2_000_000, text: "from the view just left", tags: [] },
    ];
    setDescribing({ mediaId: "m-1", srcStartUs: 0, srcEndUs: 2_000_000 });
    mocks.getMediaDescription.mockResolvedValue(null);
    await resyncDescriptionsForView(new Map([["m-1", "/a/reel.mp4"]]));
    expect(held("m-1")).toBeNull();

    setDescribing(null);
    mergeDescription("m-1", 0, 2_000_000, stale);
    expect(held("m-1")).toBeNull();
  });

  // A read already in the air answers about the view being left too, and it
  // lands AFTER the resync has finished — the one ordering the segment clear
  // cannot cover on its own.
  it("drops a read issued before the view changed", async () => {
    const stale: DescriptionCache = {
      covered_ranges: [[0, 6_000_000]],
      segments: [{ t_start_us: 0, t_end_us: 2_000_000, text: "old view", tags: [] }],
    };
    let settle: (c: DescriptionCache) => void = () => {};
    mocks.getMediaDescription.mockReturnValueOnce(
      new Promise<DescriptionCache>((res) => { settle = res; }),
    );
    const pending = hydrateDescription("m-1");

    mocks.getMediaDescription.mockResolvedValue(null);
    await resyncDescriptionsForView(new Map([["m-1", "/a/reel.mp4"]]));
    // The resync issued its OWN read for the source, rather than seeing an entry
    // in flight and skipping it — the guard must not outlive the view it belongs
    // to, or the source would never be re-read at all.
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(2);
    expect(held("m-1")).toBeNull();

    settle(stale);
    await pending;
    expect(held("m-1")).toBeNull();
  });
});
