import { beforeEach, describe, expect, it } from "vitest";

import { autoCaptionState, autoCaptionForSelection } from "./autoCaptionEligibility";
import {
  closeAutoCaptionPrompt,
  setAutoCaptionTranscribing,
} from "./autoCaptionPrompt";
import type { LayerSummary, TrackSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  setLayerSelection,
} from "../state/selectionStore";
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
      media_id: "m-1",
      media_label: "interview.mov",
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
      media_id: "m-2",
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

function colorLayer(id: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "Color",
    color_hint: "#8a8a8a",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Color",
      color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } },
      width: 1920,
      height: 1080,
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

const TRACKS = [trackWith([videoLayer("l-video", 1), audioLayer("l-audio"), colorLayer("l-color"), videoLayer("l-fast", 2)])];

describe("autoCaptionState", () => {
  it("admits a normal-speed VideoClip and an Audio layer", () => {
    expect(autoCaptionState("l-video", TRACKS, false)).toBe("auto_caption");
    expect(autoCaptionState("l-audio", TRACKS, false)).toBe("auto_caption");
  });

  it("asks for a selection when nothing is selected, or when the summary has no such layer", () => {
    expect(autoCaptionState(null, TRACKS, false)).toBe("needs_selection");
    expect(autoCaptionState("l-gone", TRACKS, false)).toBe("needs_selection");
  });

  // Separate from needs_selection: "pick a clip" and "pick a clip with sound"
  // are different instructions.
  it("names the wrong kind rather than reporting no selection", () => {
    expect(autoCaptionState("l-color", TRACKS, false)).toBe("needs_audio_kind");
  });

  it("refuses a re-timed clip at the gesture, not at the tool", () => {
    expect(autoCaptionState("l-fast", TRACKS, false)).toBe("speed_not_one");
  });

  // Audio carries no speed field at all, so a speed gate must not be applied
  // to it — doing so would grey out every audio clip.
  it("applies no speed gate to an Audio layer", () => {
    expect(autoCaptionState("l-audio", TRACKS, false)).toBe("auto_caption");
  });

  // First, and regardless of the selection: a second run would bill a second
  // request and race two caption tracks onto the timeline.
  it("stands down while a transcription is in flight, whatever is selected", () => {
    expect(autoCaptionState("l-video", TRACKS, true)).toBe("transcribing");
    expect(autoCaptionState(null, TRACKS, true)).toBe("transcribing");
  });
});

describe("autoCaptionForSelection", () => {
  beforeEach(() => {
    closeAutoCaptionPrompt();
    clearLayerSelection();
    useProjectStore.getState().apply(summaryFixture({ root: { tracks: TRACKS } }));
  });

  it("reads the primary selection and the in-flight flag live", () => {
    expect(autoCaptionForSelection()).toBe("needs_selection");
    setLayerSelection("l-video", ["l-video"]);
    expect(autoCaptionForSelection()).toBe("auto_caption");
    setAutoCaptionTranscribing(true);
    expect(autoCaptionForSelection()).toBe("transcribing");
    setAutoCaptionTranscribing(false);
    expect(autoCaptionForSelection()).toBe("auto_caption");
  });

  // The primary and not the whole set: a transcript is a claim about ONE
  // source's audio, so a multi-selection is answered by its primary member.
  it("answers for the primary member of a multi-selection", () => {
    setLayerSelection("l-color", ["l-color", "l-video"]);
    expect(autoCaptionForSelection()).toBe("needs_audio_kind");
    setLayerSelection("l-video", ["l-video", "l-color"]);
    expect(autoCaptionForSelection()).toBe("auto_caption");
  });
});
