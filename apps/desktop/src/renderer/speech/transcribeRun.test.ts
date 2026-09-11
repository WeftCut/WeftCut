import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";

const mocks = vi.hoisted(() => ({
  transcribeClip: vi.fn(),
  applySubtitles: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    transcribeClip: mocks.transcribeClip,
    applySubtitles: mocks.applySubtitles,
    logEmit: mocks.logEmit,
  };
});

import { runTranscribe, setTranscribing, useTranscribeRunStore } from "./transcribeRun";

/// One transcript envelope — only `srt`, `segments` and `backend` are read by
/// the run.
function transcript(cues = 3, over: { backend?: string; srt?: string } = {}) {
  return {
    backend: over.backend ?? "openai",
    segments: Array.from({ length: cues }, (_, i) => ({
      t_start_us: i * 1_000_000,
      t_end_us: (i + 1) * 1_000_000,
      text: `line ${i}`,
      words: [],
    })),
    language: "en",
    word_timing: "interpolated_from_cue" as const,
    srt: over.srt ?? "1\n00:00:00,000 --> 00:00:01,000\nline 0\n\n",
  };
}

/// The shape an IPC rejection actually reaches the renderer in: Electron wraps
/// the main-side message in its own prose, and the actionable half is inside.
function ipcError(message: string): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${message}`,
  );
}

const CLIPS = [
  { layerId: "l-1", label: "interview.mov" },
  { layerId: "l-2", label: "broll.mov" },
  { layerId: "l-3", label: "vo.wav" },
];

describe("runTranscribe", () => {
  const reveal = vi.fn();
  const target = () => ({ clips: CLIPS.slice(0, 1), revealCaptions: reveal });
  const many = () => ({ clips: CLIPS, revealCaptions: reveal });
  const rows = () => mocks.logEmit.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    mocks.transcribeClip.mockReset().mockResolvedValue(transcript());
    mocks.applySubtitles.mockReset().mockResolvedValue("track-cap");
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    reveal.mockReset();
    setTranscribing(false);
  });
  afterEach(() => setTranscribing(false));

  // The two steps in order, and the second fed by the first: the write half
  // takes the `srt` the read half rendered, never a body built here. No
  // language goes on the wire — detection is the engine's, not a field's.
  it("transcribes with no language hint, then applies the returned SRT", async () => {
    expect(await runTranscribe(target())).toBe("");
    expect(mocks.transcribeClip).toHaveBeenCalledWith("l-1");
    expect(mocks.applySubtitles).toHaveBeenCalledWith(transcript().srt);
  });

  // A landed transcript is invisible until its editor is open, so a success
  // that revealed nothing would read as a command that did nothing.
  it("reveals the caption panel on success, after the flag clears", async () => {
    reveal.mockImplementation(() => {
      expect(useTranscribeRunStore.getState().transcribing).toBe(false);
    });
    await runTranscribe(target());
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("reports the cue count and the engine that served the request", async () => {
    await runTranscribe(target());
    expect(rows()[0]).toMatchObject({
      i18n_key: "log.auto_caption_started",
      i18n_args: { clip: "interview.mov" },
      op_state: { state: "Started" },
    });
    expect(rows()[1]).toMatchObject({
      i18n_key: "log.auto_caption_done",
      i18n_args: { cues: 3, engine: "openai" },
      op_state: { state: "Ok" },
    });
    // One op, two rows: the terminal row has to join the Started one or the
    // status badge spins forever.
    expect(rows()[0].op_id).toBe(rows()[1].op_id);
  });

  // ADR 0070: N reads, one write. The reads go one at a time in the order
  // given, and every transcript that came back lands in ONE `apply_subtitles`
  // call — one history row, one undo, and the packing sees every cue at once.
  // The bodies concatenate as rendered: each ends in a blank line and the
  // parser reads the `-->` lines, not the numbering.
  it("transcribes several clips one at a time, in order, and applies every transcript in one call", async () => {
    const order: string[] = [];
    let inFlight = 0;
    mocks.transcribeClip.mockImplementation(async (id: string) => {
      order.push(id);
      inFlight += 1;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      inFlight -= 1;
      return transcript(2, { srt: `1\n00:00:00,000 --> 00:00:01,000\n${id}\n\n` });
    });
    expect(await runTranscribe(many())).toBe("");
    expect(order).toEqual(["l-1", "l-2", "l-3"]);
    expect(mocks.applySubtitles).toHaveBeenCalledTimes(1);
    expect(mocks.applySubtitles).toHaveBeenCalledWith(
      ["l-1", "l-2", "l-3"].map((id) => `1\n00:00:00,000 --> 00:00:01,000\n${id}\n\n`).join(""),
    );
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // Several clips are counted, not named — their names are in the Caption
  // Panel the moment the cues land. The done row sums the cues and lists every
  // engine that served, so a resolver that changed its mind mid-run is visible.
  it("counts the clips on the Started row and sums cues and engines on the done row", async () => {
    mocks.transcribeClip
      .mockResolvedValueOnce(transcript(3, { backend: "openai" }))
      .mockResolvedValueOnce(transcript(4, { backend: "whisper_cpp" }))
      .mockResolvedValueOnce(transcript(5, { backend: "openai" }));
    await runTranscribe(many());
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({
      i18n_key: "log.auto_caption_started_many",
      i18n_args: { count: 3 },
      op_state: { state: "Started" },
    });
    expect(rows()[1]).toMatchObject({
      i18n_key: "log.auto_caption_done",
      i18n_args: { cues: 12, engine: "openai, whisper_cpp" },
      op_state: { state: "Ok" },
    });
  });

  // Stop at the first failure, land what came back: an engine-wide failure
  // (no model, no key) fails the first clip before anything is billed, and a
  // per-clip one (over the payload cap) must not throw away the transcripts
  // already paid for. The log says both things — the cues that landed as a
  // plain row, and the clip that failed BY NAME as the row that closes the op.
  it("stops at the first clip that fails, lands the transcripts before it, and names the clip", async () => {
    mocks.transcribeClip
      .mockResolvedValueOnce(transcript(3, { srt: "one\n\n" }))
      .mockRejectedValueOnce(ipcError("audio payload too large for the provider (13 min limit); narrow the window"));
    expect(await runTranscribe(many())).toBe(
      "Error: audio payload too large for the provider (13 min limit); narrow the window",
    );
    expect(mocks.transcribeClip).toHaveBeenCalledTimes(2);
    expect(mocks.applySubtitles).toHaveBeenCalledTimes(1);
    expect(mocks.applySubtitles).toHaveBeenCalledWith("one\n\n");
    expect(rows()).toHaveLength(3);
    expect(rows()[1]).toMatchObject({ i18n_key: "log.auto_caption_done", i18n_args: { cues: 3 } });
    expect(rows()[1].op_state).toBeUndefined();
    expect(rows()[2]).toMatchObject({
      level: "error",
      i18n_key: "log.auto_caption_failed",
      i18n_args: { clip: "broll.mov" },
      op_id: rows()[0].op_id,
      op_state: { state: "Err" },
    });
    expect(rows()[2].message).toContain("broll.mov");
    expect(rows()[2].message).toContain("audio payload too large");
    // Cues landed, so the panel is revealed; and the run is over.
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(useTranscribeRunStore.getState().transcribing).toBe(false);
  });

  it("applies nothing and reveals nothing when the first clip fails", async () => {
    mocks.transcribeClip.mockRejectedValueOnce(ipcError("no transcription model available — select and prepare a model in Settings → Transcription"));
    expect(await runTranscribe(many())).toContain("Settings → Transcription");
    expect(mocks.transcribeClip).toHaveBeenCalledTimes(1);
    expect(mocks.applySubtitles).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({ i18n_args: { clip: "interview.mov" }, op_state: { state: "Err" } });
  });

  // Each named error class keeps its OWN sentence: the whole value of these
  // messages is the instruction they carry, and a generic failure discards it.
  // With no dialog there is no inline slot, so the sentence is what the
  // command gets back AND what the status log shows, under the run's own op.
  it.each([
    [
      "no model prepared",
      "no transcription model available — select and prepare a model in Settings → Transcription",
    ],
    [
      "PayloadTooLarge",
      "audio payload too large for the provider (13 min limit); narrow the window",
    ],
    [
      "a re-timed clip",
      "layer l-1 has speed 2 != 1.0; split a speed-1 segment first",
    ],
    ["a missing key", "no API key configured for openai; configure it in Settings → Transcription"],
  ])("answers the tool's own message for %s and closes the op as Err", async (_name, message) => {
    mocks.transcribeClip.mockRejectedValue(ipcError(message));
    expect(await runTranscribe(target())).toBe(`Error: ${message}`);
    // Nothing was written and nothing was revealed.
    expect(mocks.applySubtitles).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({ op_id: rows()[0].op_id, op_state: { state: "Err" } });
    expect(rows()[1].message).toContain(message);
  });

  // A failure clears the in-flight flag: leaving it set would grey the command
  // out for the rest of the session.
  it("re-arms after a failure", async () => {
    mocks.transcribeClip.mockRejectedValueOnce(ipcError("boom"));
    await runTranscribe(target());
    expect(useTranscribeRunStore.getState().transcribing).toBe(false);
    mocks.transcribeClip.mockResolvedValue(transcript());
    expect(await runTranscribe(target())).toBe("");
  });

  // A write failure after a successful read is still a failure of the run —
  // the caption track is the half that touches the project — and it is the row
  // that closes the op.
  it("answers the apply step's failure when that is the one that fails", async () => {
    mocks.applySubtitles.mockRejectedValue(ipcError("caption track refused"));
    expect(await runTranscribe(target())).toBe("Error: caption track refused");
    expect(reveal).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({ op_id: rows()[0].op_id, op_state: { state: "Err" } });
    expect(rows()[1].message).toContain("caption track refused");
  });

  // A second run would bill a second request and race two caption tracks onto
  // the timeline. The command greys out through the same flag; this is the
  // belt under that suspender for a palette entry built before the flag flipped.
  it("refuses to start while another run is in flight", async () => {
    setTranscribing(true);
    expect(await runTranscribe(target())).toBe("");
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
    expect(mocks.logEmit).not.toHaveBeenCalled();
  });

  it("does nothing for an empty clip list", async () => {
    expect(await runTranscribe({ clips: [], revealCaptions: reveal })).toBe("");
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
    expect(mocks.logEmit).not.toHaveBeenCalled();
    expect(useTranscribeRunStore.getState().transcribing).toBe(false);
  });
});
