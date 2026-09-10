// The half of the feature that is not the section: which layer a detection is
// about, whether the gesture is live, and what the command does when it fires.
//
// The subject rule is a TWIN of main's, so the branches here are the branches
// there: a wrong answer greys a row the tool would accept, or offers one it
// will refuse.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestPropSectionExpand: vi.fn() }));

vi.mock("../properties/PropSection", () => ({
  requestPropSectionExpand: mocks.requestPropSectionExpand,
}));

import type { AnimTrack, LayerSummary, TrackSummary } from "../ipc";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import {
  canDetectPausesSelection,
  openPausesForSelection,
  pauseSubjectForSelection,
  resolvePauseSubjectSummary,
} from "./pauseCommands";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });

function audioLayer(id: string, mediaId: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 4_000_000,
    kind: "Audio",
    color_hint: "#3f8f6f",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Audio",
      media_id: mediaId,
      media_label: `${mediaId}.wav`,
      src_in_us: 0,
      src_out_us: 4_000_000,
      gain_db: num(0),
      pan: num(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "dialogue",
    },
  };
}

function videoLayer(
  id: string,
  mediaId: string,
  over: { speed?: number } = {},
): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 4_000_000,
    kind: "VideoClip",
    color_hint: "#4c8dd8",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: mediaId,
      media_label: `${mediaId}.mov`,
      src_in_us: 0,
      src_out_us: 4_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      speed: over.speed ?? 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
  };
}

function colorLayer(id: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 4_000_000,
    kind: "Color",
    color_hint: "#8a94a0",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Color",
      color: [0, 0, 0, 1],
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      width: 1920,
      height: 1080,
    },
  } as unknown as LayerSummary;
}

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
    removable: true,
    layers,
  } as unknown as TrackSummary;
}

/// A composition holding one track of the given layers, optionally with them
/// all in one link.
function comp(layers: LayerSummary[], linked = false) {
  return compositionFixture({
    tracks: [track("t-1", layers)],
    links: linked ? [{ id: "lk-1", label: null, layer_ids: layers.map((l) => l.id) }] : [],
  });
}

/// Seed the store and select the primary layer, the way a click would.
function seed(layers: LayerSummary[], primaryId: string | null, linked = false): void {
  const root = comp(layers, linked);
  useProjectStore.getState().apply(summaryFixture({ root }));
  if (primaryId === null) clearLayerSelection();
  else setLayerSelection(primaryId, [primaryId]);
}

beforeEach(() => {
  mocks.requestPropSectionExpand.mockReset();
  useProjectStore.setState({ summary: null });
  clearLayerSelection();
});

describe("resolvePauseSubjectSummary", () => {
  it("makes an Audio layer its own subject", () => {
    const audio = audioLayer("a-1", "m-1");
    expect(resolvePauseSubjectSummary(audio, comp([audio]))).toBe(audio);
  });

  // The ordinary A/V pair: same file, split into picture and sound.
  it("delegates a VideoClip to the linked Audio layer sharing its media", () => {
    const video = videoLayer("v-1", "m-1");
    const same = audioLayer("a-1", "m-1");
    const other = audioLayer("a-2", "m-2");
    const c = comp([video, other, same], true);
    expect(resolvePauseSubjectSummary(video, c)).toBe(same);
  });

  // A picture clip linked to detached sound: nothing shares its media, but
  // there is only one candidate, so "the audio that belongs to this picture"
  // has an unambiguous answer.
  it("delegates to the sole Audio member when none shares the media", () => {
    const video = videoLayer("v-1", "m-1");
    const audio = audioLayer("a-1", "m-2");
    expect(resolvePauseSubjectSummary(video, comp([video, audio], true))).toBe(audio);
  });

  // Two candidates and no media match: counting cannot answer it, so the honest
  // answer is none rather than a guess that cuts by the wrong sound.
  it("refuses when two linked Audio members are equally plausible", () => {
    const video = videoLayer("v-1", "m-1");
    const c = comp([video, audioLayer("a-1", "m-2"), audioLayer("a-2", "m-3")], true);
    expect(resolvePauseSubjectSummary(video, c)).toBeNull();
  });

  it("refuses an unlinked VideoClip", () => {
    const video = videoLayer("v-1", "m-1");
    expect(resolvePauseSubjectSummary(video, comp([video]))).toBeNull();
  });
});

describe("pauseSubjectForSelection", () => {
  it("is live on a selected Audio layer", () => {
    seed([audioLayer("a-1", "m-1")], "a-1");
    expect(pauseSubjectForSelection()).toBe("ok");
    expect(canDetectPausesSelection()).toBe(true);
  });

  it("needs a selection", () => {
    seed([audioLayer("a-1", "m-1")], null);
    expect(pauseSubjectForSelection()).toBe("needs_selection");
    expect(canDetectPausesSelection()).toBe(false);
  });

  it("needs a clip that carries sound", () => {
    seed([colorLayer("c-1")], "c-1");
    expect(pauseSubjectForSelection()).toBe("needs_audio_kind");
  });

  // The re-timed case outranks the subject rule: a speed-1 segment is what
  // unblocks it, and naming the missing partner instead would send the user
  // the wrong way.
  it("refuses a re-timed clip before it looks for a subject", () => {
    const video = videoLayer("v-1", "m-1", { speed: 2 });
    const audio = audioLayer("a-1", "m-1");
    seed([video, audio], "v-1", true);
    expect(pauseSubjectForSelection()).toBe("speed_not_one");
  });

  it("says a VideoClip with no linked audio plays no sound", () => {
    seed([videoLayer("v-1", "m-1")], "v-1");
    expect(pauseSubjectForSelection()).toBe("plays_no_sound");
    expect(canDetectPausesSelection()).toBe(false);
  });
});

describe("openPausesForSelection", () => {
  // Keyed by the SELECTED layer's kind: the panel showing a delegating
  // VideoClip is the one that mounts the section.
  it("requests the expand for the selected layer's kind", () => {
    const video = videoLayer("v-1", "m-1");
    seed([video, audioLayer("a-1", "m-1")], "v-1", true);
    openPausesForSelection();
    expect(mocks.requestPropSectionExpand).toHaveBeenCalledWith("VideoClip", "pauses");
  });

  it("requests it on the Audio layer's own kind", () => {
    seed([audioLayer("a-1", "m-1")], "a-1");
    openPausesForSelection();
    expect(mocks.requestPropSectionExpand).toHaveBeenCalledWith("Audio", "pauses");
  });

  // A palette entry built before the selection changed can still reach here.
  it("does nothing with no selection", () => {
    seed([audioLayer("a-1", "m-1")], null);
    openPausesForSelection();
    expect(mocks.requestPropSectionExpand).not.toHaveBeenCalled();
  });
});
