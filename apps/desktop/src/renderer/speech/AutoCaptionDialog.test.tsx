// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { AutoCaptionDialog } from "./AutoCaptionDialog";
import {
  closeAutoCaptionPrompt,
  openAutoCaptionPrompt,
  useAutoCaptionPromptStore,
} from "./autoCaptionPrompt";

/// One transcript envelope — only `srt` and `segments` are read by the dialog.
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

function language(): HTMLInputElement {
  return screen.getByLabelText("Language") as HTMLInputElement;
}

function transcribeButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Transcribe" }) as HTMLButtonElement;
}

describe("AutoCaptionDialog", () => {
  const reveal = vi.fn();

  beforeEach(() => {
    mocks.transcribeClip.mockReset().mockResolvedValue(transcript());
    mocks.applySubtitles.mockReset().mockResolvedValue("track-cap");
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    reveal.mockReset();
    closeAutoCaptionPrompt();
  });
  afterEach(cleanup);

  it("renders nothing while no clip is queued", () => {
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    expect(screen.queryByText("Auto-caption")).toBeNull();
  });

  it("names the clip it will transcribe", () => {
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    expect(screen.getByText("interview.mov")).toBeTruthy();
  });

  // The two steps in order, and the second fed by the first: the write half
  // takes the `srt` the read half rendered, never a body built here.
  it("transcribes then applies the returned SRT", async () => {
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.click(transcribeButton());
    await waitFor(() => expect(mocks.applySubtitles).toHaveBeenCalled());
    expect(mocks.transcribeClip).toHaveBeenCalledWith("l-1", { language: "" });
    expect(mocks.applySubtitles).toHaveBeenCalledWith(transcript().srt);
  });

  it("passes a typed language hint through to the tool", async () => {
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.change(language(), { target: { value: "zh" } });
    fireEvent.click(transcribeButton());
    await waitFor(() => expect(mocks.transcribeClip).toHaveBeenCalled());
    expect(mocks.transcribeClip).toHaveBeenCalledWith("l-1", { language: "zh" });
  });

  // A landed transcript is invisible until its editor is open, so a success
  // that revealed nothing would read as a command that did nothing.
  it("closes and reveals the caption panel on success", async () => {
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.click(transcribeButton());
    await waitFor(() =>
      expect(useAutoCaptionPromptStore.getState().target).toBeNull(),
    );
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("reports the cue count and the engine that served the request", async () => {
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.click(transcribeButton());
    await waitFor(() =>
      expect(useAutoCaptionPromptStore.getState().target).toBeNull(),
    );
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
  it.each([
    [
      "no backend configured",
      "no transcription backend available; configure one in Settings → Transcription",
    ],
    [
      "PayloadTooLarge",
      "audio payload too large for the provider (13 min limit); narrow the window",
    ],
    [
      "a re-timed clip",
      "layer l-1 has speed 2 != 1.0; split a speed-1 segment first",
    ],
    ["a missing key", "no API key configured for openai"],
  ])("surfaces the tool's own message for %s", async (_name, message) => {
    mocks.transcribeClip.mockRejectedValue(ipcError(message));
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.click(transcribeButton());
    await waitFor(() => expect(screen.getByText(`Error: ${message}`)).toBeTruthy());
    // Still open, so the language typed and the clip picked are not thrown away
    // with the failure — and nothing was written.
    expect(useAutoCaptionPromptStore.getState().target).not.toBeNull();
    expect(mocks.applySubtitles).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  // A failure clears the in-flight flag: leaving it set would grey the command
  // out for the rest of the session.
  it("re-arms after a failure", async () => {
    mocks.transcribeClip.mockRejectedValueOnce(ipcError("boom"));
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.click(transcribeButton());
    await waitFor(() => expect(screen.getByText("Error: boom")).toBeTruthy());
    expect(useAutoCaptionPromptStore.getState().transcribing).toBe(false);
    expect(transcribeButton().disabled).toBe(false);
  });

  // A write failure after a successful read must not close the dialog either —
  // the caption track is the half that touches the project.
  it("keeps the dialog open when the apply step is the one that fails", async () => {
    mocks.applySubtitles.mockRejectedValue(ipcError("caption track refused"));
    openAutoCaptionPrompt("l-1", "interview.mov");
    render(<AutoCaptionDialog onRevealCaptions={reveal} />);
    fireEvent.click(transcribeButton());
    await waitFor(() =>
      expect(screen.getByText("Error: caption track refused")).toBeTruthy(),
    );
    expect(useAutoCaptionPromptStore.getState().target).not.toBeNull();
    expect(reveal).not.toHaveBeenCalled();
  });
});
