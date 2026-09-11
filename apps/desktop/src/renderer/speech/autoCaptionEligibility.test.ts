import { beforeEach, describe, expect, it } from "vitest";

import {
  autoCaptionState,
  autoCaptionForSelection,
  transcribeSubjects,
  transcribeTargets,
} from "./autoCaptionEligibility";
import { setTranscribing } from "./transcribeRun";
import type { LayerSummary, LinkSummary, TrackSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  setLayerSelection,
  type Selection,
} from "../state/selectionStore";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";

const num = (value: number) => ({ mode: "Static" as const, value });

/// Where a clip sits and what it plays — the fields the subject rules read.
interface Placement {
  media?: string;
  srcIn?: number;
  tStart?: number;
  tEnd?: number;
}

function videoLayer(id: string, speed: number, at: Placement = {}): LayerSummary {
  const tStart = at.tStart ?? 0;
  const tEnd = at.tEnd ?? 2_000_000;
  return {
    id,
    label: null,
    t_start_us: tStart,
    t_end_us: tEnd,
    kind: "VideoClip",
    color_hint: "#4c8dd8",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: at.media ?? "m-1",
      media_label: "interview.mov",
      src_in_us: at.srcIn ?? 0,
      src_out_us: (at.srcIn ?? 0) + (tEnd - tStart),
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

function audioLayer(id: string, at: Placement = {}): LayerSummary {
  const tStart = at.tStart ?? 0;
  const tEnd = at.tEnd ?? 2_000_000;
  return {
    id,
    label: null,
    t_start_us: tStart,
    t_end_us: tEnd,
    kind: "Audio",
    color_hint: "#5aa88a",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Audio",
      media_id: at.media ?? "m-2",
      media_label: "vo.wav",
      src_in_us: at.srcIn ?? 0,
      src_out_us: (at.srcIn ?? 0) + (tEnd - tStart),
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

function trackWith(layers: LayerSummary[], id = "track-1"): TrackSummary {
  return {
    id,
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
const COMPOSITION = compositionFixture({ tracks: TRACKS });
const NONE: Selection = { kind: "none" };
const sel = (primary: string, ...rest: string[]): Selection => ({
  kind: "layers",
  primary,
  ids: new Set([primary, ...rest]),
});
const ids = (layers: readonly LayerSummary[]): string[] => layers.map((l) => l.id);

describe("autoCaptionState", () => {
  it("admits a normal-speed VideoClip and an Audio layer", () => {
    expect(autoCaptionState(sel("l-video"), COMPOSITION, false)).toBe("auto_caption");
    expect(autoCaptionState(sel("l-audio"), COMPOSITION, false)).toBe("auto_caption");
  });

  it("asks for a selection when nothing is selected, or when the summary has no such layer", () => {
    expect(autoCaptionState(NONE, COMPOSITION, false)).toBe("needs_selection");
    expect(autoCaptionState(sel("l-gone"), COMPOSITION, false)).toBe("needs_selection");
    expect(autoCaptionState(sel("l-video"), null, false)).toBe("needs_selection");
  });

  // Separate from needs_selection: "pick a clip" and "pick a clip with sound"
  // are different instructions.
  it("names the wrong kind rather than reporting no selection", () => {
    expect(autoCaptionState(sel("l-color"), COMPOSITION, false)).toBe("needs_audio_kind");
  });

  it("refuses a re-timed clip at the gesture, not at the tool", () => {
    expect(autoCaptionState(sel("l-fast"), COMPOSITION, false)).toBe("speed_not_one");
  });

  // Audio carries no speed field at all, so a speed gate must not be applied
  // to it — doing so would grey out every audio clip.
  it("applies no speed gate to an Audio layer", () => {
    expect(autoCaptionState(sel("l-audio"), COMPOSITION, false)).toBe("auto_caption");
  });

  // First, and regardless of the selection: a second run would bill a second
  // request and race two caption tracks onto the timeline.
  it("stands down while a transcription is in flight, whatever is selected", () => {
    expect(autoCaptionState(sel("l-video"), COMPOSITION, true)).toBe("transcribing");
    expect(autoCaptionState(NONE, COMPOSITION, true)).toBe("transcribing");
  });

  // The WHOLE selection (ADR 0070), not its primary: a marquee that caught a
  // title beside the clips has not changed what the user meant, so the other
  // kinds are ignored, and the press is refused only when nothing selected can
  // be transcribed.
  it("admits a multi-selection with one clip with sound in it, whatever else it holds", () => {
    expect(autoCaptionState(sel("l-color", "l-video"), COMPOSITION, false)).toBe("auto_caption");
    expect(autoCaptionState(sel("l-video", "l-color"), COMPOSITION, false)).toBe("auto_caption");
  });

  it("refuses a multi-selection in which nothing carries sound", () => {
    expect(autoCaptionState(sel("l-color", "l-gone"), COMPOSITION, false)).toBe("needs_audio_kind");
  });

  // Refused, not skipped: the user selected the re-timed clip meaning to
  // caption it, and a run that quietly left it out would read as a transcription
  // that missed some speech.
  it("refuses the whole press when any subject is re-timed", () => {
    expect(autoCaptionState(sel("l-video", "l-fast"), COMPOSITION, false)).toBe("speed_not_one");
    expect(autoCaptionState(sel("l-audio", "l-fast"), COMPOSITION, false)).toBe("speed_not_one");
  });
});

describe("transcribeSubjects", () => {
  // A linked A/V pair of one media (what a plain click selects), a picture clip
  // linked to a music bed of ANOTHER media, an unlinked clip after them, and a
  // title. The picture track lists its clips out of timeline order so the
  // ordering is the function's and not the fixture's.
  const pairV = videoLayer("pair-v", 1, { media: "m-pair", tStart: 0, tEnd: 4_000_000 });
  const pairA = audioLayer("pair-a", { media: "m-pair", tStart: 0, tEnd: 4_000_000 });
  const bedV = videoLayer("bed-v", 1, { media: "m-bed-v", tStart: 4_000_000, tEnd: 6_000_000 });
  const bedA = audioLayer("bed-a", { media: "m-music", tStart: 4_000_000, tEnd: 6_000_000 });
  const lone = videoLayer("lone-v", 1, { media: "m-lone", tStart: 6_000_000, tEnd: 8_000_000 });
  const title = colorLayer("title");
  const links: LinkSummary[] = [
    { id: "link-pair", label: null, layer_ids: ["pair-v", "pair-a"] },
    { id: "link-bed", label: null, layer_ids: ["bed-v", "bed-a"] },
  ];
  const comp = compositionFixture({
    tracks: [trackWith([lone, bedV, pairV, title], "t-pic"), trackWith([pairA, bedA], "t-aud")],
    links,
  });

  it("reads every selected clip with sound, in timeline order, and skips the other kinds", () => {
    expect(ids(transcribeSubjects(sel("lone-v", "title", "pair-a"), comp))).toEqual(["pair-a", "lone-v"]);
  });

  // Rule 1. A plain click on a linked clip selects both halves; the sound is
  // the layer that plays, and its own placement puts the words where the sound
  // is after an A/V slip.
  it("one subject per link: a picture clip yields to its selected same-media audio", () => {
    expect(ids(transcribeSubjects(sel("pair-v", "pair-a"), comp))).toEqual(["pair-a"]);
    expect(ids(transcribeSubjects(sel("pair-a", "pair-v"), comp))).toEqual(["pair-a"]);
  });

  // An `Alt`-click escaped the link: the picture clip is read from its own
  // file, as a single-clip transcription always was.
  it("a picture clip whose sound is not selected stays its own subject", () => {
    expect(ids(transcribeSubjects(sel("pair-v"), comp))).toEqual(["pair-v"]);
  });

  // The link rule is about the SAME media: a music bed is not the picture's
  // sound, so both are read.
  it("a link whose audio is another media keeps the picture's own track and the bed", () => {
    expect(new Set(ids(transcribeSubjects(sel("bed-v", "bed-a"), comp)))).toEqual(new Set(["bed-v", "bed-a"]));
  });

  // Rule 2. A separated-then-unlinked pair, a duplicated bed: the same audio in
  // two places is read once, and the longer layer is the one kept. A different
  // in-point is different audio and stays.
  it("the same source span is read once, keeping the longer layer", () => {
    const short = audioLayer("dup-short", { media: "m-dup", srcIn: 0, tStart: 10_000_000, tEnd: 12_000_000 });
    const long = audioLayer("dup-long", { media: "m-dup", srcIn: 0, tStart: 10_000_000, tEnd: 13_000_000 });
    const slipped = audioLayer("dup-slipped", { media: "m-dup", srcIn: 500_000, tStart: 10_000_000, tEnd: 12_000_000 });
    const dups = compositionFixture({ tracks: [trackWith([short], "t-1"), trackWith([long], "t-2"), trackWith([slipped], "t-3")] });
    expect(new Set(ids(transcribeSubjects(sel("dup-short", "dup-long", "dup-slipped"), dups)))).toEqual(
      new Set(["dup-long", "dup-slipped"]),
    );
  });

  it("answers nothing for a selection with no layers, or with no composition to read", () => {
    expect(transcribeSubjects(NONE, comp)).toEqual([]);
    expect(transcribeSubjects(sel("pair-v"), null)).toEqual([]);
  });
});

describe("autoCaptionForSelection / transcribeTargets", () => {
  beforeEach(() => {
    setTranscribing(false);
    clearLayerSelection();
    useProjectStore.getState().apply(summaryFixture({ root: { tracks: TRACKS } }));
  });

  it("reads the selection and the in-flight flag live", () => {
    expect(autoCaptionForSelection()).toBe("needs_selection");
    setLayerSelection("l-video", ["l-video"]);
    expect(autoCaptionForSelection()).toBe("auto_caption");
    setTranscribing(true);
    expect(autoCaptionForSelection()).toBe("transcribing");
    setTranscribing(false);
    expect(autoCaptionForSelection()).toBe("auto_caption");
  });

  // The whole set and not the primary: which clip was clicked last does not
  // change which clips carry speech.
  it("answers for the whole multi-selection, not its primary", () => {
    setLayerSelection("l-color", ["l-color", "l-video"]);
    expect(autoCaptionForSelection()).toBe("auto_caption");
    expect(ids(transcribeTargets())).toEqual(["l-video"]);
    setLayerSelection("l-video", ["l-video", "l-audio"]);
    expect(ids(transcribeTargets())).toEqual(["l-video", "l-audio"]);
  });
});
