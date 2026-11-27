// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

const mocks = vi.hoisted(() => ({
  synthesizeSpeech: vi.fn(),
  listVoices: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    synthesizeSpeech: mocks.synthesizeSpeech,
    listVoices: mocks.listVoices,
    logEmit: mocks.logEmit,
  };
});

import type { TrackSummary, VoiceList } from "../ipc";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { VoiceoverDialog } from "./VoiceoverDialog";
import {
  closeVoiceoverPrompt,
  openVoiceoverPrompt,
  useVoiceoverPromptStore,
} from "./voiceoverPrompt";

const SCRIPT = "Welcome back to the channel.";

/// An invented provider: what the dialog renders is whatever the selected one
/// declares, so none of these numbers or voices is the app's.
function voiceList(over: Partial<VoiceList> = {}): VoiceList {
  return {
    provider: "provider-a",
    model: "model-a",
    max_chars: 64,
    speed: { min: 0.5, max: 2, default: 1 },
    format: "mp3",
    voices: [
      { id: "voice-a1", name: "Narrator A", labels: {}, preview_url: null },
      { id: "voice-b2", name: "Narrator B", labels: { accent: "accent-x", gender: "gender-y" }, preview_url: null },
    ],
    ...over,
  };
}
const MAX = voiceList().max_chars;

/// Open the dialog and wait until the provider's facts are on screen.
async function opened() {
  openVoiceoverPrompt();
  const view = render(<VoiceoverDialog />);
  await screen.findByText(new RegExp(` / ${voiceList().max_chars} characters`));
  return view;
}

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
    mocks.listVoices.mockReset().mockResolvedValue(voiceList());
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
  it("opens with an empty selection and an empty project timeline", async () => {
    seed(0, []);
    await opened();
    expect(screen.getByText("Voiceover")).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });

  it("refuses an empty script in the field, naming what to do", async () => {
    await opened();
    expect(generate().disabled).toBe(true);
    expect(screen.getByText(/type the script to be spoken/)).toBeTruthy();
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  // Enforced in the field, before a request: an over-length script must cost
  // nothing to discover.
  it("refuses an over-length script before any IPC, and says by how much", async () => {
    await opened();
    fireEvent.change(script(), { target: { value: "x".repeat(MAX + 7) } });
    expect(generate().disabled).toBe(true);
    expect(screen.getByText(new RegExp(`7 over the ${MAX}-character limit`))).toBeTruthy();
    fireEvent.click(generate());
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("counts the script as it is typed", async () => {
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    expect(
      screen.getByText(new RegExp(`${SCRIPT.length} / ${MAX} characters`)),
    ).toBeTruthy();
  });

  // The default destination mirrors the hybrid arm's own `ensureAudioTrack`
  // (the LAST root track) and is SENT — the dialog stating one track while the
  // arm resolves another is the failure this closes.
  it("defaults to the last root track and appends past the composition duration", async () => {
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith({
      text: SCRIPT,
      voice: "voice-a1",
      target_track_id: "t-2",
      t_start_us: 6_000_000,
    });
  });

  // Absent at the provider's default and present otherwise: the TTS cache keys
  // an absent speed apart from an explicit one, so the default has to travel as
  // absence for a human's re-run of an agent's default-speed script to hit the
  // same entry.
  it("omits the speed at the provider default and sends any other value", async () => {
    const user = userEvent.setup();
    await opened();
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
    await opened();
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
  it("states both landing times as timecode", async () => {
    setPlayheadTimeUs(2_000_000);
    await opened();
    expect(screen.getByText(/Starts at 00:00:06:00/)).toBeTruthy();
    expect(screen.getByText(/Starts at 00:00:02:00\./)).toBeTruthy();
  });

  // The project may legitimately hold no track; the arm answers that case by
  // creating one, so the dialog must not invent an id for it.
  it("omits the track id when the project has no track to name", async () => {
    seed(0, []);
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech.mock.calls[0]![0]).not.toHaveProperty(
      "target_track_id",
    );
  });

  it("closes on success", async () => {
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
  });

  // A cached hit billed nothing, and that is the fact worth reading back in the
  // record — hence two terminal keys rather than one row with a flag.
  it("reports a cached result as its own row", async () => {
    mocks.synthesizeSpeech.mockResolvedValue(result({ cached: true }));
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({ i18n_key: "log.voiceover_done_cached" });
  });

  it("reports a fresh result as a billed row", async () => {
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.voiceover_started",
      i18n_args: { chars: SCRIPT.length, voice: "voice-a1" },
    });
    expect(rows[1]).toMatchObject({ i18n_key: "log.voiceover_done" });
    expect(rows[0].op_id).toBe(rows[1].op_id);
  });

  // The script is the user's, and a log row is broadcast and persisted. Neither
  // the message nor `details` may carry it — length and voice identify the run.
  it("keeps the script out of every log row and out of details", async () => {
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(useVoiceoverPromptStore.getState().open).toBe(false));
    for (const [row] of mocks.logEmit.mock.calls) {
      expect(JSON.stringify(row)).not.toContain(SCRIPT);
      expect(JSON.stringify(row)).not.toContain("Welcome back");
    }
  });

  it("surfaces the provider's own message and stays open", async () => {
    mocks.synthesizeSpeech.mockRejectedValue(ipcError("the provider refused the key"));
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() =>
      expect(screen.getByText("Error: the provider refused the key")).toBeTruthy(),
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

  // ADR 0184: the dialog keeps no voice list of its own; what it offers and
  // sends is what the selected provider listed, by id.
  it("offers the provider's voices and sends the chosen one's id", async () => {
    const user = userEvent.setup();
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    const trigger = screen.getByRole("combobox", { name: "Voice" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByRole("option", { name: "Narrator A" })).toBeTruthy();
    await user.pointer({
      target: screen.getByRole("option", { name: "Narrator B · accent-x, gender-y" }),
      keys: "[MouseLeft]",
    });
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech.mock.calls[0]![0]).toMatchObject({ voice: "voice-b2" });
  });

  // A model without speed control gets no field, and no speed is sent.
  it("shows no speed field when the provider has no speed range", async () => {
    mocks.listVoices.mockResolvedValue(voiceList({ speed: null }));
    await opened();
    expect(screen.queryByLabelText("Speed")).toBeNull();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    fireEvent.click(generate());
    await waitFor(() => expect(mocks.synthesizeSpeech).toHaveBeenCalled());
    expect(mocks.synthesizeSpeech.mock.calls[0]![0]).not.toHaveProperty("speed");
  });

  it("keeps Generate off until the provider has answered", async () => {
    let answer: (list: VoiceList) => void = () => {};
    mocks.listVoices.mockReturnValue(new Promise<VoiceList>((resolve) => { answer = resolve; }));
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    expect(generate().disabled).toBe(true);
    answer(voiceList());
    await waitFor(() => expect(generate().disabled).toBe(false));
  });

  // With none selected the refusal names where to choose one; nothing can be
  // generated until then.
  it("shows the refusal and keeps Generate off when no provider is selected", async () => {
    mocks.listVoices.mockRejectedValue(
      ipcError("No voiceover provider is selected. Choose one in Settings → Voiceover."),
    );
    openVoiceoverPrompt();
    render(<VoiceoverDialog />);
    fireEvent.change(script(), { target: { value: SCRIPT } });
    expect(await screen.findByText(/Settings → Voiceover/)).toBeTruthy();
    expect(generate().disabled).toBe(true);
    fireEvent.click(generate());
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("says so and keeps Generate off when the account has no voices", async () => {
    mocks.listVoices.mockResolvedValue(voiceList({ voices: [] }));
    await opened();
    fireEvent.change(script(), { target: { value: SCRIPT } });
    expect(screen.getByText(/no voices/)).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });
});
