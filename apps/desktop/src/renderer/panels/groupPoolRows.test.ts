import { describe, expect, it } from "vitest";

import { filterGroupPoolRows, groupPoolRows } from "./groupPoolRows";
import { compositionRefCounts } from "../lib/compositionRefs";
import { groupOrdinals, layerDisplayName } from "../lib/layerName";
import type { ProjectSummary, TrackSummary } from "../ipc";
import {
  ROOT_ID,
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

/// The English strings the pool actually renders, so a row's name is asserted as
/// text rather than as a key. `{{n}}` is the only interpolation these keys use.
const t = (key: string, values: Record<string, unknown>): string =>
  key === "timeline.group_derived_name" ? `Group ${values.n}` : key;

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

const rowsOf = (summary: ProjectSummary) =>
  groupPoolRows(
    summary,
    groupOrdinals(summary.compositions, summary.root_id),
    compositionRefCounts(summary.compositions),
    t,
  );

describe("group pool rows", () => {
  it("lists every composition but the root, with its duration and reference count", () => {
    expect(rowsOf(twoGroups())).toEqual([
      { compositionId: "comp-a", name: "Group 1", durationUs: 2_000_000, refCount: 2 },
      { compositionId: "comp-b", name: "Group 2", durationUs: 5_000_000, refCount: 0 },
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
    expect(rowsOf(summary).map((r) => [r.compositionId, r.refCount])).toEqual([
      ["comp-a", 1],
      ["comp-b", 1],
    ]);
  });

  it("reports an orphan as zero rather than omitting it — it is what this section is for", () => {
    // The whole project, with the one Group clip deleted.
    const summary = summaryFixture({
      root: { tracks: [trackWith("track-1", [])] },
      groups: [compositionFixture({ id: "comp-a", duration_us: 2_000_000 })],
    });
    expect(rowsOf(summary)).toEqual([
      { compositionId: "comp-a", name: "Group 1", durationUs: 2_000_000, refCount: 0 },
    ]);
  });

  it("names a row exactly as the timeline names the clip that places it", () => {
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
    const rows = rowsOf(summary);
    const clips = summary.compositions[ROOT_ID]!.tracks[0]!.layers;
    // Same derived number for the unnamed one, same stored label for the named
    // one — one `groupDisplayName`, not two derivations that can drift.
    expect(rows.map((r) => r.name)).toEqual(["Group 1", "Intro"]);
    expect(clips.map((l) => layerDisplayName(l, t, ordinals))).toEqual([
      "Group 1",
      "Intro",
    ]);
    // A labelled composition keeps a number of its own — it is stored, not
    // counted — so naming one renumbers no neighbour and clearing the name
    // gives it back.
    expect(ordinals.get("comp-named")).toBe(2);
  });

  it("filters on the displayed name, case-insensitively", () => {
    const rows = rowsOf(twoGroups());
    expect(filterGroupPoolRows(rows, "group 2").map((r) => r.compositionId)).toEqual([
      "comp-b",
    ]);
    expect(filterGroupPoolRows(rows, "  ")).toHaveLength(2);
    expect(filterGroupPoolRows(rows, "nope")).toEqual([]);
  });
});
