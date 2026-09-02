// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "../i18n";

const mocks = vi.hoisted(() => ({
  detectSilences: vi.fn(),
  markSilences: vi.fn(),
  logEmit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    detectSilences: mocks.detectSilences,
    markSilences: mocks.markSilences,
    logEmit: mocks.logEmit,
  };
});
vi.mock("@/bridge/events", () => ({
  listen: mocks.listen,
}));

import { SilenceDialog } from "./SilenceDialog";
import { closeSilencePrompt, openSilencePrompt, useSilencePromptStore } from "./silencePrompt";

/// The shape an IPC rejection actually reaches the renderer in: Electron wraps
/// the main-side message in its own prose, and the actionable half is inside.
function ipcError(message: string): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${message}`,
  );
}

/// Rust's own words while a source's waveform job is still running. Verbatim,
/// because recognising this sentence is what turns a failure into a wait.
const WAVEFORM_PENDING = ipcError(
  "waveform not generated yet for media m-1 — wait for a media:job_complete event with kind=waveform and retry",
);

function open(): void {
  openSilencePrompt({ layerId: "l-1", layerName: "interview.mov", mediaId: "m-1" });
}

function markButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Mark silences" }) as HTMLButtonElement;
}

/// The handler the dialog registered for `media:job_complete`, or null when it
/// registered none.
function waveformHandler():
  | ((e: { event: string; id: number; payload: { media_id: string; kind: string } }) => void)
  | null {
  const call = mocks.listen.mock.calls.find((c) => c[0] === "media:job_complete");
  return call ? (call[1] as never) : null;
}

describe("SilenceDialog", () => {
  beforeEach(() => {
    mocks.detectSilences.mockReset().mockResolvedValue([
      { t_start_us: 1_000_000, t_end_us: 2_500_000 },
      { t_start_us: 4_000_000, t_end_us: 4_800_000 },
    ]);
    mocks.markSilences.mockReset().mockResolvedValue({
      markers: 2,
      marker_ids: ["mk-1", "mk-2"],
    });
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
    closeSilencePrompt();
  });
  afterEach(cleanup);

  it("renders nothing while no clip is queued", () => {
    render(<SilenceDialog />);
    expect(screen.queryByText("Detect silences")).toBeNull();
  });

  it("names the clip it will measure", () => {
    open();
    render(<SilenceDialog />);
    expect(screen.getByText("interview.mov")).toBeTruthy();
  });

  // The recipe's own defaults, and the dialog reads them from ONE place — a
  // preview taken at a different threshold from the mark it produces is the
  // failure this pins down.
  it("detects at the recipe defaults as soon as it opens", async () => {
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(mocks.detectSilences).toHaveBeenCalled());
    expect(mocks.detectSilences).toHaveBeenCalledWith({
      layerId: "l-1",
      thresholdAmp: 0.02,
      minSilenceUs: 500_000,
    });
  });

  it("previews the count, the total and every range", async () => {
    open();
    render(<SilenceDialog />);
    // 1.5s + 0.8s of silence across two ranges.
    await waitFor(() =>
      expect(screen.getByText("2 silent ranges, 00:00:02.300 in total")).toBeTruthy(),
    );
    expect(screen.getByText("00:00:01.000 – 00:00:02.500")).toBeTruthy();
    expect(screen.getByText("00:00:04.000 – 00:00:04.800")).toBeTruthy();
  });

  // The threshold's own unit is amplitude because that is what the tool takes;
  // the dBFS figure is the annotation, so both have to be on screen.
  it("annotates the amplitude threshold with its dBFS equivalent", async () => {
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(mocks.detectSilences).toHaveBeenCalled());
    expect(screen.getByText("Peak amplitude, roughly -34.0 dBFS.")).toBeTruthy();
  });

  // The acceptance the live control exists for: a parameter change is a fresh
  // detection, and the mark that follows uses the very same numbers.
  it("re-detects on a parameter change and marks at the same values", async () => {
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(mocks.detectSilences).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Shortest silence"), {
      target: { value: "800" },
    });
    await waitFor(() =>
      expect(mocks.detectSilences).toHaveBeenLastCalledWith({
        layerId: "l-1",
        thresholdAmp: 0.02,
        minSilenceUs: 800_000,
      }),
    );
    fireEvent.click(markButton());
    await waitFor(() => expect(mocks.markSilences).toHaveBeenCalled());
    expect(mocks.markSilences).toHaveBeenCalledWith({
      layerId: "l-1",
      thresholdAmp: 0.02,
      minSilenceUs: 800_000,
    });
  });

  it("says so plainly and writes nothing when nothing is silent", async () => {
    mocks.detectSilences.mockResolvedValue([]);
    open();
    render(<SilenceDialog />);
    await waitFor(() =>
      expect(screen.getByText("No silence above this threshold")).toBeTruthy(),
    );
    expect(markButton().disabled).toBe(true);
    fireEvent.click(markButton());
    expect(mocks.markSilences).not.toHaveBeenCalled();
  });

  // A fresh import's real state. The refusal is a WAIT, not a failure: showing
  // it as an error would report a job that is simply still running.
  it("waits for the waveform instead of reporting a failure", async () => {
    mocks.detectSilences.mockRejectedValue(WAVEFORM_PENDING);
    open();
    render(<SilenceDialog />);
    await waitFor(() =>
      expect(screen.getByText("Waiting for the waveform…")).toBeTruthy(),
    );
    // And nothing in the error slot — the sentence above IS the whole report.
    expect(screen.queryByText(/waveform not generated yet/)).toBeNull();
    expect(markButton().disabled).toBe(true);
  });

  it("retries once the waveform job completes, and only for its own media", async () => {
    mocks.detectSilences.mockRejectedValueOnce(WAVEFORM_PENDING);
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(waveformHandler()).not.toBeNull());
    const fire = waveformHandler()!;
    // Another source's waveform, and a different job on this one: neither is
    // the event this dialog is waiting for.
    fire({ event: "media:job_complete", id: 0, payload: { media_id: "m-2", kind: "waveform" } });
    fire({ event: "media:job_complete", id: 1, payload: { media_id: "m-1", kind: "proxy" } });
    expect(mocks.detectSilences).toHaveBeenCalledTimes(1);
    fire({ event: "media:job_complete", id: 2, payload: { media_id: "m-1", kind: "waveform" } });
    await waitFor(() =>
      expect(screen.getByText("2 silent ranges, 00:00:02.300 in total")).toBeTruthy(),
    );
  });

  // A listener left behind would keep a dismissed dialog issuing reads nobody
  // is looking at.
  it("drops the waveform listener when it closes", async () => {
    mocks.detectSilences.mockRejectedValue(WAVEFORM_PENDING);
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(waveformHandler()).not.toBeNull());
    closeSilencePrompt();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalled());
  });

  it("marks, reports the count under one op, and closes", async () => {
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(mocks.detectSilences).toHaveBeenCalled());
    fireEvent.click(markButton());
    await waitFor(() =>
      expect(useSilencePromptStore.getState().target).toBeNull(),
    );
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.mark_silences_started",
      i18n_args: { clip: "interview.mov" },
      op_state: { state: "Started" },
    });
    expect(rows[1]).toMatchObject({
      i18n_key: "log.mark_silences_done",
      i18n_args: { markers: 2, clip: "interview.mov" },
      op_state: { state: "Ok" },
    });
    // One op, two rows: the terminal row has to join the Started one or the
    // status badge spins forever.
    expect(rows[0].op_id).toBe(rows[1].op_id);
  });

  // The tool's own message, verbatim: it names the layer kind it refuses or the
  // parameter range it rejects, and a generic "marking failed" would throw the
  // actionable half away.
  it("surfaces a mark failure inline and stays open", async () => {
    mocks.markSilences.mockRejectedValue(
      ipcError("threshold_amp 1.5 must be in [0.0, 1.0]"),
    );
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(mocks.detectSilences).toHaveBeenCalled());
    fireEvent.click(markButton());
    await waitFor(() =>
      expect(screen.getByText("Error: threshold_amp 1.5 must be in [0.0, 1.0]")).toBeTruthy(),
    );
    expect(useSilencePromptStore.getState().target).not.toBeNull();
    // Re-armed: a stuck in-flight flag would grey the button for good.
    expect(markButton().disabled).toBe(false);
  });

  it("reports a detection failure that is NOT the waveform wait", async () => {
    mocks.detectSilences.mockRejectedValue(
      ipcError("layer l-1 kind is not analyzable for silence"),
    );
    open();
    render(<SilenceDialog />);
    await waitFor(() =>
      expect(
        screen.getByText("Error: layer l-1 kind is not analyzable for silence"),
      ).toBeTruthy(),
    );
    expect(markButton().disabled).toBe(true);
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  // Parameters left over from the last clip would be silently re-submitted.
  it("resets both parameters when a different clip opens it", async () => {
    open();
    render(<SilenceDialog />);
    await waitFor(() => expect(mocks.detectSilences).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Shortest silence"), {
      target: { value: "800" },
    });
    await waitFor(() =>
      expect(mocks.detectSilences).toHaveBeenLastCalledWith(
        expect.objectContaining({ minSilenceUs: 800_000 }),
      ),
    );
    openSilencePrompt({ layerId: "l-2", layerName: "b-roll.mov", mediaId: "m-2" });
    await waitFor(() =>
      expect(mocks.detectSilences).toHaveBeenLastCalledWith({
        layerId: "l-2",
        thresholdAmp: 0.02,
        minSilenceUs: 500_000,
      }),
    );
  });
});
