import { describe, expect, it } from "vitest";

import type {
  CompositionSummary,
  MarkerSummary,
  TrackSummary,
} from "../ipc";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";
import { groupMarkerCount } from "./groupMarkerCount";

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function marker(over: Partial<MarkerSummary> = {}): MarkerSummary {
  seq += 1;
  return {
    id: `marker-${seq}`,
    t_us: 0,
    end_t_us: null,
    label: "",
    note: "",
    color_hint: "#0080ff",
    anchor_layer: null,
    hibernating: false,
    ...over,
  };
}

/// A lane holding the given Group clips and nothing else — the only layer kind
/// this walk descends through.
function trackOf(...groupCompositionIds: string[]): TrackSummary {
  return {
    id: `track-${groupCompositionIds.join("-") || "empty"}`,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: true,
    layers: groupCompositionIds.map((compositionId, i) =>
      groupLayerFixture({ id: `ref-${compositionId}-${i}`, compositionId }),
    ),
  };
}

function group(
  id: string,
  over: Partial<CompositionSummary> = {},
): CompositionSummary {
  return compositionFixture({ id, label: id, ...over });
}

describe("groupMarkerCount", () => {
  it("counts the composition's own markers", () => {
    const summary = summaryFixture({
      groups: [group("g", { markers: [marker(), marker(), marker()] })],
    });
    expect(groupMarkerCount(summary, "g")).toBe(3);
  });

  it("is zero for a composition with no markers anywhere in it", () => {
    const summary = summaryFixture({ groups: [group("g")] });
    expect(groupMarkerCount(summary, "g")).toBe(0);
  });

  it("adds the markers of a nested composition to its parent's total", () => {
    const summary = summaryFixture({
      groups: [
        group("outer", { markers: [marker()], tracks: [trackOf("inner")] }),
        group("inner", { markers: [marker(), marker()] }),
      ],
    });
    expect(groupMarkerCount(summary, "outer")).toBe(3);
    expect(groupMarkerCount(summary, "inner")).toBe(2);
  });

  it("reaches marks at any depth, not just one level down", () => {
    const summary = summaryFixture({
      groups: [
        group("a", { tracks: [trackOf("b")] }),
        group("b", { tracks: [trackOf("c")] }),
        group("c", { markers: [marker()] }),
      ],
    });
    expect(groupMarkerCount(summary, "a")).toBe(1);
  });

  it("counts a twice-placed composition twice — the total is what is reachable below, not a set of compositions", () => {
    const summary = summaryFixture({
      groups: [
        group("outer", { tracks: [trackOf("inner", "inner")] }),
        group("inner", { markers: [marker(), marker()] }),
      ],
    });
    expect(groupMarkerCount(summary, "outer")).toBe(4);
  });

  it("skips a hibernating marker, which is painted on no surface", () => {
    const summary = summaryFixture({
      groups: [
        group("g", {
          markers: [
            marker(),
            marker({ hibernating: true, anchor_layer: "some-layer" }),
          ],
        }),
      ],
    });
    expect(groupMarkerCount(summary, "g")).toBe(1);
  });

  it("ignores the placing clip's source window — the badge opens the whole child composition", () => {
    const windowed = groupLayerFixture({
      id: "ref-windowed",
      compositionId: "inner",
      srcInUs: 1_000_000,
      srcOutUs: 1_500_000,
    });
    const summary = summaryFixture({
      groups: [
        group("outer", {
          tracks: [{ ...trackOf(), id: "t-outer", layers: [windowed] }],
        }),
        group("inner", {
          duration_us: 4_000_000,
          markers: [marker({ t_us: 0 }), marker({ t_us: 3_000_000 })],
        }),
      ],
    });
    expect(groupMarkerCount(summary, "outer")).toBe(2);
  });

  it("counts nothing for a composition the summary no longer carries, and nothing for no composition at all", () => {
    const summary = summaryFixture({ groups: [group("g", { markers: [marker()] })] });
    expect(groupMarkerCount(summary, "gone")).toBe(0);
    expect(groupMarkerCount(summary, null)).toBe(0);
    expect(groupMarkerCount(null, "g")).toBe(0);
  });

  it("counts the root's own markers too — nothing about the walk is Group-only", () => {
    const summary = summaryFixture({
      root: { markers: [marker()], tracks: [trackOf("g")] },
      groups: [group("g", { markers: [marker()] })],
    });
    expect(groupMarkerCount(summary, summary.root_id)).toBe(2);
  });
});
