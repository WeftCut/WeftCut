import { describe, expect, it } from "vitest";

import {
  FOLLOW_FOCUS_VALUE,
  previewTargetOptions,
  targetOptionChoice,
  targetOptionValue,
} from "./previewTargetOptions";
import { compositionRefCounts } from "../lib/compositionRefs";
import { groupDisplayName, groupOrdinals } from "../lib/layerName";
import type { ProjectSummary, TrackSummary } from "../ipc";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

/// The English strings the control actually renders, so an entry's label is
/// asserted as text rather than as a key.
const t = (key: string, values: Record<string, unknown>): string =>
  key === "timeline.group_derived_name"
    ? `Group ${values.n}`
    : key === "preview.target_follow_focus"
      ? "Follow focus"
      : key;

const TIMELINE = "Timeline";

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

/// `comp-a` placed on the root, `comp-b` placed nowhere.
function twoGroups(): ProjectSummary {
  return summaryFixture({
    root: {
      tracks: [
        trackWith("track-1", [
          groupLayerFixture({ id: "ref-1", compositionId: "comp-a" }),
        ]),
      ],
    },
    groups: [
      compositionFixture({ id: "comp-a", duration_us: 2_000_000 }),
      compositionFixture({ id: "comp-b", duration_us: 5_000_000 }),
    ],
  });
}

const optionsOf = (summary: ProjectSummary | null) =>
  previewTargetOptions(
    summary,
    summary ? groupOrdinals(summary.compositions, summary.root_id) : new Map(),
    summary ? compositionRefCounts(summary.compositions) : new Map(),
    TIMELINE,
    t,
  );

describe("preview target options", () => {
  it("offers follow focus, then the timeline, then every Group in creation order", () => {
    const summary = twoGroups();
    expect(optionsOf(summary)).toEqual([
      { compositionId: null, label: "Follow focus", unused: false },
      { compositionId: summary.root_id, label: TIMELINE, unused: false },
      { compositionId: "comp-a", label: "Group 1", unused: false },
      { compositionId: "comp-b", label: "Group 2", unused: true },
    ]);
  });

  // The root is never a noun in the UI — it IS the timeline — so it reads as
  // the Panel's own title rather than as a composition name.
  it("names the root after the timeline Panel, never after a composition", () => {
    const summary = twoGroups();
    const root = optionsOf(summary)[1]!;
    expect(root.label).toBe(TIMELINE);
    expect(root.label).not.toBe(
      groupDisplayName(
        summary.root_id,
        null,
        groupOrdinals(summary.compositions, summary.root_id),
        t,
      ),
    );
  });

  it("keeps an orphan selectable and marks it unused, as the media pool does", () => {
    const orphan = optionsOf(twoGroups()).find((o) => o.compositionId === "comp-b");
    expect(orphan).toEqual({ compositionId: "comp-b", label: "Group 2", unused: true });
  });

  it("names a Group exactly as its clip and its pool row do", () => {
    const summary = summaryFixture({
      root: {
        tracks: [
          trackWith("track-1", [
            groupLayerFixture({
              id: "ref-1",
              compositionId: "comp-named",
              compositionLabel: "Intro",
            }),
          ]),
        ],
      },
      groups: [compositionFixture({ id: "comp-named", label: "Intro" })],
    });
    expect(optionsOf(summary).map((o) => o.label)).toEqual([
      "Follow focus",
      TIMELINE,
      "Intro",
    ]);
  });

  it("offers following alone before a project is loaded", () => {
    expect(optionsOf(null)).toEqual([
      { compositionId: null, label: "Follow focus", unused: false },
    ]);
  });

  it("round-trips a choice through the control's string values", () => {
    expect(targetOptionValue(null)).toBe(FOLLOW_FOCUS_VALUE);
    expect(targetOptionChoice(FOLLOW_FOCUS_VALUE)).toBeNull();
    expect(targetOptionChoice(targetOptionValue("comp-a"))).toBe("comp-a");
  });
});
