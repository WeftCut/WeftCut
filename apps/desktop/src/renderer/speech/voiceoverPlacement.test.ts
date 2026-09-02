import { describe, expect, it } from "vitest";

import type { CompositionSummary, TrackSummary } from "../ipc";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";
import {
  defaultVoiceoverTrackId,
  rootOrNull,
  voiceoverStartUs,
  voiceoverTrackOptions,
  VOICEOVER_SPEED_DEFAULT,
  VOICEOVER_VOICES,
} from "./voiceoverPlacement";

function track(id: string, label: string | null): TrackSummary {
  return {
    id,
    kind: "Audio",
    label,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [],
  };
}

function root(over: Partial<CompositionSummary> = {}): CompositionSummary {
  return compositionFixture(over);
}

describe("rootOrNull", () => {
  // Not `rootCompositionOf`, which throws: a dialog renders before a project
  // exists, and "no project yet" is an ordinary state there.
  it("answers null instead of throwing before a project is open", () => {
    expect(rootOrNull(null)).toBeNull();
  });

  it("resolves the root composition of a summary", () => {
    const summary = summaryFixture({ root: { duration_us: 5_000_000 } });
    expect(rootOrNull(summary)?.duration_us).toBe(5_000_000);
  });
});

describe("defaultVoiceoverTrackId", () => {
  // The number the hybrid arm's own `ensureAudioTrack` produces: the LAST track
  // of the root. Mirrored so the dialog can state the destination and then send
  // it explicitly.
  it("is the last track of the root composition", () => {
    const comp = root({ tracks: [track("t-1", "A"), track("t-2", "B"), track("t-3", "C")] });
    expect(defaultVoiceoverTrackId(comp)).toBe("t-3");
  });

  it("is null when the project has no track and when there is no project", () => {
    expect(defaultVoiceoverTrackId(root({ tracks: [] }))).toBeNull();
    expect(defaultVoiceoverTrackId(null)).toBeNull();
  });
});

describe("voiceoverTrackOptions", () => {
  // Every track, not only the audio-role ones: a track carries no kind
  // restriction, so filtering would hide destinations the actor accepts.
  it("offers every track in project order", () => {
    const comp = root({ tracks: [track("t-1", "A"), track("t-2", null)] });
    expect(voiceoverTrackOptions(comp).map((tr) => tr.id)).toEqual(["t-1", "t-2"]);
    expect(voiceoverTrackOptions(null)).toEqual([]);
  });
});

describe("voiceoverStartUs", () => {
  it("appends past the composition's current duration", () => {
    expect(voiceoverStartUs("append", root({ duration_us: 4_500_000 }), 1_000_000)).toBe(
      4_500_000,
    );
  });

  it("starts at the playhead when asked, ignoring the duration", () => {
    expect(voiceoverStartUs("playhead", root({ duration_us: 4_500_000 }), 1_234_567)).toBe(
      1_234_567,
    );
  });

  // Clamped, but deliberately NOT frame-snapped: audio placement is sub-frame
  // by design, so quantizing would move the layer off the moment pointed at.
  it("clamps below zero and keeps a sub-frame playhead exactly", () => {
    expect(voiceoverStartUs("playhead", root(), -50)).toBe(0);
    expect(voiceoverStartUs("playhead", root({ fps_num: 30, fps_den: 1 }), 40_001)).toBe(
      40_001,
    );
  });

  it("appends at zero with no project at all", () => {
    expect(voiceoverStartUs("append", null, 900_000)).toBe(0);
  });
});

describe("voiceover parameter set", () => {
  // The six the tool's schema names, in its order — and `alloy` first, which is
  // why it is the field's default.
  it("mirrors the tool's voice list and defaults to its first entry", () => {
    expect([...VOICEOVER_VOICES]).toEqual([
      "alloy",
      "echo",
      "fable",
      "onyx",
      "nova",
      "shimmer",
    ]);
    expect(VOICEOVER_VOICES[0]).toBe("alloy");
  });

  it("defaults speed to the provider default", () => {
    expect(VOICEOVER_SPEED_DEFAULT).toBe(1.0);
  });
});
