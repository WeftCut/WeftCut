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

/// One transcript envelope — only `srt` and `segments` are read by the run.
function transcript(cues = 3) {
  return {
    backend: "openai",
    segments: Array.from({ length: cues }, (_, i) => ({
      t_start_us: i * 1_000_000,
      t_end_us: (i + 1) * 1_000_000,
      text: `line ${i}`,
      words: [],
    })),
    language: "en",
    word_timing: "interpolated_from_cue" as const,
    srt: "1\n00:00:00,000 --> 00:00:01,000\nline 0\n",
  };
}

/// The shape an IPC rejection actually reaches the renderer in: Electron wraps
/// the main-side message in its own prose, and the actionable half is inside.
function ipcError(message: string): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${message}`,
  );
}

describe("runTranscribe", () => {
  const reveal = vi.fn();
  const target = () => ({ layerId: "l-1", label: "interview.mov", revealCaptions: reveal });

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
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.auto_caption_started",
      i18n_args: { clip: "interview.mov" },
      op_state: { state: "Started" },
    });
    expect(rows[1]).toMatchObject({
      i18n_key: "log.auto_caption_done",
      i18n_args: { cues: 3, engine: "openai" },
      op_state: { state: "Ok" },
    });
    // One op, two rows: the terminal row has to join the Started one or the
    // status badge spins forever.
    expect(rows[0].op_id).toBe(rows[1].op_id);
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
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ op_id: rows[0].op_id, op_state: { state: "Err" } });
    expect(rows[1].message).toContain(message);
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
  // the caption track is the half that touches the project.
  it("answers the apply step's failure when that is the one that fails", async () => {
    mocks.applySubtitles.mockRejectedValue(ipcError("caption track refused"));
    expect(await runTranscribe(target())).toBe("Error: caption track refused");
    expect(reveal).not.toHaveBeenCalled();
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
});
