// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

const mocks = vi.hoisted(() => ({
  synthesizeSpeech: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    synthesizeSpeech: mocks.synthesizeSpeech,
    logEmit: mocks.logEmit,
  };
});

import type { TrackSummary } from "../ipc";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { VoiceoverDialog } from "./VoiceoverDialog";
import { VOICEOVER_SCRIPT_MAX } from "./voiceoverPlacement";
import {
  closeVoiceoverPrompt,
  openVoiceoverPrompt,
  useVoiceoverPromptStore,
} from "./voiceoverPrompt";

const SCRIPT = "Welcome back to the channel.";

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

function seed(durationUs = 6_000_000, tracks = [track("t-1", "A"), track("t-2", "B")]) {
  useProjectStore
    .getState()
    .apply(summaryFixture({ root: { duration_us: durationUs, tracks } }));
}

function result(over: Record<string, unknown> = {}) {
  return {
    layer_id: "l-vo",
    media_id: "m-vo",
    t_start_us: 6_000_000,
    t_end_us: 8_000_000,
    cached: false,
    ...over,
  };
}

function script(): HTMLTextAreaElement {
  return screen.getByLabelText("Script") as HTMLTextAreaElement;
}

function generate(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
}

function ipcError(message: string): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${message}`,
  );
}

describe("VoiceoverDialog", () => {
  beforeEach(() => {
    mocks.synthesizeSpeech.mockReset().mockResolvedValue(result());
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    closeVoiceoverPrompt();
    setPlayheadTimeUs(0);
    seed();
  });
  afterEach(cleanup);

  it("renders nothing until the prompt is opened", () => {
    render(<VoiceoverDialog />);
    expect(screen.queryByText("Voiceover")).toBeNull();
  });

  // Reachable with nothing selected — this operation has no scope, so an empty
  // selection must not stand in its way.
  it("opens with an empty selection and an empty project timeline", () => {
    seed(0, []);
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    expect(screen.getByText("Voiceover")).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });

  it("refuses an empty script in the field, naming what to do", () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    expect(generate().disabled).toBe(true);
    expect(screen.getByText(/type the script to be spoken/)).toBeTruthy();
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  // Enforced in the field, before a request: an over-length script must cost
  // nothing to discover.
  it("refuses an over-length script before any IPC, and says by how much", () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: "x".repeat(VOICEOVER_SCRIPT_MAX + 7) } });
    expect(generate().disabled).toBe(true);
    expect(screen.getByText(/7 over the 4096-character limit/)).toBeTruthy();
    fireEvent.click(generate());
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("counts the script as it is typed", () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    expect(
      screen.getByText(new RegExp(`${SCRIPT.length} / ${VOICEOVER_SCRIPT_MAX} characters`)),
    ).toBeTruthy();
  });

  // The default destination mirrors the hybrid arm's own `ensureAudioTrack`
  // (the LAST root track) and is SENT — the dialog stating one track while the
  // arm resolves another is the failure this closes.
  it("defaults to the last root track and appends past the composition duration", async () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith({
      text: SCRIPT,
      voice: "alloy",
      target_track_id: "t-2",
      t_start_us: 6_000_000,
    });
  });

  // Absent at 1.0 and present otherwise: the TTS cache keys an absent speed
  // apart from an explicit 1.0, so the default has to travel as absence for a
  // human's re-run of an agent's default-speed script to hit the same entry.
  it("omits the speed at the provider default and sends any other value", async () => {
    const user = userEvent.setup();
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    // Base UI's NumberField appends unless cleared first; `onValueChange` is
    // live, so no blur is needed before the click.
    const speed = screen.getByLabelText("Speed");
    await user.clear(speed);
    await user.type(speed, "1.5");
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech.mock.calls[0]![0]).toMatchObject({ speed: 1.5 });
  });

  it("starts at the playhead when that placement is chosen", async () => {
    setPlayheadTimeUs(2_500_000);
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(screen.getByRole("radio", { name: /At the playhead/ }));
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech.mock.calls[0]![0]).toMatchObject({
      t_start_us: 2_500_000,
    });
  });

  // Both placements print the timecode they resolve to, so "where it lands" is
  // a fact on screen rather than a thing to discover after the fact.
  it("states both landing times as timecode", () => {
    setPlayheadTimeUs(2_000_000);
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    expect(screen.getByText(/Starts at 00:00:06:00/)).toBeTruthy();
    expect(screen.getByText(/Starts at 00:00:02:00\./)).toBeTruthy();
  });

  // The project may legitimately hold no track; the arm answers that case by
  // creating one, so the dialog must not invent an id for it.
  it("omits the track id when the project has no track to name", async () => {
    seed(0, []);
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech.mock.calls[0]![0]).not.toHaveProperty(
      "target_track_id",
    );
  });

  it("closes on success", async () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
  });

  // A cached hit billed nothing, and that is the fact worth reading back in the
  // record — hence two terminal keys rather than one row with a flag.
  it("reports a cached result as its own row", async () => {
    mocks.synthesizeSpeech.mockResolvedValue(result({ cached: true }));
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({ i18n_key: "log.voiceover_done_cached" });
  });

  it("reports a fresh result as a billed row", async () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.voiceover_started",
      i18n_args: { chars: SCRIPT.length, voice: "alloy" },
    });
    expect(rows[1]).toMatchObject({ i18n_key: "log.voiceover_done" });
    expect(rows[0].op_id).toBe(rows[1].op_id);
  });

  // The script is the user's, and a log row is broadcast and persisted. Neither
  // the message nor `details` may carry it — length and voice identify the run.
  it("keeps the script out of every log row and out of details", async () => {
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
    for (const [row] of mocks.logEmit.mock.calls) {
      expect(JSON.stringify(row)).not.toContain(SCRIPT);
      expect(JSON.stringify(row)).not.toContain("Welcome back");
    }
  });

  it("surfaces the resolver's own message and stays open", async () => {
    mocks.synthesizeSpeech.mockRejectedValue(
      ipcError("no TTS provider configured; add an OpenAI API key in Settings"),
    );
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() =>
      expect(
        screen.getByText(
          "Error: no TTS provider configured; add an OpenAI API key in Settings",
        ),
      ).toBeTruthy(),
    );
    expect(useVoiceoverPromptStore.getState().open).toBe(true);
    // Re-armed, so the script survives and can be resubmitted once the key is in.
    expect(generate().disabled).toBe(false);
    expect(script().value).toBe(SCRIPT);
  });

  // A stale draft would be silently resubmitted by an Enter press on the next
  // opening, and a stale error would greet a run that has not started.
  it("starts from a fresh draft on each opening", () => {
    openVoiceoverPrompt();
    const view = render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    closeVoiceoverPrompt();
    view.rerender(<VoiceoverDialog />);
    openVoiceoverPrompt();
    view.rerender(<VoiceoverDialog />);
    expect(script().value).toBe("");
  });
});
