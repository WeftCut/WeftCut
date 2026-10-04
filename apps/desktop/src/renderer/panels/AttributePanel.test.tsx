// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { CompositionSummary, LayerSummary, ProjectSummary, TrackSummary } from "../ipc";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayer: vi.fn().mockResolvedValue(undefined),
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
    moveLayer: vi.fn().mockResolvedValue(undefined),
    retimeLayers: vi.fn().mockResolvedValue({ layers: [] }),
    trimLayer: vi.fn().mockResolvedValue(undefined),
    setLayersEnabled: vi.fn().mockResolvedValue(undefined),
  };
});

import { retimeLayers, updateLayer, updateLayerParams, moveLayer, trimLayer, setLayersEnabled } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import { setAudioUnits } from "../state/audioUnitsStore";
import { setLayerBakeStatuses } from "../timeline/motifBakeStatusStore";
import { clearPropSectionMemory } from "../properties/PropSection";

// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor (which jsdom doesn't implement) — same convention as
// properties/EffectsSection.test.tsx. These tests cover the wiring, not the
// switch widget itself.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, onCheckedChange, ariaLabel, disabled, "data-testid": testId }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    ariaLabel?: string;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { AttributePanel } from "./AttributePanel";
import { summaryFixture } from "../testing/summaryFixture";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectStore.getState().apply(null);
  clearLayerSelection();
  clearPropSectionMemory();
  setLayerBakeStatuses({});
  setAudioUnits("frames");
});

function colorTrack(): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "Visual",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-1",
        kind: "Color",
        label: "Card",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [
          { id: "effect-1", kind: "blur", enabled: true, params: {} },
        ],
        params: {
          kind: "Color",
          color: {
            mode: "Static",
            value: { r: 0, g: 0, b: 0, a: 255 },
          },
          width: 1920,
          height: 1080,
        },
      } as LayerSummary,
    ],
  };
}

describe("AttributePanel boundary", () => {
  it("renders and edits kind-specific fields without owning the effect chain", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(
      <AttributePanel
        tracks={[colorTrack()]}
        selectedLayerId="layer-1"
        onMutated={onMutated}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={1_000_000}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Properties" })).toBeTruthy();
    const colorSection = screen.getByRole("region", { name: "Color" });
    expect(colorSection).toBeTruthy();
    expect(screen.queryByText("Effects")).toBeNull();

    fireEvent.change(within(colorSection).getByLabelText("Color"), {
      target: { value: "#ff0000" },
    });

    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-1", {
        kind: "Color",
        color: { r: 255, g: 0, b: 0, a: 255 },
      }),
    );
    // waitFor: the commit path resolves through tryMutate's refusal guard, so
    // the refresh lands a microtask after the command call.
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  it("shows the existing empty state without an Effect surface", () => {
    render(
      <AttributePanel
        tracks={[]}
        selectedLayerId={null}
        onMutated={async () => {}}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={0}
      />,
    );

    expect(screen.getByText("Select a clip to edit its properties.")).toBeTruthy();
    expect(screen.queryByText("Effects")).toBeNull();
  });
});

function renderPanel(track: TrackSummary, layerId = "layer-1") {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  render(
    <AttributePanel
      tracks={[track]}
      selectedLayerId={layerId}
      onMutated={onMutated}
      fpsNum={30}
      fpsDen={1}
      currentTimeUs={1_000_000}
    />,
  );
  return onMutated;
}

function summaryWithLinks(links: CompositionSummary["links"]): void {
  useProjectStore.getState().apply(summaryFixture({
    project_id: "p",
    name: "P",
    media: [],
    history: { cursor: 0, len: 1, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 2_000_000,
      tracks: [],
      markers: [],
      links: links,
    },
  }) as ProjectSummary);
}

function panel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Properties" });
}

function timingSection(): HTMLElement {
  return screen.getByRole("region", { name: "Timing" });
}

function expectTimecode(control: HTMLElement, value: string): void {
  const parts = ["hours", "minutes", "seconds", "frames"].map(
    (segment) => (within(control).getByLabelText(segment) as HTMLInputElement).value,
  );
  expect(parts.join(":")).toBe(value);
}

function changeTimecode(control: HTMLElement, value: string): void {
  const values = value.split(":");
  ["hours", "minutes", "seconds", "frames"].forEach((segment, i) => {
    fireEvent.change(within(control).getByLabelText(segment), { target: { value: values[i] } });
  });
}

describe("AttributePanel Layer envelope", () => {
  it("keeps the editable identity, flags and duration visible", () => {
    summaryWithLinks([{ id: "g1", layer_ids: ["layer-1"] }]);
    renderPanel(colorTrack());

    expect(screen.getByText("Color · Visual · Link of 1 clip")).toBeTruthy();
    const env = panel();
    expect(within(env).getByLabelText("Label")).toHaveProperty("value", "Card");
    expect(within(env).getByRole("button", { name: "Enabled" }).getAttribute("aria-pressed")).toBe("true");
    // 30 fps: 2 s → 00:00:02:00; duration = End − Start.
    expectTimecode(within(env).getByLabelText("Duration"), "00:00:02:00");
    // Identity, flags and timing fields are always visible.
    const end = screen.getByLabelText("End");
    expect(end.tagName).toBe("OUTPUT");
    expect(end.textContent).toBe("00:00:02:00");
    expect(screen.getByLabelText("Start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Locked", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Locked" }).getAttribute("aria-pressed")).toBe("false");
    expectTimecode(within(timingSection()).getByLabelText("Start"), "00:00:00:00");
  });

  it("falls back to a localized none when the Layer belongs to no link", () => {
    summaryWithLinks([]);
    renderPanel(colorTrack());
    expect(screen.getByText("Color · Visual · Not linked")).toBeTruthy();
  });

  it("keeps the original media name visible alongside the label and its placeholder", () => {
    summaryWithLinks([]);
    renderPanel(audioTrack(), "layer-a1");
    expect(screen.getByText("Audio · A1 · Not linked")).toBeTruthy();
    expect(screen.getByLabelText("Label")).toHaveProperty("placeholder", "voice.wav");
    expect(screen.getByText("Source: voice.wav")).toBeTruthy();
    cleanup();
    clearPropSectionMemory();
    summaryWithLinks([]);
    renderPanel(colorTrack());
    expect(screen.queryByText("Source: voice.wav")).toBeNull();
  });

  // A uuid is never a display name, and a link has no name of its own — so it
  // describes itself by member count.
  it("describes a link by its member count, not its uuid", () => {
    summaryWithLinks([
      {
        id: "019fcc4d-20d4-7f65-b368-47ecbe3ef63d",
        layer_ids: ["layer-1", "layer-2"],
      },
    ]);
    renderPanel(colorTrack());

    expect(screen.getByText("Color · Visual · Link of 2 clips")).toBeTruthy();
    expect(screen.queryByText(/019fcc4d/)).toBeNull();
  });

  it("names the multi-select primary after its media file when unnamed, not its uuid", () => {
    summaryWithLinks([]);
    const track = audioTrack();
    (track.layers[0] as { label: string | null }).label = null;
    setLayerSelection("layer-a1", ["layer-a1", "layer-x"]);
    renderPanel(track, "layer-a1");

    expect(screen.getByText(/“voice\.wav” — 2 clips selected/)).toBeTruthy();
    expect(screen.queryByText("Source: voice.wav")).toBeNull();
    expect(screen.queryByText(/layer-a1/)).toBeNull();
  });
});

describe("AttributePanel envelope command routing", () => {
  it("clears a custom title back to its media name with one commit", async () => {
    const user = userEvent.setup();
    renderPanel(audioTrack(), "layer-a1");
    const name = screen.getByLabelText("Label");
    await user.clear(name);
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledExactlyOnceWith("layer-a1", { label: "" }));
    expect(name).toHaveProperty("value", "");
    expect(name).toHaveProperty("placeholder", "voice.wav");
    expect(screen.queryByText("Source: voice.wav")).toBeNull();
  });

  it("cancels title editing on Escape without a blur commit", async () => {
    const user = userEvent.setup();
    renderPanel(colorTrack());
    const name = screen.getByLabelText("Label");
    await user.clear(name);
    await user.type(name, "Discard this");
    await user.keyboard("{Escape}");
    expect(name).toHaveProperty("value", "Card");
    expect(document.activeElement).not.toBe(name);
    expect(updateLayer).not.toHaveBeenCalled();
    // A later normal edit must still commit after the cancellation.
    await user.clear(name);
    await user.type(name, "New name{Enter}");
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledExactlyOnceWith("layer-1", { label: "New name" }));
  });

  it.each([
    { ids: ["layer-1"] },
    { ids: ["layer-1", "layer-2"] },
  ])("edits only the inspected clip's flags with selection $ids", async ({ ids }) => {
    summaryWithLinks([{ id: "link-1", layer_ids: ["layer-1", "layer-2"] }]);
    setLayerSelection("layer-1", ids);
    renderPanel(colorTrack());
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledExactlyOnceWith("layer-1", { enabled: false }));
    expect(setLayersEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Locked" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenNthCalledWith(2, "layer-1", { locked: true }));
  });

  it("explains a track lock without making the clip's own lock look enabled", () => {
    const track = colorTrack();
    track.locked = true;
    renderPanel(track);
    expect(screen.getByRole("button", { name: "Locked", pressed: false })).toBeTruthy();
    expect(screen.getByText("The track is locked. Unlock it to edit clip timing.")).toBeTruthy();
    expect(within(screen.getByLabelText("Duration")).getByLabelText("frames")).toHaveProperty("disabled", true);
  });

  it("routes label, enabled, and locked edits through update_layer", async () => {
    const onMutated = renderPanel(colorTrack());
    const env = panel();

    fireEvent.change(within(env).getByLabelText("Label"), { target: { value: "Hero card" } });
    fireEvent.blur(within(env).getByLabelText("Label"));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { label: "Hero card" }));

    fireEvent.click(within(env).getByRole("button", { name: "Enabled" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { enabled: false }));

    fireEvent.click(screen.getByRole("button", { name: "Locked" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { locked: true }));

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledTimes(3));
    expect(moveLayer).not.toHaveBeenCalled();
    expect(trimLayer).not.toHaveBeenCalled();
  });

  it("routes Start through the link-aware move command with the Layer's current Track", async () => {
    const onMutated = renderPanel(colorTrack());
    const start = within(timingSection()).getByLabelText("Start");
    changeTimecode(start, "00:00:01:00");
    fireEvent.blur(start);
    await vi.waitFor(() =>
      // escapeLink=false: a VISUAL start edit moves the whole link, as it always
      // has. Only an audio edit escapes, because a sub-frame audio start is a SLIP
      // (ADR 0038) and dragging the video member with it would put that member off
      // its own grid.
      expect(moveLayer).toHaveBeenCalledWith("layer-1", "track-1", 1_000_000, false),
    );
    expect(trimLayer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  // ── Sub-frame audio entry (ADR 0038) ─────────────────────────────────────────
  it("offers the audio-units selector on an audio layer only", () => {
    summaryWithLinks([]);
    renderPanel(audioTrack(), "layer-a1");
    expect(within(timingSection()).getByLabelText("Audio units")).toBeTruthy();
    cleanup();
    clearPropSectionMemory();
    summaryWithLinks([]);
    renderPanel(colorTrack());
    expect(within(timingSection()).queryByLabelText("Audio units")).toBeNull();
  });

  it("round-trips a sample-grid position through the Start field in samples", async () => {
    summaryWithLinks([]);
    setAudioUnits("samples");
    const onMutated = renderPanel(audioTrack(), "layer-a1");
    const start = within(timingSection()).getByLabelText("Start");
    // The field READS the mixer's sample index for the stored µs…
    expect(start).toHaveProperty("value", "0");
    // …and a typed index commits the exact µs of THAT sample. 1608 → 33_500 µs, which
    // is half a frame off the 30 fps grid (frame 1 is 33_333) — the whole point: this
    // position is unreachable by dragging and unrepresentable on the frame grid.
    fireEvent.change(start, { target: { value: "1608" } });
    fireEvent.blur(start);
    await vi.waitFor(() =>
      // escapeLink=true — a sub-frame audio start is a SLIP, so the video member must
      // not follow (it would land off its own grid).
      expect(moveLayer).toHaveBeenCalledWith("layer-a1", "track-a", 33_500, true),
    );
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  it("reads the same audio time in milliseconds when the unit is switched", () => {
    summaryWithLinks([]);
    setAudioUnits("ms");
    renderPanel(audioTrack(), "layer-a1");
    expect(within(timingSection()).getByLabelText("Start")).toHaveProperty("value", "00:00:00.000");
    setAudioUnits("frames");
    // …and the visual layer's readouts are untouched by the mode.
    cleanup();
    clearPropSectionMemory();
    setAudioUnits("ms");
    summaryWithLinks([]);
    renderPanel(colorTrack());
    expectTimecode(within(timingSection()).getByLabelText("Start"), "00:00:00:00");
    setAudioUnits("frames");
  });

  it("routes duration through the link-aware trim command", async () => {
    const onMutated = renderPanel(colorTrack());
    const env = panel();

    // Duration 1 s from t_start 0 → trim the out-edge to 1 s.
    const dur = within(env).getByLabelText("Duration");
    changeTimecode(dur, "00:00:01:00");
    fireEvent.blur(dur);
    // Link-aware (`escapeLink` false) — the override off is the default.
    await vi.waitFor(() =>
      expect(trimLayer).toHaveBeenCalledWith("layer-1", "out", 1_000_000, false),
    );

    expect(moveLayer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  it("issues no command when an edit re-enters the current value (no no-op undo)", async () => {
    renderPanel(colorTrack());
    const env = panel();

    const start = within(timingSection()).getByLabelText("Start");
    changeTimecode(start, "00:00:00:00");
    fireEvent.blur(start);

    const dur = within(env).getByLabelText("Duration");
    changeTimecode(dur, "00:00:02:00");
    fireEvent.blur(dur);

    const label = within(env).getByLabelText("Label");
    fireEvent.change(label, { target: { value: "Card" } });
    fireEvent.blur(label);

    await new Promise((r) => setTimeout(r, 50));
    expect(moveLayer).not.toHaveBeenCalled();
    expect(trimLayer).not.toHaveBeenCalled();
    expect(updateLayer).not.toHaveBeenCalled();
  });

  it("ignores nonnumeric frame input without a command", async () => {
    renderPanel(colorTrack());
    const start = within(timingSection()).getByLabelText("Start");
    fireEvent.change(within(start).getByLabelText("frames"), { target: { value: "not-a-timecode" } });
    fireEvent.blur(start);
    await new Promise((r) => setTimeout(r, 50));
    expect(moveLayer).not.toHaveBeenCalled();
    expectTimecode(start, "00:00:00:00");
  });

  it("disables content edits on a locked Layer, keeping its lock control available", () => {
    const locked = colorTrack();
    locked.layers[0] = { ...locked.layers[0], locked: true } as LayerSummary;
    renderPanel(locked);
    const env = panel();
    expect(within(within(timingSection()).getByLabelText("Start")).getByLabelText("frames")).toHaveProperty("disabled", true);
    expect(within(within(env).getByLabelText("Duration")).getByLabelText("frames")).toHaveProperty("disabled", true);
    expect(within(env).getByLabelText("Label")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Enabled" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Locked" })).toHaveProperty("disabled", false);
  });
});

function audioTrack(): TrackSummary {
  return {
    id: "track-a",
    kind: "Audio",
    label: "A1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-a1",
        kind: "Audio",
        label: "Voice",
        t_start_us: 0,
        t_end_us: 4_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "Audio",
          media_id: "m1",
          media_label: "voice.wav",
          src_in_us: 0,
          src_out_us: 4_000_000,
          gain_db: { mode: "Static", value: 0 },
          pan: { mode: "Static", value: 0 },
          fade_in_us: 0,
          fade_out_us: 0,
          mute: false,
          role: "dialogue",
        },
      } as LayerSummary,
    ],
  };
}

function videoTrack(): TrackSummary {
  return {
    id: "track-v",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-v1",
        kind: "VideoClip",
        label: "Clip",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "VideoClip",
          media_id: "m1",
          media_label: "clip.mp4",
          src_in_us: 0,
          src_out_us: 2_000_000,
          x: { mode: "Static", value: 0 },
          y: { mode: "Static", value: 0 },
          scale_x: { mode: "Static", value: 1 },
          scale_y: { mode: "Static", value: 1 },
          scale_linked: true,
          rotation_deg: { mode: "Static", value: 0 },
          anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
          opacity: { mode: "Static", value: 1 },
          speed: 1,
          flip_h: false,
          flip_v: false,
          fade_in_us: 0,
          fade_out_us: 0,
        },
      } as LayerSummary,
    ],
  };
}

function motifTrack(): TrackSummary {
  return {
    id: "track-m",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-m1",
        kind: "Motif",
        label: "Badge",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "Motif",
          motif_id: "builtin/removed",
          x: { mode: "Static", value: 0 },
          y: { mode: "Static", value: 0 },
          scale_x: { mode: "Static", value: 1 },
          scale_y: { mode: "Static", value: 1 },
          scale_linked: true,
          rotation_deg: { mode: "Static", value: 0 },
          anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
          opacity: { mode: "Static", value: 1 },
          src_in_us: 0,
          props: {},
        },
      } as LayerSummary,
    ],
  };
}

describe("AttributePanel local disclosures", () => {
  it("shows fade durations directly under Effects", () => {
    renderPanel(videoTrack(), "layer-v1");
    expect(screen.getByLabelText("Duration")).toBeTruthy();
    expect(screen.getByLabelText("Speed")).toBeTruthy();
    expect(screen.getByLabelText("Label")).toHaveProperty("placeholder", "clip.mp4");
    expect(screen.getByRole("button", { name: "Flip horizontal" })).toBeTruthy();
    const effects = screen.getByRole("region", { name: "Effects" });
    expect(within(effects).getByLabelText("Fade-in duration")).toBeTruthy();
    expect(within(effects).getByLabelText("Fade-out duration")).toBeTruthy();
    expect(screen.getByLabelText("Start")).toBeTruthy();
    const transform = screen.getByRole("region", { name: "Transform" });
    expect(within(transform).getByRole("button", { name: "Flip horizontal" })).toBeTruthy();
    expect(within(transform).getByRole("button", { name: "Flip vertical" })).toBeTruthy();
  });

  it("offers time placement even for a Color layer", () => {
    renderPanel(colorTrack());
    expect(screen.getByRole("button", { name: "Locked" })).toBeTruthy();
    expect(within(timingSection()).getByLabelText("Start")).toBeTruthy();
  });

  it("hides a Motif layer's bake status unless a bake is active or failed", () => {
    renderPanel(motifTrack(), "layer-m1");
    // No status entry at all → idle → no standing row.
    expect(document.querySelector(".prop-bake-status")).toBeNull();

    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "warming", done: 1, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")?.textContent).toContain("Warming preview");

    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "baking", done: 2, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")?.textContent).toContain("Pre-baking");

    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "error", done: 2, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")?.textContent).toContain("Pre-bake failed");

    // Ready goes quiet again — a finished bake earns no standing row.
    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "ready", done: 4, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")).toBeNull();
  });
});

describe("AttributePanel multi-selection", () => {
  it("identifies which primary layer is edited when several layers are selected", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    renderPanel(colorTrack());
    const note = screen.getByText(/changes apply only to this clip/);
    expect(note.textContent).toContain("“Card”");
    expect(note.textContent).toContain("2 clips selected");
  });

  it("omits the primary-layer note for a single selection", () => {
    setLayerSelection("layer-1", ["layer-1"]);
    renderPanel(colorTrack());
    expect(screen.queryByText(/changes apply only to this clip/)).toBeNull();
  });
});

describe("AttributePanel Audio fields", () => {
  it("shows pan and role alongside gain and fades without a separate mute control", async () => {
    const onMutated = renderPanel(audioTrack(), "layer-a1");

    // gain is a keyframable core row (labels come from the param descriptors).
    expect(screen.getByText("Gain (dB)")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Audio" })).getByText("Pan")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Audio" })).getByLabelText("Role")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Mute" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unmute clip" })).toBeNull();

    const fadeIn = screen.getByLabelText("Fade-in duration");
    expect(within(fadeIn).getByLabelText("frames")).toHaveProperty("value", "00");
    fireEvent.change(within(fadeIn).getByLabelText("frames"), { target: { value: "1" } });
    fireEvent.blur(fadeIn);
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-a1", { kind: "Audio", fade_in_us: 33_333 }),
    );

    const fadeOut = screen.getByLabelText("Fade-out duration");
    fireEvent.change(within(fadeOut).getByLabelText("seconds"), { target: { value: "2" } });
    fireEvent.blur(fadeOut);
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-a1", { kind: "Audio", fade_out_us: 2_000_000 }),
    );

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledTimes(2));
  });
});

describe("AttributePanel Audio fade guards", () => {
  it("skips the fade command when the field still holds the current value", async () => {
    renderPanel(audioTrack(), "layer-a1");
    const fadeIn = screen.getByLabelText("Fade-in duration");
    fireEvent.change(within(fadeIn).getByLabelText("frames"), { target: { value: "0" } });
    fireEvent.blur(fadeIn);
    await new Promise((r) => setTimeout(r, 50));
    expect(updateLayerParams).not.toHaveBeenCalled();
  });
});

// The panel has ONE row primitive: `.prop-field` (static) and `.anim-field`
// (animatable) are the same grid, and what leads the value column is a
// stopwatch or the CSS-reserved empty slot. jsdom cannot measure the resulting
// edges, so these pin the row SHAPE the grid needs instead — which is where
// the alignment is actually won or lost.
describe("AttributePanel row primitive", () => {
  const rowsIn = (section: HTMLElement) =>
    [...section.querySelectorAll<HTMLElement>(".anim-field, .prop-field")];

  it("puts the caption first and the stopwatch inside the value column", () => {
    renderPanel(videoTrack(), "layer-v1");
    const transform = screen.getByLabelText("Transform");
    const rows = rowsIn(transform);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A stopwatch as a direct child of the row makes the caption a second
      // grid column and the value a third, which breaks the panel's one
      // value edge for every animatable row.
      expect(row.querySelector(":scope > .anim-stopwatch")).toBeNull();
      const caption = row.firstElementChild;
      expect(caption?.className).toMatch(/anim-field-label|prop-field-label/);
      for (const watch of row.querySelectorAll(".anim-stopwatch")) {
        expect(watch.closest(".anim-field-control")).toBe(
          row.querySelector(".anim-field-control"),
        );
      }
    }
  });

  it("gives an axis pair one captioned row holding both axes", () => {
    renderPanel(videoTrack(), "layer-v1");
    const transform = screen.getByLabelText("Transform");
    // "Position" captions the mode switcher; the values below it are captioned
    // by which representation they are.
    for (const [caption, axes] of [
      ["XY", ["X", "Y"]],
      ["Anchor", ["Anchor X", "Anchor Y"]],
    ] as const) {
      const row = rowsIn(transform).find((r) => r.firstElementChild?.textContent === caption);
      expect(row, `${caption} row`).toBeTruthy();
      expect(row!.querySelectorAll(".anim-axis")).toHaveLength(2);
      // Each axis keeps its own stopwatch — X and Y animate independently —
      // and names its param, since the row's caption covers both.
      for (const axis of axes) {
        expect(within(row!).getByRole("button", { name: new RegExp(`^${axis} —`) })).toBeTruthy();
      }
    }
  });

  // The chain must not change the panel's row count: it swaps one axis cell
  // for two inside the same row.
  it("keeps scale on one row whether it is linked or not", () => {
    const scaleRow = () =>
      rowsIn(screen.getByLabelText("Transform")).find(
        (r) => r.firstElementChild?.textContent === "Scale",
      )!;

    renderPanel(videoTrack(), "layer-v1");
    expect(scaleRow()).toBeTruthy();
    expect(scaleRow().querySelectorAll(".anim-axis")).toHaveLength(1);
    expect(within(scaleRow()).getByRole("button", { name: "Unlink X/Y scale" })).toBeTruthy();

    cleanup();
    const unlinked = videoTrack();
    (unlinked.layers[0]!.params as { scale_linked: boolean }).scale_linked = false;
    renderPanel(unlinked, "layer-v1");
    expect(scaleRow().querySelectorAll(".anim-axis")).toHaveLength(2);
    expect(within(scaleRow()).getByRole("button", { name: /^Scale X —/ })).toBeTruthy();
    expect(within(scaleRow()).getByRole("button", { name: /^Scale Y —/ })).toBeTruthy();
    expect(within(scaleRow()).getByRole("button", { name: "Link X/Y scale (uniform) — Scale Y becomes a copy of Scale X" })).toBeTruthy();
  });
});


it('retimes the inspected clip unless the user explicitly enables selection-wide editing', async () => {
  const video = videoTrack(), audio = audioTrack();
  useProjectStore.getState().apply(summaryFixture({ root: { tracks: [video, audio], links: [{ id: 'link', layer_ids: ['layer-v1', 'layer-a1'] }] } }));
  setLayerSelection('layer-v1', ['layer-v1', 'layer-a1']);
  renderPanel(video, 'layer-v1');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reset to 1×' }));
  expect(retimeLayers).toHaveBeenLastCalledWith(['layer-v1'], { kind: 'Rate', value: { num: 1, den: 1 } });
  await user.click(screen.getByRole('checkbox', { name: 'Apply to all 2 selected clips' }));
  await user.click(screen.getByRole('button', { name: 'Reset to 1×' }));
  expect(retimeLayers).toHaveBeenLastCalledWith(['layer-v1', 'layer-a1'], { kind: 'Rate', value: { num: 1, den: 1 } });
});

describe('direct retime duration editing', () => {
  function renderVideoTiming() {
    const video = videoTrack();
    useProjectStore.getState().apply(summaryFixture({ root: { tracks: [video] } }));
    renderPanel(video, 'layer-v1');
    expect(screen.getByLabelText('Speed')).toHaveProperty('disabled', false);
    expect(screen.queryByRole('button', { name: 'Apply retime' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retime to duration…' })).toBeNull();
    return within(screen.getByRole('group', { name: 'Target duration' })).getByLabelText('seconds');
  }

  it('keeps both fields visible and lets Escape discard an unfinished edit', async () => {
    const seconds = renderVideoTiming();
    fireEvent.change(seconds, { target: { value: '1' } });
    expect(screen.queryByText(/Result:/)).toBeNull();
    expectTimecode(screen.getByRole('group', { name: 'Duration' }), '00:00:02:00');
    expect(screen.getByRole('button', { name: 'Speed' }).textContent).toBe('1.00×');
    fireEvent.keyDown(seconds, { key: 'Escape' });
    fireEvent.blur(seconds);
    expect(retimeLayers).not.toHaveBeenCalled();
    expect(trimLayer).not.toHaveBeenCalled();
    expectTimecode(screen.getByRole('group', { name: 'Target duration' }), '00:00:02:00');
  });

  it.each(['blur', 'Enter'])('commits exactly one retime on %s and keeps the field visible', async (gesture) => {
    const seconds = renderVideoTiming();
    fireEvent.focus(seconds);
    fireEvent.change(seconds, { target: { value: '1' } });
    if (gesture === 'blur') fireEvent.blur(seconds);
    else fireEvent.keyDown(seconds, { key: 'Enter' });
    await vi.waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['layer-v1'], { kind: 'Duration', duration_us: 1_000_000 }));
    expect(trimLayer).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Target duration' })).toBeTruthy();
  });

  it('refuses a zero duration without submitting and allows correction', async () => {
    const seconds = renderVideoTiming();
    fireEvent.change(seconds, { target: { value: '0' } });
    fireEvent.blur(seconds);
    expect(screen.getByRole('alert').textContent).toBe('Enter a positive rate or duration.');
    expect(retimeLayers).not.toHaveBeenCalled();
    const restoredSeconds = within(screen.getByRole('group', { name: 'Target duration' })).getByLabelText('seconds');
    expectTimecode(screen.getByRole('group', { name: 'Target duration' }), '00:00:02:00');
    fireEvent.change(restoredSeconds, { target: { value: '1' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(restoredSeconds);
    await vi.waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['layer-v1'], { kind: 'Duration', duration_us: 1_000_000 }));
  });

  it('does not retime when an unchanged target duration loses focus', () => {
    const seconds = renderVideoTiming();
    fireEvent.focus(seconds);
    fireEvent.blur(seconds);
    expect(retimeLayers).not.toHaveBeenCalled();
  });

  it.each([
    ['ms', '00:00:01.500', 1_500_000],
    ['samples', '72000', 1_500_000],
  ] as const)('uses the selected audio %s unit for target duration', async (units, value, durationUs) => {
    const audio = audioTrack();
    useProjectStore.getState().apply(summaryFixture({ root: { tracks: [audio] } }));
    setAudioUnits(units);
    renderPanel(audio, 'layer-a1');
    fireEvent.change(screen.getByLabelText('Target duration'), { target: { value } });
    fireEvent.blur(screen.getByLabelText('Target duration'));
    await vi.waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['layer-a1'], { kind: 'Duration', duration_us: durationUs }));
  });

  it.each([
    ['2', { num: 2, den: 1 }],
    ['0.5', { num: 1, den: 2 }],
  ] as const)('applies the displayed %s× multiplier as the playback rate', async (input, value) => {
    const video = videoTrack();
    useProjectStore.getState().apply(summaryFixture({ root: { tracks: [video] } }));
    renderPanel(video, 'layer-v1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    await user.clear(screen.getByLabelText('Speed'));
    await user.type(screen.getByLabelText('Speed'), input);
    await user.tab();
    await vi.waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['layer-v1'], { kind: 'Rate', value }));
    expect(screen.queryByRole('textbox', { name: 'Speed' })).toBeNull();
  });

  it('focuses speed on click and cancels an unfinished multiplier edit with Escape', async () => {
    renderVideoTiming();
    const user = userEvent.setup();
    expect(screen.queryByRole('textbox', { name: 'Speed' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const input = screen.getByRole('textbox', { name: 'Speed' });
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, '0.5');
    await user.keyboard('{Escape}');
    expect(retimeLayers).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Speed' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Speed' }).textContent).toBe('1.00×');
  });

  it('commits the multiplier once on Enter without an extra confirmation', async () => {
    renderVideoTiming();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    await user.clear(screen.getByRole('textbox', { name: 'Speed' }));
    await user.type(screen.getByRole('textbox', { name: 'Speed' }), '2{Enter}');
    await vi.waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['layer-v1'], { kind: 'Rate', value: { num: 2, den: 1 } }));
    expect(screen.queryByRole('textbox', { name: 'Speed' })).toBeNull();
  });
});
