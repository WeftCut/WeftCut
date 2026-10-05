// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";
import { TranscriptionInputDialog } from "./TranscriptionInputDialog";
import { answerTranscriptionInput, useTranscriptionInputPrompt } from "./transcriptionInputPrompt";

afterEach(() => { cleanup(); answerTranscriptionInput("cancel"); });

function open() {
  const resolve = vi.fn();
  useTranscriptionInputPrompt.setState({ pending: { resolve, issues: [
    { layerId: "quiet", label: "quiet.wav", kind: "quiet", peakDbfs: -28 },
    { layerId: "pending", label: "pending.wav", kind: "unavailable" },
  ] } });
  render(<TranscriptionInputDialog />);
  return resolve;
}

describe("transcription input warning", () => {
  it("explains risks and original-volume behavior before allowing continuation", () => {
    const resolve = open();
    expect(screen.getByText(/may miss words or detect the wrong language/)).toBeTruthy();
    expect(screen.getByText(/waveforms may still be preparing/)).toBeTruthy();
    expect(screen.getByText(/media files and timeline volume stay unchanged/)).toBeTruthy();
    expect(screen.getByText(/estimated boost \+24.0 dB/)).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue at original volume" }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ normalizeLayerIds: [] });
    expect(useTranscriptionInputPrompt.getState().pending).toBeNull();
  });

  it("cancels on dismiss instead of silently proceeding", () => {
    const resolve = open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("offers normalization only as an explicit choice for measured, non-silent clips", () => {
    const resolve = open();
    fireEvent.click(screen.getByRole("button", { name: "Normalize and transcribe" }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ normalizeLayerIds: ["quiet"] });
  });

  it("does not offer amplification for silence or unchecked sources", () => {
    useTranscriptionInputPrompt.setState({ pending: { resolve: vi.fn(), issues: [
      { layerId: "silent", label: "silent.wav", kind: "quiet", peakDbfs: null },
      { layerId: "unknown", label: "unknown.wav", kind: "unavailable" },
    ] } });
    render(<TranscriptionInputDialog />);
    expect(screen.queryByRole("button", { name: "Normalize and transcribe" })).toBeNull();
  });
});
