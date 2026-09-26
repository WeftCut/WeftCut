// @vitest-environment jsdom
// The section as the user meets it: which clips get one, what the controls do
// to each other, and what reaches the wire when a verb is pressed.
//
// The verbs' assertions are the ones worth the most: both re-detect inside
// their own call, so what they are given IS what lands, and *Remove* carrying
// the pad is the difference between keeping a breath and erasing it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "../i18n";

const mocks = vi.hoisted(() => ({
  detectPauses: vi.fn(),
  markPauses: vi.fn(),
  removePauses: vi.fn(),
  getProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  logEmit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  startAudition: vi.fn(),
  subjectConformUrl: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    detectPauses: mocks.detectPauses,
    markPauses: mocks.markPauses,
    removePauses: mocks.removePauses,
    getProjectSettings: mocks.getProjectSettings,
    updateProjectSettings: mocks.updateProjectSettings,
    logEmit: mocks.logEmit,
  };
});
vi.mock("@/bridge/events", () => ({ listen: mocks.listen }));
vi.mock("../audition/auditionPlayer", () => ({
  startAudition: mocks.startAudition,
  subjectConformUrl: mocks.subjectConformUrl,
}));

import type { AnimTrack, LayerSummary, TrackSummary } from "../ipc";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";
import { usePausePreviewStore } from "../state/pausePreviewStore";
import { useProjectStore } from "../state/projectStore";
import { PausesSection } from "./PausesSection";
import { clearPropSectionMemory } from "./PropSection";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });

function audioLayer(id: string, mediaId: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 10_000_000,
    kind: "Audio",
    color_hint: "#3f8f6f",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Audio",
      media_id: mediaId,
      media_label: "interview.wav",
      src_in_us: 0,
      src_out_us: 10_000_000,
      gain_db: num(0),
      pan: num(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "dialogue",
    },
  };
}

function videoLayer(id: string, mediaId: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 10_000_000,
    kind: "VideoClip",
    color_hint: "#4c8dd8",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: mediaId,
      media_label: "interview.mov",
      src_in_us: 0,
      src_out_us: 10_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
  };
}

function track(layers: LayerSummary[]): TrackSummary {
  return {
    id: "t-1",
    kind: "Audio",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    removable: true,
    layers,
  } as unknown as TrackSummary;
}

function seed(layers: LayerSummary[], linked = false): void {
  useProjectStore.getState().apply(
    summaryFixture({
      root: compositionFixture({
        tracks: [track(layers)],
        links: linked
          ? [{ id: "lk-1", layer_ids: layers.map((l) => l.id) }]
          : [],
      }),
    }),
  );
}

/// The shape an IPC rejection actually reaches the renderer in: Electron wraps
/// the main-side message in its own prose, and the actionable half is inside.
function ipcError(message: string): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${message}`,
  );
}

/// Mount, then open — the section is collapsed by default, and a collapsed
/// body detects nothing.
async function open(layer: LayerSummary): Promise<void> {
  render(<PausesSection layer={layer} />);
  fireEvent.click(screen.getByRole("button", { name: "Pauses" }));
  await waitFor(() => expect(mocks.detectPauses).toHaveBeenCalled());
}

const button = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

describe("PausesSection", () => {
  beforeEach(() => {
    // 1.5 s + 0.8 s of pause, and a floor two steps under the default
    // threshold.
    mocks.detectPauses.mockReset().mockResolvedValue({
      pauses: [
        { t_start_us: 1_000_000, t_end_us: 2_500_000 },
        { t_start_us: 4_000_000, t_end_us: 4_800_000 },
      ],
      noise_floor_amp: 0.004, // ≈ −48 dB
      peaks_source: "raw",
    });
    mocks.markPauses.mockReset().mockResolvedValue({
      markers: 2,
      marker_ids: ["mk-1", "mk-2"],
    });
    mocks.removePauses.mockReset().mockResolvedValue({
      surviving_layer_ids: ["l-1a", "l-1b", "l-1c"],
      removed: 2,
      removed_us: 1_900_000,
    });
    mocks.getProjectSettings
      .mockReset()
      .mockResolvedValue({ prefer_proxies: false, proxy_overrides: {}, shot_review: null, pause_review: null });
    mocks.updateProjectSettings.mockReset().mockResolvedValue(undefined);
    mocks.logEmit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
    mocks.startAudition.mockReset().mockReturnValue({ stop: vi.fn() });
    mocks.subjectConformUrl.mockReset().mockReturnValue("weftcut-media://conform");
    usePausePreviewStore.setState({ preview: null });
    clearPropSectionMemory();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("is there on an Audio layer", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    expect(mocks.detectPauses).toHaveBeenCalledWith({
      layerId: "a-1",
      thresholdAmp: expect.closeTo(0.02, 4),
      minPauseUs: 500_000,
    });
  });

  // The delegation has to be VISIBLE: the numbers are about a layer the user
  // did not select.
  it("names the linked audio on a delegating VideoClip", async () => {
    const video = videoLayer("v-1", "m-1");
    const audio = audioLayer("a-1", "m-1");
    seed([video, audio], true);
    await open(video);
    expect(
      screen.getByText("Measured on the linked audio “interview.wav”"),
    ).toBeTruthy();
    // Measured on the SUBJECT, not on the clip that was clicked.
    expect(mocks.detectPauses).toHaveBeenCalledWith(
      expect.objectContaining({ layerId: "a-1" }),
    );
  });

  // No subject, no section — a header with nothing under it is not an
  // explanation; the greyed command carries that one.
  it("is absent on a VideoClip that plays no sound", () => {
    const video = videoLayer("v-1", "m-1");
    seed([video]);
    render(<PausesSection layer={video} />);
    expect(screen.queryByRole("button", { name: "Pauses" })).toBeNull();
  });

  it("shows the count, what a removal takes and what it leaves", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    // Two 100 ms pads per pause come off the 2.3 s found: 1.9 s cut, and the
    // 10 s clip ends at 8.1 s.
    await waitFor(() =>
      expect(screen.getByTestId("pauses-summary").textContent).toBe(
        "2 pauses · removes 00:00:01.900 · result 00:00:08.100",
      ),
    );
  });

  it("says so plainly and greys both verbs when nothing is quiet", async () => {
    mocks.detectPauses.mockResolvedValue({
      pauses: [],
      noise_floor_amp: 0.004,
      peaks_source: "raw",
    });
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() =>
      expect(screen.getByText("No pauses at this threshold")).toBeTruthy(),
    );
    expect(button("Mark pauses").disabled).toBe(true);
    expect(button("Remove pauses").disabled).toBe(true);
  });

  // A set is only actionable once the read that produced it has landed.
  it("greys both verbs while a detection is in flight", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    mocks.detectPauses.mockReturnValue(new Promise(() => {}));
    await open(audio);
    expect(screen.getByText("Reading the waveform…")).toBeTruthy();
    expect(button("Mark pauses").disabled).toBe(true);
    expect(button("Remove pauses").disabled).toBe(true);
  });

  it("sets both numbers from a preset and lights its chip", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    // Custom is dark while the defaults match the speech preset.
    expect(button("Speech / podcast").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button("Noisy room"));
    await waitFor(() =>
      expect(mocks.detectPauses).toHaveBeenLastCalledWith({
        layerId: "a-1",
        thresholdAmp: expect.closeTo(10 ** (-28 / 20), 6),
        minPauseUs: 800_000,
      }),
    );
    expect(button("Noisy room").getAttribute("aria-pressed")).toBe("true");
    expect(button("Speech / podcast").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("pauses-preset-custom").getAttribute("data-active")).toBe("false");
  });

  // The one control that knows something about this recording the user does
  // not: six decibels over the measured floor.
  it("sets the threshold from the measured floor", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() =>
      expect(screen.getByTestId("pauses-floor").textContent).toBe(
        "Noise floor ≈ −48 dB",
      ),
    );
    fireEvent.click(button("Auto"));
    await waitFor(() =>
      expect(mocks.detectPauses).toHaveBeenLastCalledWith(
        expect.objectContaining({ thresholdAmp: expect.closeTo(10 ** (-42 / 20), 6) }),
      ),
    );
    // …and the numbers are no longer any preset's.
    expect(screen.getByTestId("pauses-preset-custom").getAttribute("data-active")).toBe("true");
  });

  // `2 × pad < min` is the constraint that makes a core exist, and the field
  // enforces it rather than leaving the tool to refuse.
  it("re-clamps the pad when the minimum drops under it", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    const pad = screen.getByLabelText("Keep each side") as HTMLInputElement;
    expect(pad.value).toBe("100");
    // Music / ambience raises the minimum to 1500 ms, so the ceiling rises…
    fireEvent.click(button("Music / ambience"));
    fireEvent.change(pad, { target: { value: "700" } });
    fireEvent.blur(pad);
    await waitFor(() => expect(pad.value).toBe("700"));
    // …and the noisy preset's 800 ms minimum pulls it back to (800 − 50) / 2,
    // floored to the step.
    fireEvent.click(button("Noisy room"));
    await waitFor(() => expect(pad.value).toBe("350"));
  });

  it("removes at the section's own parameters, pad included", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() => expect(button("Remove pauses").disabled).toBe(false));
    fireEvent.click(button("Remove pauses"));
    await waitFor(() => expect(mocks.removePauses).toHaveBeenCalled());
    expect(mocks.removePauses).toHaveBeenCalledWith({
      layerId: "a-1",
      thresholdAmp: expect.closeTo(0.02, 4),
      minPauseUs: 500_000,
      padUs: 100_000,
    });
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.remove_pauses_started",
      op_state: { state: "Started" },
    });
    expect(rows[1]).toMatchObject({
      i18n_key: "log.remove_pauses_done",
      i18n_args: { removed: 2, total: "00:00:01.900", clip: "interview.wav" },
      op_state: { state: "Ok" },
    });
    expect(rows[0].op_id).toBe(rows[1].op_id);
  });

  // A mark changes no timing, so it has nothing to pad: the FULL range is
  // marked.
  it("marks without a pad", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() => expect(button("Mark pauses").disabled).toBe(false));
    fireEvent.click(button("Mark pauses"));
    await waitFor(() => expect(mocks.markPauses).toHaveBeenCalled());
    expect(mocks.markPauses).toHaveBeenCalledWith({
      layerId: "a-1",
      thresholdAmp: expect.closeTo(0.02, 4),
      minPauseUs: 500_000,
    });
    expect(Object.keys(mocks.markPauses.mock.calls[0]![0])).not.toContain("padUs");
  });

  // The ripple planner's refusals NAME the layer that blocked, and that name is
  // the whole value of the message.
  it("shows a refusal inline, closes the op, and re-arms", async () => {
    mocks.removePauses.mockRejectedValue(
      ipcError('RippleInsideHole: layer "b-roll insert" starts inside the span being closed'),
    );
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() => expect(button("Remove pauses").disabled).toBe(false));
    fireEvent.click(button("Remove pauses"));
    await waitFor(() =>
      expect(screen.getByTestId("pauses-error").textContent).toBe(
        'Error: RippleInsideHole: layer "b-roll insert" starts inside the span being closed',
      ),
    );
    const rows = mocks.logEmit.mock.calls.map((c) => c[0]);
    expect(rows[0].op_id).toBe(rows[rows.length - 1].op_id);
    expect(rows[rows.length - 1]).toMatchObject({ op_state: { state: "Err" } });
    // Re-armed, and the summary is still on screen: the fix is to move that
    // clip and press again, which a greyed button would make impossible.
    expect(button("Remove pauses").disabled).toBe(false);
  });

  // A fresh import's real state. The refusal is a WAIT, not a failure.
  it("waits for the waveform instead of reporting a failure", async () => {
    mocks.detectPauses.mockRejectedValue(
      ipcError(
        "waveform not generated yet for media m-1 — wait for a media:job_complete event with kind=waveform and retry",
      ),
    );
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() =>
      expect(screen.getByText("Waiting for the waveform…")).toBeTruthy(),
    );
    expect(screen.queryByTestId("pauses-error")).toBeNull();
  });

  it("publishes the bands while it is open and clears them when it closes", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() =>
      expect(usePausePreviewStore.getState().preview).toMatchObject({
        subjectLayerId: "a-1",
        padUs: 100_000,
        auditioning: [],
      }),
    );
    expect(usePausePreviewStore.getState().preview?.pauses).toHaveLength(2);

    // Collapsing unmounts the body, which IS closing the section.
    fireEvent.click(screen.getByRole("button", { name: "Pauses" }));
    await waitFor(() =>
      expect(usePausePreviewStore.getState().preview).toBeNull(),
    );
  });

  it("plays the stitched result and lights the joins it is playing", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() => expect(button("Audition result").disabled).toBe(false));
    fireEvent.click(button("Audition result"));
    expect(mocks.startAudition).toHaveBeenCalled();
    await waitFor(() =>
      expect(usePausePreviewStore.getState().preview?.auditioning).toEqual([0, 1]),
    );
    // A second press stops it.
    fireEvent.click(button("Stop"));
    await waitFor(() =>
      expect(usePausePreviewStore.getState().preview?.auditioning).toEqual([]),
    );
  });

  it("hydrates the parameters from the project and writes them back on a change", async () => {
    mocks.getProjectSettings.mockResolvedValue({
      prefer_proxies: false,
      proxy_overrides: {},
      shot_review: null,
      pause_review: { threshold_amp: 10 ** (-45 / 20), min_pause_us: 1_500_000, pad_us: 200_000 },
    });
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    // The stored values, not the defaults, and the preset they match lights.
    expect(mocks.detectPauses).toHaveBeenLastCalledWith({
      layerId: "a-1",
      thresholdAmp: expect.closeTo(10 ** (-45 / 20), 6),
      minPauseUs: 1_500_000,
    });
    expect(button("Music / ambience").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button("Speech / podcast"));
    await waitFor(() =>
      expect(mocks.updateProjectSettings).toHaveBeenCalledWith({
        pause_review: {
          threshold_amp: expect.closeTo(0.02, 4),
          min_pause_us: 500_000,
          pad_us: 200_000,
        },
      }),
    );
  });

  // `null` and not the defaults spelled out: clearing the tuning is what reset
  // means, and a project storing today's defaults would stop following a later
  // change to them.
  it("clears the stored tuning on reset", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    fireEvent.click(button("Noisy room"));
    await waitFor(() => expect(mocks.updateProjectSettings).toHaveBeenCalled());
    mocks.updateProjectSettings.mockClear();
    fireEvent.click(button("Reset to defaults"));
    await waitFor(() =>
      expect(mocks.updateProjectSettings).toHaveBeenCalledWith({ pause_review: null }),
    );
    expect(button("Speech / podcast").getAttribute("aria-pressed")).toBe("true");
  });

  // A trim changes which peaks are inside the clip, so bands from the old
  // window would be in the wrong places.
  it("re-detects when the subject's window changes", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() => expect(mocks.detectPauses).toHaveBeenCalledTimes(1));
    const trimmed = audioLayer("a-1", "m-1");
    trimmed.t_end_us = 6_000_000;
    act(() => seed([trimmed]));
    await waitFor(() => expect(mocks.detectPauses).toHaveBeenCalledTimes(2));
  });

  it("re-detects once the waveform job for its own media lands", async () => {
    const audio = audioLayer("a-1", "m-1");
    seed([audio]);
    await open(audio);
    await waitFor(() =>
      expect(
        mocks.listen.mock.calls.some((c) => c[0] === "media:job_complete"),
      ).toBe(true),
    );
    const fire = mocks.listen.mock.calls.find(
      (c) => c[0] === "media:job_complete",
    )![1] as (e: { payload: { media_id: string; kind: string } }) => void;
    await waitFor(() => expect(mocks.detectPauses).toHaveBeenCalledTimes(1));
    // Another source, and another job on this one: neither is the event.
    act(() => fire({ payload: { media_id: "m-2", kind: "waveform" } }));
    act(() => fire({ payload: { media_id: "m-1", kind: "proxy" } }));
    expect(mocks.detectPauses).toHaveBeenCalledTimes(1);
    act(() => fire({ payload: { media_id: "m-1", kind: "waveform" } }));
    await waitFor(() => expect(mocks.detectPauses).toHaveBeenCalledTimes(2));
  });
});
