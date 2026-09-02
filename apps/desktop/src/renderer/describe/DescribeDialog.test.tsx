// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n";

const mocks = vi.hoisted(() => ({
  describeClip: vi.fn(),
  getMediaDescription: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  describeClip: mocks.describeClip,
  getMediaDescription: mocks.getMediaDescription,
  logEmit: mocks.logEmit,
}));

import { DescribeDialog } from "./DescribeDialog";
import {
  closeDescribePrompt,
  openDescribePrompt,
  useDescribePromptStore,
} from "./describePrompt";
import {
  resetDescriptionsStore,
  useDescriptionsStore,
} from "./descriptionsStore";

/// The shape an IPC rejection actually reaches the renderer in: Electron wraps
/// the main-side message in its own prose, and the actionable half is inside.
function ipcError(message: string): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${message}`,
  );
}

/// Rust's own words when nothing is configured to describe with. Verbatim from
/// `vlm::NO_DESCRIBER_CONFIGURED`, because recognising this sentence is what
/// earns the remedy button — and showing it whole is what tells the user which
/// two things Settings wants.
const NO_BACKEND = ipcError(
  "no video-understanding backend available — configure a local engine " +
    "(llama-mtmd-cli binary + Qwen3-VL GGUF model + mmproj) in Settings, or " +
    "point WeftCut at an OpenAI-compatible endpoint",
);

const RESULT = {
  backend: "qwen3_vl",
  model: "Qwen3VL-4B-Instruct-Q4_K_M",
  segments: [
    { t_start_us: 0, t_end_us: 2_000_000, text: "a hallway", tags: ["interior"] },
    { t_start_us: 2_000_000, t_end_us: 4_000_000, text: "a street", tags: [] },
  ],
};

const reveal = vi.fn();
const openSettings = vi.fn();

function open(): void {
  openDescribePrompt({
    layerId: "l-1",
    layerName: "reel.mp4",
    mediaId: "m-1",
  });
}

function paint() {
  return render(
    <DescribeDialog onRevealShots={reveal} onOpenSettings={openSettings} />,
  );
}

function describeButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Describe" }) as HTMLButtonElement;
}

describe("DescribeDialog", () => {
  beforeEach(() => {
    mocks.describeClip.mockReset().mockResolvedValue(RESULT);
    mocks.getMediaDescription.mockReset().mockResolvedValue(null);
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    reveal.mockReset();
    openSettings.mockReset();
    closeDescribePrompt();
    resetDescriptionsStore();
  });
  afterEach(() => {
    cleanup();
    resetDescriptionsStore();
  });

  it("renders nothing while no clip is queued", () => {
    paint();
    expect(screen.queryByText("Describe content")).toBeNull();
  });

  it("names the clip it will describe", () => {
    open();
    paint();
    expect(screen.getByText("reel.mp4")).toBeTruthy();
  });

  // The defaults are the DEFAULT VIEW's key, so a plain confirm has to send
  // neither parameter — Rust's own defaults decide, and the result lands where
  // the shot rows can read it back.
  it("omits both parameters at their defaults", async () => {
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() => expect(mocks.describeClip).toHaveBeenCalled());
    expect(mocks.describeClip).toHaveBeenCalledWith({ layerId: "l-1" });
  });

  it("sends a sampling rate the user changed", async () => {
    open();
    paint();
    fireEvent.change(screen.getByLabelText("Sample"), { target: { value: "2" } });
    fireEvent.click(describeButton());
    await waitFor(() => expect(mocks.describeClip).toHaveBeenCalled());
    expect(mocks.describeClip).toHaveBeenCalledWith({ layerId: "l-1", fps: 2 });
  });

  // The honest line changes with the fields rather than sitting there as a
  // warning nobody re-reads.
  it("says a non-default sampling is not remembered", async () => {
    open();
    paint();
    expect(
      screen.getByText("Remembered for later sessions, and searchable, at these settings."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Sample"), { target: { value: "3" } });
    await waitFor(() =>
      expect(screen.getByText(/only descriptions made at 1.0 frames \/ second/)).toBeTruthy(),
    );
  });

  it("describes, reports the count and engine under one op, and reveals the Panel", async () => {
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(useDescribePromptStore.getState().target).toBeNull(),
    );
    expect(reveal).toHaveBeenCalledTimes(1);
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.describe_started",
      i18n_args: { clip: "reel.mp4" },
      op_state: { state: "Started" },
    });
    expect(rows[1]).toMatchObject({
      i18n_key: "log.describe_done",
      i18n_args: {
        clip: "reel.mp4",
        segments: 2,
        engine: "qwen3_vl",
        model: "Qwen3VL-4B-Instruct-Q4_K_M",
      },
      op_state: { state: "Ok" },
    });
    // One op, two rows: the terminal row has to join the Started one or the
    // status badge spins forever.
    expect(rows[0].op_id).toBe(rows[1].op_id);
  });

  it("publishes the run's segments so the rows fill without a second round trip", async () => {
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(useDescriptionsStore.getState().segments.get("m-1")).toEqual(
        RESULT.segments,
      ),
    );
  });

  // The re-read widens a row's prose with whatever else of this source has been
  // described. Only the default view has one to widen from.
  it("re-reads the persisted view after a default run", async () => {
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(mocks.getMediaDescription).toHaveBeenCalledWith("m-1"),
    );
  });

  // A custom run keeps its own answer: the default view's segments are not this
  // run's, and publishing them would overwrite the finer prose just computed.
  it("re-reads nothing after a run at a non-default sampling", async () => {
    open();
    paint();
    fireEvent.change(screen.getByLabelText("Sample"), { target: { value: "2" } });
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(useDescriptionsStore.getState().segments.get("m-1")).toEqual(
        RESULT.segments,
      ),
    );
    expect(mocks.getMediaDescription).not.toHaveBeenCalled();
  });

  // The tool's own message, verbatim, and the ONE failure with a remedy inside
  // the app gets the button that goes there.
  it("offers Settings when no engine is configured, and stays open", async () => {
    mocks.describeClip.mockRejectedValue(NO_BACKEND);
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(screen.getByText(/no video-understanding backend available/)).toBeTruthy(),
    );
    expect(screen.getByText(/llama-mtmd-cli binary \+ Qwen3-VL GGUF model \+ mmproj/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Settings → Video understanding" }),
    );
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(useDescribePromptStore.getState().target).not.toBeNull();
    // Re-armed: a stuck in-flight flag would grey the button for good.
    expect(describeButton().disabled).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });

  // Every other refusal shows itself and offers nothing: the sentence already
  // names what to go and do, and a Settings button would point at the wrong
  // remedy.
  it("shows a speed refusal verbatim with no Settings button", async () => {
    mocks.describeClip.mockRejectedValue(
      ipcError(
        "describe_clip does not yet support speed != 1.0 (layer speed=2); split off a speed-1 segment first",
      ),
    );
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(
        screen.getByText(/does not yet support speed != 1.0 \(layer speed=2\)/),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/split off a speed-1 segment first/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open Settings → Video understanding" }),
    ).toBeNull();
  });

  it("closes the op as Err when the run fails", async () => {
    mocks.describeClip.mockRejectedValue(NO_BACKEND);
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() => expect(mocks.logEmit).toHaveBeenCalledTimes(2));
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({
      op_id: rows[0].op_id,
      op_state: { state: "Err" },
      details: { context: "describe_clip" },
    });
  });

  it("clears the in-flight flag every way out", async () => {
    mocks.describeClip.mockRejectedValue(NO_BACKEND);
    open();
    paint();
    fireEvent.click(describeButton());
    await waitFor(() =>
      expect(useDescriptionsStore.getState().describing).toBeNull(),
    );
  });
});
