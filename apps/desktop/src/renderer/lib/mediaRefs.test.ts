import { describe, expect, it } from "vitest";

import { mediaRefCounts } from "./mediaRefs";
import type { AnimTrack, LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });

function track(id: string, layers: LayerSummary[]): TrackSummary {
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

function envelope(id: string): Omit<LayerSummary, "kind" | "params"> {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    color_hint: "#000000",
    enabled: true,
    locked: false,
    effects: [],
  };
}

function videoClip(id: string, mediaId: string): LayerSummary {
  return {
    ...envelope(id),
    kind: "VideoClip",
    params: {
      kind: "VideoClip",
      media_id: mediaId,
      media_label: mediaId,
      src_in_us: 0,
      src_out_us: 1_000_000,
      x: num(0), y: num(0), scale_x: num(1), scale_y: num(1), scale_linked: true,
      rotation_deg: num(0), opacity: num(1), anchor_x: num(0.5), anchor_y: num(0.5),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    },
  };
}

function imageOverlay(id: string, mediaId: string): LayerSummary {
  return {
    ...envelope(id),
    kind: "ImageOverlay",
    params: {
      kind: "ImageOverlay",
      media_id: mediaId,
      media_label: mediaId,
      x: num(0), y: num(0), scale_x: num(1), scale_y: num(1), scale_linked: true,
      rotation_deg: num(0), opacity: num(1), anchor_x: num(0.5), anchor_y: num(0.5),
      fade_in_us: 0, fade_out_us: 0,
    },
  };
}

function audio(id: string, mediaId: string): LayerSummary {
  return {
    ...envelope(id),
    kind: "Audio",
    params: {
      kind: "Audio",
      media_id: mediaId,
      media_label: mediaId,
      src_in_us: 0,
      src_out_us: 1_000_000,
      gain_db: num(0),
      pan: num(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "dialogue",
    },
  };
}

const countsOf = (summary: ProjectSummary): Record<string, number> =>
  Object.fromEntries(mediaRefCounts(summary.compositions));

describe("media reference counts", () => {
  it("counts every kind that carries a media id, and only those", () => {
    const summary = summaryFixture({
      root: {
        tracks: [
          track("t-1", [
            videoClip("l-1", "m-video"),
            imageOverlay("l-2", "m-image"),
            audio("l-3", "m-audio"),
            // A Group clip points at a composition, not at media — counting it
            // would make its media_id-less params a reference to nothing.
            groupLayerFixture({ id: "l-4", compositionId: "comp-a" }),
          ]),
        ],
      },
      groups: [compositionFixture({ id: "comp-a" })],
    });
    expect(countsOf(summary)).toEqual({
      "m-video": 1,
      "m-image": 1,
      "m-audio": 1,
    });
  });

  it("counts a clip INSIDE a Group, not only one on the root", () => {
    const summary = summaryFixture({
      root: { tracks: [track("t-root", [videoClip("l-1", "m-1")])] },
      groups: [
        compositionFixture({
          id: "comp-a",
          tracks: [track("t-inner", [videoClip("l-2", "m-1"), audio("l-3", "m-2")])],
        }),
      ],
    });
    expect(countsOf(summary)).toEqual({ "m-1": 2, "m-2": 1 });
  });

  it("omits an unplaced item rather than reporting zero — callers read `?? 0`", () => {
    const summary = summaryFixture({ root: { tracks: [track("t-1", [])] } });
    const counts = mediaRefCounts(summary.compositions);
    expect(counts.has("m-1")).toBe(false);
    expect(counts.get("m-1") ?? 0).toBe(0);
  });
});
