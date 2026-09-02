import { beforeEach, describe, expect, it } from "vitest";

import {
  describeForSelection,
  describeState,
  describeTarget,
} from "./describeEligibility";
import type { LayerSummary, TrackSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import { summaryFixture } from "../testing/summaryFixture";

const num = (value: number) => ({ mode: "Static" as const, value });

function videoLayer(id: string, speed: number): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 2_000_000,
    kind: "VideoClip",
    color_hint: "#4c8dd8",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: `m-${id}`,
      media_label: "reel.mp4",
      src_in_us: 0,
      src_out_us: 2_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      speed,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
  };
}

function audioLayer(id: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 2_000_000,
    kind: "Audio",
    color_hint: "#5aa88a",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Audio",
      media_id: "m-audio",
      media_label: "vo.wav",
      src_in_us: 0,
      src_out_us: 2_000_000,
      gain_db: num(0),
      pan: num(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "dialogue",
    },
  };
}

function trackWith(layers: LayerSummary[]): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

const TRACKS = [
  trackWith([videoLayer("l-video", 1), audioLayer("l-audio"), videoLayer("l-fast", 2)]),
];

describe("describeState", () => {
  it("admits a normal-speed VideoClip", () => {
    expect(describeState("l-video", TRACKS)).toBe("describe");
  });

  it("asks for a selection when nothing is selected, or when the summary has no such layer", () => {
    expect(describeState(null, TRACKS)).toBe("needs_selection");
    expect(describeState("l-gone", TRACKS)).toBe("needs_selection");
  });

  // The one state that genuinely differs from the audio gate's: sound is not
  // what makes a clip describable, so an Audio layer auto-caption accepts is
  // the wrong kind here.
  it("names the wrong kind for an Audio layer rather than admitting it", () => {
    expect(describeState("l-audio", TRACKS)).toBe("needs_video_kind");
  });

  it("refuses a re-timed clip at the gesture, not at the tool", () => {
    expect(describeState("l-fast", TRACKS)).toBe("speed_not_one");
  });
});

describe("describeForSelection", () => {
  beforeEach(() => {
    clearLayerSelection();
    useProjectStore.getState().apply(summaryFixture({ root: { tracks: TRACKS } }));
  });

  it("reads the primary selection live", () => {
    expect(describeForSelection()).toBe("needs_selection");
    setLayerSelection("l-video", ["l-video"]);
    expect(describeForSelection()).toBe("describe");
  });

  // The primary and not the whole set: a description is a claim about ONE
  // source's frames, so a multi-selection is answered by its primary member.
  it("answers for the primary member of a multi-selection", () => {
    setLayerSelection("l-audio", ["l-audio", "l-video"]);
    expect(describeForSelection()).toBe("needs_video_kind");
    setLayerSelection("l-video", ["l-video", "l-audio"]);
    expect(describeForSelection()).toBe("describe");
  });

  // A greyed row still has to be able to say which clip it meant, so the target
  // answers whatever the verdict is.
  it("names the primary layer even when the gesture is not live", () => {
    setLayerSelection("l-fast", ["l-fast"]);
    expect(describeForSelection()).toBe("speed_not_one");
    expect(describeTarget()?.id).toBe("l-fast");
  });
});
