import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmTranscriptionInput, answerTranscriptionInput, useTranscriptionInputPrompt } from "./transcriptionInputPrompt";
import { runTranscribe, setTranscribing } from "./transcribeRun";

const mocks = vi.hoisted(() => ({
  getWaveformLevels: vi.fn(), getWaveformTile: vi.fn(), logEmit: vi.fn(),
  transcribeClip: vi.fn(), applyTranscripts: vi.fn(),
}));
vi.mock("../ipc", async importActual => ({ ...await importActual<typeof import("../ipc")>(), ...mocks }));

const source = { layerId: "clip", label: "speech.wav", mediaId: "media", sourceStartUs: 0, sourceEndUs: 1_000_000 };
const target = () => ({ projectId: "project", compositionId: "composition", clips: [source], revealCaptions: vi.fn(), confirmInput: () => confirmTranscriptionInput([source]) });

beforeEach(() => {
  setTranscribing(false);
  mocks.getWaveformLevels.mockReset().mockResolvedValue({ channels: 1, levels: [{ level: 0, peaksPerSecond: 1, peakCount: 1 }] });
  mocks.getWaveformTile.mockReset().mockResolvedValue({ peaksPerSecond: 1, min: [-0.04], max: [0.04], rms: [0.01] });
  mocks.logEmit.mockReset().mockResolvedValue(undefined);
  mocks.transcribeClip.mockReset().mockResolvedValue({ backend: "whisper_cpp", segments: [], word_timing: "exact" });
  mocks.applyTranscripts.mockReset().mockResolvedValue("caption-track");
});
afterEach(() => { answerTranscriptionInput("cancel"); setTranscribing(false); });

describe("transcription input preflight integration", () => {
  it("shows the measured warning and only transcribes after explicit continuation", async () => {
    const run = runTranscribe(target());
    await vi.waitFor(() => expect(useTranscriptionInputPrompt.getState().pending?.issues).toMatchObject([{ kind: "quiet" }]));
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
    expect(mocks.logEmit).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", i18n_key: "log.auto_caption_quiet" }));
    answerTranscriptionInput("original");
    await run;
    expect(mocks.transcribeClip).toHaveBeenCalledExactlyOnceWith("clip");
  });

  it("continues without a prompt when measured source volume is normal", async () => {
    mocks.getWaveformTile.mockResolvedValue({ peaksPerSecond: 1, min: [-0.4], max: [0.4], rms: [0.1] });
    await runTranscribe(target());
    expect(useTranscriptionInputPrompt.getState().pending).toBeNull();
    expect(mocks.transcribeClip).toHaveBeenCalledExactlyOnceWith("clip");
  });

  it("allows cancelling an unavailable check before any inference or write", async () => {
    mocks.getWaveformLevels.mockRejectedValue(new Error("not_ready"));
    const run = runTranscribe(target());
    await vi.waitFor(() => expect(useTranscriptionInputPrompt.getState().pending?.issues).toMatchObject([{ kind: "unavailable" }]));
    answerTranscriptionInput("cancel");
    await run;
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
    expect(mocks.applyTranscripts).not.toHaveBeenCalled();
  });

  it("normalizes only the opted-in clips and logs the actual applied gain", async () => {
    mocks.transcribeClip.mockResolvedValue({ backend: "whisper_cpp", segments: [], word_timing: "exact",
      input_normalization: { input_peak_dbfs: -27, gain_db: 24, target_peak_dbfs: -3, max_gain_db: 24 } });
    const run = runTranscribe(target());
    await vi.waitFor(() => expect(useTranscriptionInputPrompt.getState().pending).not.toBeNull());
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
    answerTranscriptionInput("normalize");
    await run;
    expect(mocks.transcribeClip).toHaveBeenCalledExactlyOnceWith("clip", { normalizeAudio: true });
    expect(mocks.logEmit).toHaveBeenCalledWith(expect.objectContaining({
      i18n_key: "log.auto_caption_normalized", details: expect.objectContaining({ gain_db: 24 }),
    }));
    // The next run's original-volume choice must not inherit normalization.
    mocks.transcribeClip.mockClear();
    const next = runTranscribe(target());
    await vi.waitFor(() => expect(useTranscriptionInputPrompt.getState().pending).not.toBeNull());
    answerTranscriptionInput("original");
    await next;
    expect(mocks.transcribeClip).toHaveBeenCalledExactlyOnceWith("clip");
  });
});
