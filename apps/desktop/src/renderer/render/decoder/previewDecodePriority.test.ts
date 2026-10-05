import { describe, expect, it } from "vitest";

import type { CompositionSummary, LayerSummary, TrackSummary } from "../../ipc";
import { planPreviewDecodePriority } from "./previewDecodePriority";
import { rootOf, summaryFixture } from "../../testing/summaryFixture";

function video(
  id: string,
  startUs: number,
  endUs: number,
  enabled = true,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: startUs,
    t_end_us: endUs,
    kind: "VideoClip",
    color_hint: "#000000",
    enabled,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: `media-${id}`,
      media_label: id,
      src_in_us: 0,
      src_out_us: endUs - startUs,
      speed: 1,
      opacity: { mode: "Static", value: 1 },
      x: { mode: "Static", value: 0 },
      y: { mode: "Static", value: 0 },
      scale_x: { mode: "Static", value: 1 },
      scale_y: { mode: "Static", value: 1 },
      scale_linked: true,
      rotation_deg: { mode: "Static", value: 0 },
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

function summary(layers: LayerSummary[]): CompositionSummary {
  const track: TrackSummary = {
    id: "track",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
  return rootOf(summaryFixture({
    project_id: "project",
    name: "Priority",
    media: [],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 20_000_000,
      tracks: [track],
      markers: [],
      links: [],
    },
  }));
}

describe("preview decode priority plan", () => {
  it("plans trimmed Group instances on their visible source time and protects nested keys", () => {
    const leaf = video("leaf", 0, 4_000_000);
    const child = { ...summary([leaf]), id: "child" };
    const base = video("group", 5_000_000, 7_000_000);
    if (base.params.kind !== "VideoClip") throw new Error("fixture");
    const group: LayerSummary = { ...base, kind: "CompositionRef", params: {
      ...base.params, kind: "CompositionRef", composition_id: child.id, composition_label: "Child", src_in_us: 1_000_000,
    } };
    const root = summary([group]);
    const project = summaryFixture({root});
    project.compositions[child.id] = child;
    const plan = planPreviewDecodePriority(root, 4_500_000, 1_000_000, project);
    expect(plan.upcomingTargets).toMatchObject([{key: "group/leaf", path: "group/", sourceUs: 1_000_000, tStartUs: 5_000_000, tEndUs: 7_000_000}]);
    expect(plan.poolKeys).toEqual(["group/leaf", "group/leaf#swap"]);
    const playing = planPreviewDecodePriority(root, 5_500_000, 1_000_000, project);
    expect(playing.activeTargets).toMatchObject([{key: "group/leaf", sourceUs: 1_500_000}]);
    expect(planPreviewDecodePriority(root, 7_000_000, 1_000_000, project).poolKeys).toEqual([]);
  });
  it("warms across a short intervening clip instead of waiting until that clip starts", () => {
    const plan = planPreviewDecodePriority(summary([
      video("active", 0, 2_000_000),
      video("short", 2_000_000, 2_200_000),
      video("after-short", 2_200_000, 3_000_000),
      video("outside-window", 3_000_000, 4_000_000),
    ]), 1_500_000, 1_000_000);
    expect(plan.upcomingLayers.map(l => l.id)).toEqual(["short", "after-short"]);
    expect(plan.poolKeys).toContain("after-short");
  });

  it("bounds speculation even when many tiny cuts fit inside the window", () => {
    const plan = planPreviewDecodePriority(summary([
      video("active", 0, 2_000_000),
      ...[0, 1, 2, 3].map(i => video(`cut-${i}`, 2_000_000 + i * 100_000, 2_100_000 + i * 100_000)),
    ]), 1_500_000, 1_000_000);
    expect(plan.upcomingLayers.map(l => l.id)).toEqual(["cut-0", "cut-1", "cut-2"]);
    expect(plan.poolKeys).not.toContain("cut-3");
  });

  it("gives the third sequential cut a full prewarm window across tiny clips", () => {
    const plan = planPreviewDecodePriority(summary([
      video("active", 0, 2_000_000),
      video("tiny", 2_000_000, 2_033_333),
      video("short", 2_033_333, 2_233_333),
      video("after-short", 2_233_333, 3_000_000),
    ]), 1_500_000, 1_000_000);
    expect(plan.upcomingLayers.map(l => l.id)).toEqual(["tiny", "short", "after-short"]);
  });

  it("does not add speculative sessions to a composition with several active videos", () => {
    const plan = planPreviewDecodePriority(summary([
      video("active-a", 0, 2_000_000),
      video("active-b", 0, 3_000_000),
      video("short", 2_000_000, 2_200_000),
      video("after-short", 2_200_000, 3_000_000),
    ]), 1_500_000, 1_000_000);
    expect(plan.upcomingLayers.map(l => l.id)).toEqual(["short"]);
  });
  it("protects the nearest boundary and its swap keys without warming extra overlapping layers", () => {
    const active = video("active", 4_000_000, 8_000_000);
    const retained = video("retained", 0, 4_000_000);
    const upcomingA = video("upcoming-a", 5_500_000, 9_000_000);
    const upcomingB = video("upcoming-b", 5_500_000, 9_000_000);
    const later = video("later", 5_800_000, 9_000_000);
    const disabled = video("disabled", 5_500_000, 9_000_000, false);

    const plan = planPreviewDecodePriority(
      summary([active, retained, upcomingA, upcomingB, later, disabled]),
      5_000_000,
      1_000_000,
    );

    expect(plan.nextStartUs).toBe(5_500_000);
    expect(plan.upcomingLayers.map((layer) => layer.id)).toEqual([
      "upcoming-a",
      "upcoming-b",
    ]);
    expect(plan.poolKeys).toEqual([
      "active",
      "active#swap",
      "upcoming-a",
      "upcoming-a#swap",
      "upcoming-b",
      "upcoming-b#swap",
    ]);
  });
});
