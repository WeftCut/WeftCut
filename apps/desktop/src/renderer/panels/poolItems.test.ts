import { describe, expect, it } from "vitest";

import {
  filterPoolItems,
  groupPoolItems,
  poolCollator,
  poolItems,
} from "./poolItems";
import { compositionRefCounts } from "../lib/compositionRefs";
import { groupOrdinals, layerDisplayName } from "../lib/layerName";
import type { MediaSummary, ProjectSummary, TrackSummary } from "../ipc";
import {
  ROOT_ID,
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

/// The English strings the pool actually renders, so an item's name is asserted
/// as text rather than as a key. `{{n}}` is the only interpolation these keys
/// use.
const t = (key: string, values: Record<string, unknown>): string =>
  key === "timeline.group_derived_name" ? `Group ${values.n}` : key;

const COLLATOR = poolCollator("en-US");

function trackWith(id: string, layers: TrackSummary["layers"]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: true,
    layers,
  };
}

function mediaFixture(id: string, label: string): MediaSummary {
  return {
    id,
    label,
    path: `/media/${id}.mp4`,
    kind: "Video",
    duration_us: 1_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 1024,
    available: true,
    decode_route: { route: "bypass" },
    codec: null,
    pix_fmt: null,
  };
}

/// Two Groups: `comp-a` placed twice in the root, `comp-b` placed nowhere.
function twoGroups(): ProjectSummary {
  return summaryFixture({
    root: {
      tracks: [
        trackWith("track-1", [
          groupLayerFixture({ id: "ref-1", compositionId: "comp-a" }),
          groupLayerFixture({
            id: "ref-2",
            compositionId: "comp-a",
            tStartUs: 10_000_000,
            tEndUs: 12_000_000,
          }),
        ]),
      ],
    },
    groups: [
      compositionFixture({ id: "comp-a", duration_us: 2_000_000 }),
      compositionFixture({ id: "comp-b", duration_us: 5_000_000 }),
    ],
  });
}

const groupsOf = (summary: ProjectSummary) =>
  groupPoolItems(
    summary,
    groupOrdinals(summary.compositions, summary.root_id),
    compositionRefCounts(summary.compositions),
    t,
  );

const listOf = (media: MediaSummary[], summary: ProjectSummary | null) =>
  poolItems(
    media,
    summary,
    summary ? groupOrdinals(summary.compositions, summary.root_id) : new Map(),
    summary ? compositionRefCounts(summary.compositions) : new Map(),
    t,
    COLLATOR,
  );

describe("group pool items", () => {
  it("lists every composition but the root, with its duration and reference count", () => {
    expect(groupsOf(twoGroups())).toEqual([
      {
        kind: "group",
        id: "comp-a",
        name: "Group 1",
        durationUs: 2_000_000,
        refCount: 2,
      },
      {
        kind: "group",
        id: "comp-b",
        name: "Group 2",
        durationUs: 5_000_000,
        refCount: 0,
      },
    ]);
  });

  it("counts references from INSIDE a Group, not only from the root", () => {
    const summary = summaryFixture({
      root: {
        tracks: [trackWith("track-1", [groupLayerFixture({ id: "ref-1", compositionId: "comp-a" })])],
      },
      groups: [
        compositionFixture({
          id: "comp-a",
          duration_us: 4_000_000,
          tracks: [trackWith("track-2", [groupLayerFixture({ id: "ref-2", compositionId: "comp-b" })])],
        }),
        compositionFixture({ id: "comp-b", duration_us: 2_000_000 }),
      ],
    });
    expect(groupsOf(summary).map((g) => [g.id, g.refCount])).toEqual([
      ["comp-a", 1],
      ["comp-b", 1],
    ]);
  });

  it("reports an orphan as zero rather than omitting it — that card is what keeps it reachable", () => {
    // The whole project, with the one Group clip deleted.
    const summary = summaryFixture({
      root: { tracks: [trackWith("track-1", [])] },
      groups: [compositionFixture({ id: "comp-a", duration_us: 2_000_000 })],
    });
    expect(groupsOf(summary)).toEqual([
      {
        kind: "group",
        id: "comp-a",
        name: "Group 1",
        durationUs: 2_000_000,
        refCount: 0,
      },
    ]);
  });

  it("names a Group exactly as the timeline names the clip that places it", () => {
    const summary = summaryFixture({
      root: {
        tracks: [
          trackWith("track-1", [
            groupLayerFixture({ id: "ref-1", compositionId: "comp-a" }),
            groupLayerFixture({
              id: "ref-2",
              compositionId: "comp-named",
              compositionLabel: "Intro",
              tStartUs: 10_000_000,
              tEndUs: 12_000_000,
            }),
          ]),
        ],
      },
      groups: [
        compositionFixture({ id: "comp-a", duration_us: 2_000_000 }),
        compositionFixture({ id: "comp-named", label: "Intro", duration_us: 2_000_000 }),
      ],
    });
    const ordinals = groupOrdinals(summary.compositions, summary.root_id);
    const clips = summary.compositions[ROOT_ID]!.tracks[0]!.layers;
    // Same derived number for the unnamed one, same stored label for the named
    // one — one `groupDisplayName`, not two derivations that can drift.
    expect(groupsOf(summary).map((g) => g.name)).toEqual(["Group 1", "Intro"]);
    expect(clips.map((l) => layerDisplayName(l, t, ordinals))).toEqual([
      "Group 1",
      "Intro",
    ]);
    // A labelled composition keeps a number of its own — it is stored, not
    // counted — so naming one renumbers no neighbour and clearing the name
    // gives it back.
    expect(ordinals.get("comp-named")).toBe(2);
  });
});

describe("pool items", () => {
  it("interleaves both kinds under one name order", () => {
    const media = [mediaFixture("m-b", "b-roll.mp4"), mediaFixture("m-a", "Alpha.mp4")];
    expect(listOf(media, twoGroups()).map((item) => [item.kind, item.name])).toEqual([
      ["media", "Alpha.mp4"],
      ["media", "b-roll.mp4"],
      ["group", "Group 1"],
      ["group", "Group 2"],
    ]);
  });

  it("orders derived numbers the way a person counts, not the way bytes sort", () => {
    const summary = summaryFixture({
      groups: [
        compositionFixture({ id: "comp-2", ordinal: 2 }),
        compositionFixture({ id: "comp-10", ordinal: 10 }),
      ],
    });
    // A bare `localeCompare` puts "Group 10" first. The pool's collator is
    // `numeric`, which is the only reason a derived name is findable.
    expect(listOf([], summary).map((item) => item.name)).toEqual([
      "Group 2",
      "Group 10",
    ]);
  });

  it("holds the Groups alone when the Panel is handed no media", () => {
    expect(listOf([], twoGroups())).toHaveLength(2);
    expect(listOf([], null)).toEqual([]);
  });

  it("keeps identically named cards in a stable order", () => {
    const summary = summaryFixture({
      groups: [compositionFixture({ id: "comp-a", label: "Intro" })],
    });
    const media = [mediaFixture("m-1", "Intro"), mediaFixture("m-0", "Intro")];
    expect(listOf(media, summary).map((item) => item.id)).toEqual(
      listOf([...media].reverse(), summary).map((item) => item.id),
    );
  });

  it("filters both kinds on the displayed name, case-insensitively", () => {
    const items = listOf([mediaFixture("m-1", "Zoom-GROUP.mp4")], twoGroups());
    expect(filterPoolItems(items, "group 2").map((i) => i.id)).toEqual(["comp-b"]);
    expect(filterPoolItems(items, "group").map((i) => i.id)).toEqual([
      "comp-a",
      "comp-b",
      "m-1",
    ]);
    expect(filterPoolItems(items, "  ")).toHaveLength(3);
    expect(filterPoolItems(items, "nope")).toEqual([]);
  });
});
