// The store's one load-bearing rule: reading a description never computes one.
//
// A Panel asks for this on every subject change, and `describe_clip` spends
// ~20 s against a local 2.5 GB model — so the assertion that the compute path
// is never touched is the point of this file, not a detail of it.

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
  setDescribing,
  setDescription,
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

  // `null` is an ANSWER — this source has nothing at the default view — and it
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
    setDescription("m-1", CACHE.segments);
    mocks.getMediaDescription.mockResolvedValue(null);
    await reloadDescription("m-1");
    expect(held("m-1")).toEqual(CACHE.segments);
  });

  it("publishes a finished run's segments directly", () => {
    setDescription("m-1", CACHE.segments);
    expect(held("m-1")).toEqual(CACHE.segments);
  });

  it("carries the in-flight media id for the rows to read", () => {
    expect(useDescriptionsStore.getState().describing).toBeNull();
    setDescribing("m-1");
    expect(useDescriptionsStore.getState().describing).toBe("m-1");
    setDescribing(null);
    expect(useDescriptionsStore.getState().describing).toBeNull();
  });

  // A project boundary, and the state every test in this file starts from —
  // NOT a Panel close, which the search index goes on reading this map past.
  it("forgets everything on reset", async () => {
    await hydrateDescription("m-1");
    setDescribing("m-1");
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
