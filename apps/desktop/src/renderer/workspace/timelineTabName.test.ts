import { describe, expect, it } from "vitest";

import { layerDisplayName } from "../lib/layerName";
import {
  compositionFixture,
  groupLayerFixture,
  ROOT_ID,
  summaryFixture,
} from "../testing/summaryFixture";
import {
  anchorEntryLabel,
  compositionPathText,
  projectPathLabel,
  timelineTabLabel,
} from "./timelineTabName";

/// The real bundle's keys, resolved the way `useTranslation` would. Interpolation
/// is not under test here — `groupDisplayName` owns the derived name, and the
/// path is what these functions assemble.
const t = (key: string, values: Record<string, unknown>): string =>
  key === "timeline.group_derived_name" ? `Group ${String(values.n)}` : key;

const G1 = "comp-g1";
const G2 = "comp-g2";

function project(name = "My film") {
  const summary = summaryFixture({
    name,
    root: { tracks: [] },
    groups: [
      compositionFixture({ id: G1, label: null }),
      compositionFixture({ id: G2, label: "Titles" }),
    ],
  });
  // Only the number `comp-g1` shows: `comp-g2` carries a label, which outranks
  // its own ordinal everywhere the tab is drawn.
  return { summary, ordinals: new Map([[G1, 1]]) };
}

describe("projectPathLabel", () => {
  it("is the project's own name", () => {
    expect(projectPathLabel(project().summary, t)).toBe("My film");
  });

  it("falls back to a generic word for a project saved under no name", () => {
    expect(projectPathLabel(project("   ").summary, t)).toBe(
      "dock_workspace.timeline_tab.project",
    );
    expect(projectPathLabel(null, t)).toBe("dock_workspace.timeline_tab.project");
  });
});

describe("compositionPathText", () => {
  it("is the project alone at the root, where the path has no steps", () => {
    const { summary, ordinals } = project();
    expect(compositionPathText(summary, [], ordinals, t)).toBe("My film");
  });

  it("names every step the Panel was opened through, in order", () => {
    const { summary, ordinals } = project();
    const path = compositionPathText(
      summary,
      [
        { layerId: "ref-g1", compositionId: G1 },
        { layerId: "ref-g2", compositionId: G2 },
      ],
      ordinals,
      t,
    );
    expect(path).toBe("My film › Group 1 › Titles");
  });
});

/// A `Switch anchor` row has to tell two placements of one Group apart, and the
/// only clock they share is the root's.
describe("anchorEntryLabel", () => {
  const label = (
    summary: ReturnType<typeof project>["summary"],
    placement: Parameters<typeof anchorEntryLabel>[1],
  ) => anchorEntryLabel(summary, placement, new Map([[G1, 1]]), (key, values) =>
    key === "dock_workspace.timeline_tab.anchor_entry"
      ? `${String(values.path)} · ${String(values.time)}`
      : t(key, values),
  );

  it("names where the clip sits and where it starts on the root's clock", () => {
    const { summary } = project();
    expect(
      label(summary, {
        layerId: "ref-b",
        crumbs: [{ layerId: "ref-b", compositionId: G1 }],
        rootStartUs: 2_000_000,
      }),
    ).toBe("My film · 00:00:02:00");
  });

  it("prints the parent's route for a placement nested inside another Group", () => {
    const { summary } = project();
    expect(
      label(summary, {
        layerId: "ref-deep",
        crumbs: [
          { layerId: "ref-g2", compositionId: G2 },
          { layerId: "ref-deep", compositionId: G1 },
        ],
        rootStartUs: 1_000_000,
      }),
    ).toBe("My film › Titles · 00:00:01:00");
  });
});

describe("timelineTabLabel", () => {
  const PANEL_TITLE = "Timeline";

  it("prints the Panel kind's own title for the root — the root has no name", () => {
    const { summary, ordinals } = project();
    expect(timelineTabLabel(summary, ROOT_ID, ordinals, PANEL_TITLE, t)).toBe(
      PANEL_TITLE,
    );
    expect(timelineTabLabel(summary, null, ordinals, PANEL_TITLE, t)).toBe(
      PANEL_TITLE,
    );
  });

  it("prints the Group's own name, stored or derived", () => {
    const { summary, ordinals } = project();
    expect(timelineTabLabel(summary, G2, ordinals, PANEL_TITLE, t)).toBe("Titles");
    expect(timelineTabLabel(summary, G1, ordinals, PANEL_TITLE, t)).toBe("Group 1");
  });

  it("is the same name the Group's clip carries on the timeline", () => {
    const { summary, ordinals } = project();
    for (const id of [G1, G2]) {
      const clip = groupLayerFixture({
        compositionId: id,
        compositionLabel: summary.compositions[id]!.label,
      });
      expect(timelineTabLabel(summary, id, ordinals, PANEL_TITLE, t)).toBe(
        layerDisplayName(clip, t, ordinals),
      );
    }
  });
});
