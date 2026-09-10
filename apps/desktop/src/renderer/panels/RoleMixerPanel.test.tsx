// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "../i18n";
import {
  clearMasterMeter,
  publishMasterMeter,
  publishRoleMeters,
  roleMeterDemandWanted,
  SILENCE_DB,
} from "../state/masterMeterStore";
import { AUDIO_ROLES, type AudioRole, type RoleMixView } from "../ipc";

const { setRoleGain, updateRoleFlags } = vi.hoisted(() => ({
  setRoleGain: vi.fn().mockResolvedValue(undefined),
  updateRoleFlags: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, setRoleGain, updateRoleFlags };
});

// The renderer-local audition override — mocked so the tests assert the exact
// begin/clear calls the fader gesture makes without a live Compositor.
const { setRoleGainOverride, clearRoleGainOverride } = vi.hoisted(() => ({
  setRoleGainOverride: vi.fn(),
  clearRoleGainOverride: vi.fn(),
}));
vi.mock("../render/audio/roleGainOverrides", () => ({
  setRoleGainOverride,
  clearRoleGainOverride,
}));

// Stub AppSlider to a controlled range input so jsdom can drive onValueChange
// (drag) and onValueCommitted (release) deterministically — Base UI's real
// slider needs pointer capture jsdom doesn't implement. min/max come through so
// jsdom's range-value sanitizer keeps negative dB values (mirrors AppSwitch
// stubbing in EffectsSection.test.tsx). Two props come through as the attributes
// the real slider stamps from them, so what is asserted here is what a user of
// the real control gets: the orientation, which is what maps up/down to
// increase/decrease, and the announced value text, which the real thumb hands
// Base UI as `aria-valuetext`.
vi.mock("../components/AppSlider", () => ({
  AppSlider: ({
    value,
    min,
    max,
    step,
    ariaLabel,
    getAriaValueText,
    className,
    orientation,
    onValueChange,
    onValueCommitted,
  }: {
    value: number;
    min: number;
    max: number;
    step?: number;
    ariaLabel?: string;
    getAriaValueText?: (value: number) => string;
    className?: string;
    orientation?: "horizontal" | "vertical";
    onValueChange: (v: number) => void;
    onValueCommitted?: (v: number) => void;
  }) => (
    <input
      type="range"
      role="slider"
      className={className}
      aria-label={ariaLabel}
      aria-valuetext={getAriaValueText?.(value)}
      data-orientation={orientation ?? "horizontal"}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.currentTarget.value))}
      onPointerUp={(e) => onValueCommitted?.(Number(e.currentTarget.value))}
    />
  ),
}));

// The project's Role mix, swappable per test: solo/mute combinations are what
// the implied-mute rendering is derived from, and SFX/Voiceover are deliberately
// absent so the absent-Role default stays covered.
const DEFAULT_ROLES: RoleMixView[] = [
  { role: "dialogue", gain_db: -3, muted: false, solo: false },
  { role: "music", gain_db: 2, muted: true, solo: false },
];
const rolesRef = vi.hoisted(() => ({ current: [] as RoleMixView[] }));

vi.mock("../state/projectStore", () => ({
  useAudioRoles: () => rolesRef.current,
}));

import { RoleMixerPanel } from "./RoleMixerPanel";

// Force a deterministic content width so the responsive layout choice is
// testable (jsdom reports 0 for every rect and has no ResizeObserver).
function withWidth(px: number) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: px, height: 0, top: 0, left: 0, right: px, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
}

const faderFor = (role: string) =>
  screen.getByLabelText(`${role} gain fader`) as HTMLInputElement;
/// The dB readout: a button at rest, the number field once opened.
const readoutFor = (role: string) => screen.getByLabelText(`${role} gain (dB)`);
const openReadout = (role: string) => {
  fireEvent.click(readoutFor(role));
  return readoutFor(role) as HTMLInputElement;
};

const meterFor = (role: string) =>
  screen.getByRole("group", { name: `${role} level meter` });

/// One per-Role publication shaped like the tap's: all four Roles sampled at
/// one instant, every Role the test names no level for reading true silence —
/// which is what a gated Role's bus yields.
function publishRoleLevels(levels: Partial<Record<AudioRole, number>>) {
  const samples = {} as Record<AudioRole, { rmsDb: number; peakDb: number }>;
  for (const role of AUDIO_ROLES) {
    const rmsDb = levels[role] ?? SILENCE_DB;
    samples[role] = { rmsDb, peakDb: rmsDb };
  }
  publishRoleMeters(samples);
}

/// The console is the same Panel at a content width above the layout threshold.
function renderConsole(
  onMutated: () => Promise<void> = vi.fn().mockResolvedValue(undefined),
) {
  withWidth(500);
  render(<RoleMixerPanel onMutated={onMutated} />);
}

beforeEach(() => {
  rolesRef.current = DEFAULT_ROLES;
});

afterEach(() => {
  cleanup();
  clearMasterMeter();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("RoleMixerPanel", () => {
  it("keeps Dialogue/Music/SFX/Voiceover as the fixed grouping axis with every control", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByRole("region", { name: "Mixer" })).toBeTruthy();
    // All four Roles render even when the store omits some (SFX/Voiceover fall
    // back to a neutral bus).
    for (const name of ["Dialogue", "Music", "SFX", "Voiceover"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // Each Role exposes a fader, a dB readout, mute, solo, and reset.
    expect(screen.getAllByRole("slider")).toHaveLength(4);
    expect(screen.getAllByLabelText(/gain \(dB\)$/)).toHaveLength(4);
    expect(screen.getAllByLabelText(/^Mute .+ everywhere$/)).toHaveLength(4);
    expect(screen.getAllByLabelText(/^Solo .+ \(mutes the others\)$/)).toHaveLength(4);
    expect(screen.getAllByLabelText(/^Reset .+ gain to 0 dB$/)).toHaveLength(4);
  });

  it("names its Role in the accessible name of every control on a card", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    for (const role of ["Dialogue", "Music", "SFX", "Voiceover"]) {
      expect(screen.getByLabelText(`${role} gain fader`)).toBeTruthy();
      expect(screen.getByLabelText(`${role} gain (dB)`)).toBeTruthy();
      expect(screen.getByLabelText(`Mute ${role} everywhere`)).toBeTruthy();
      expect(screen.getByLabelText(`Solo ${role} (mutes the others)`)).toBeTruthy();
      expect(screen.getByLabelText(`Reset ${role} gain to 0 dB`)).toBeTruthy();
    }
  });

  it("binds the fader to the Role's committed gain", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    expect(faderFor("Dialogue").value).toBe("-3");
  });

  it("announces the fader's value with its unit rather than a bare number", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(faderFor("Dialogue").getAttribute("aria-valuetext")).toBe("-3 dB");
    // And it follows the gesture: a listener hears the unit at every value the
    // drag passes through, not only at the committed one.
    fireEvent.change(faderFor("Dialogue"), { target: { value: "-6" } });
    expect(faderFor("Dialogue").getAttribute("aria-valuetext")).toBe("-6 dB");
  });

  it("records gain edits through setRoleGain without touching the flag path", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    const gain = openReadout("Dialogue");
    fireEvent.change(gain, { target: { value: "-6" } });
    fireEvent.blur(gain);

    await vi.waitFor(() => expect(setRoleGain).toHaveBeenCalledWith("dialogue", -6));
    expect(updateRoleFlags).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("resets a Role to 0 dB through the recorded gain path", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    fireEvent.click(screen.getByLabelText("Reset Music gain to 0 dB"));

    await vi.waitFor(() => expect(setRoleGain).toHaveBeenCalledWith("music", 0));
    expect(updateRoleFlags).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("toggles mute through the unrecorded flag path without touching gain", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    fireEvent.click(screen.getByLabelText("Mute Dialogue everywhere"));

    await vi.waitFor(() => expect(updateRoleFlags).toHaveBeenCalledWith("dialogue", { muted: true }));
    expect(setRoleGain).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("toggles solo through the unrecorded flag path", async () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.click(screen.getByLabelText("Solo Dialogue (mutes the others)"));

    await vi.waitFor(() => expect(updateRoleFlags).toHaveBeenCalledWith("dialogue", { solo: true }));
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("presents the console layout when wide", () => {
    renderConsole();
    expect(screen.getByRole("region", { name: "Mixer" }).className).toContain("mixer-panel--console");
  });

  it("presents the narrow card layout when narrow", () => {
    withWidth(240);
    const root = () => screen.getByRole("region", { name: "Mixer" });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    expect(root().className).toContain("mixer-panel--cards");
    // Exactly one layout modifier — the narrow one, not both.
    expect(root().className).not.toContain("mixer-panel--console");
  });
});

describe("RoleMixerPanel — the dB readout", () => {
  it("shows the gain with its unit at rest", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByRole("button", { name: "Dialogue gain (dB)" }).textContent).toBe("-3 dB");
    expect(screen.getByRole("button", { name: "Music gain (dB)" }).textContent).toBe("2 dB");
  });

  it("becomes a focused input when opened", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    const field = openReadout("Dialogue");
    expect(field).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(field);
  });

  it("Escape in the readout discards the typed value without recording it", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    const field = openReadout("Dialogue");
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(setRoleGain).not.toHaveBeenCalled();
    // Closed again, still showing the committed gain.
    expect(screen.getByRole("button", { name: "Dialogue gain (dB)" }).textContent).toBe("-3 dB");
  });

  it("Escape in the readout leaves a live fader audition running", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(faderFor("Dialogue"), { target: { value: "-6" } });
    const field = openReadout("Dialogue");
    clearRoleGainOverride.mockClear();
    fireEvent.keyDown(field, { key: "Escape" });

    // Closing the readout is not abandoning the drag.
    expect(clearRoleGainOverride).not.toHaveBeenCalled();
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("marks a trimmed Role and leaves a Role at 0 dB unmarked", () => {
    rolesRef.current = [
      { role: "dialogue", gain_db: -3, muted: false, solo: false },
      { role: "music", gain_db: 0, muted: false, solo: false },
    ];
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByRole("button", { name: "Dialogue gain (dB)" }).dataset.neutral).toBe("false");
    expect(screen.getByRole("button", { name: "Music gain (dB)" }).dataset.neutral).toBe("true");
  });
});

describe("RoleMixerPanel — Role Gain audition", () => {
  it("auditions a fader drag live through the renderer-local override, recording nothing yet", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(faderFor("Dialogue"), { target: { value: "-6" } });

    // Live preview only: the override is set, no recorded command fires.
    expect(setRoleGainOverride).toHaveBeenCalledWith("dialogue", -6);
    expect(setRoleGain).not.toHaveBeenCalled();
    // The readout mirrors the drafted value so both widgets agree.
    expect(readoutFor("Dialogue").textContent).toBe("-6 dB");
  });

  it("records exactly one setRoleGain on release and clears the override", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);
    const fader = faderFor("Dialogue");

    // A drag with several intermediate steps, then release.
    fireEvent.change(fader, { target: { value: "-4" } });
    fireEvent.change(fader, { target: { value: "-5.5" } });
    fireEvent.pointerUp(fader);

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(setRoleGain).toHaveBeenCalledTimes(1);
    expect(setRoleGain).toHaveBeenCalledWith("dialogue", -5.5);
    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
    expect(updateRoleFlags).not.toHaveBeenCalled();
  });

  it("Escape restores the original sound and value without recording a command", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    const fader = faderFor("Dialogue");

    fireEvent.change(fader, { target: { value: "-6" } });
    expect(setRoleGainOverride).toHaveBeenCalledWith("dialogue", -6);

    fireEvent.keyDown(fader, { key: "Escape" });
    // Original sound restored (override dropped) and value snapped back.
    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
    expect(fader.value).toBe("-3");

    // The pointer release that still follows the Escape must record nothing.
    fireEvent.pointerUp(fader);
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("Escape outside a gesture is inert (no override churn, no command)", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.keyDown(faderFor("Dialogue"), { key: "Escape" });
    expect(clearRoleGainOverride).not.toHaveBeenCalled();
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("clears live audition overrides when the panel is closed", () => {
    const view = render(
      <RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />,
    );
    fireEvent.change(faderFor("Dialogue"), { target: { value: "-6" } });
    clearRoleGainOverride.mockClear();

    view.unmount();

    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
  });
});

describe("RoleMixerPanel — implied mute", () => {
  it("names the reason on every Role a solo silenced, and not on the soloed one", () => {
    rolesRef.current = [
      { role: "dialogue", gain_db: 0, muted: false, solo: true },
      { role: "music", gain_db: 0, muted: false, solo: false },
    ];
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    // Music plus the two absent Roles — an absent Role defaults to audible only
    // when no solo set exists.
    expect(screen.getAllByText("Silenced")).toHaveLength(3);
    expect(
      screen.getByTitle("Music is silent because another role is soloed").textContent,
    ).toBe("Silenced");
    expect(
      screen.queryByTitle("Dialogue is silent because another role is soloed"),
    ).toBeNull();
  });

  it("reads a Role that is both muted and soloed as muted, not implicitly silenced", () => {
    rolesRef.current = [{ role: "dialogue", gain_db: 0, muted: true, solo: true }];
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    // Mute wins over solo: Dialogue is silent because IT is muted, so it is not
    // the implied-mute case, and the other three carry the badge.
    expect(screen.getByLabelText("Mute Dialogue everywhere").getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.queryByTitle("Dialogue is silent because another role is soloed"),
    ).toBeNull();
    expect(screen.getAllByText("Silenced")).toHaveLength(3);
  });

  it("names the reason with the same badge on a card and on a strip", () => {
    rolesRef.current = [
      { role: "dialogue", gain_db: 0, muted: false, solo: true },
      { role: "music", gain_db: 0, muted: false, solo: false },
    ];
    // The sentence is the title this queries by, so an identical text and skin
    // is the whole of "one badge, two presentations".
    const badge = () => {
      const el = screen.getByTitle("Music is silent because another role is soloed");
      return { text: el.textContent, className: el.className };
    };

    withWidth(240);
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    const onTheCard = badge();
    cleanup();

    renderConsole();

    expect(onTheCard.text).toBe("Silenced");
    expect(badge()).toEqual(onTheCard);
  });

  it("names no reason while nothing is soloed", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryAllByText("Silenced")).toHaveLength(0);
  });
});

describe("RoleMixerPanel — master meter", () => {
  it("shows the real master RMS/Peak from the shared store on one line", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    const meter = screen.getByRole("group", { name: "Master output meter" });
    expect(within(meter).getByText("RMS -18.0 · Peak -6.0 dB")).toBeTruthy();
    // One master reading, standing apart from the four per-Role meters.
    expect(screen.getAllByRole("group", { name: "Master output meter" })).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: /level meter$/ })).toHaveLength(4);
  });

  it("reads silence as −∞ rather than a number", () => {
    publishMasterMeter({ rmsDb: -Infinity, peakDb: -Infinity });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    const meter = screen.getByRole("group", { name: "Master output meter" });
    expect(within(meter).getByText("RMS −∞ · Peak −∞ dB")).toBeTruthy();
  });
});

// Driven by publishing to the shared store rather than by standing up an audio
// graph: the Panel's job here is to read the store onto the right card, and the
// graph's own test owns the topology that fills it.
describe("RoleMixerPanel — per-Role meters", () => {
  it("shows each Role the level published for that Role", () => {
    publishRoleLevels({ dialogue: -12, music: -30 });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(meterFor("Dialogue").textContent).toBe("-12.0");
    expect(meterFor("Music").textContent).toBe("-30.0");
  });

  it("reads a Role at the silence floor as silent, not as a very small number", () => {
    publishRoleLevels({ dialogue: SILENCE_DB, music: -18 });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(meterFor("Dialogue").textContent).toBe("−∞");
    expect(meterFor("Music").textContent).toBe("-18.0");
  });

  it("reads a muted Role as silent while an audible Role still shows level", () => {
    // Music is muted in the default mix, so the audio pass skips its layers and
    // its bus receives nothing — the silence is the reading, not a UI override.
    publishRoleLevels({ dialogue: -9 });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByLabelText("Mute Music everywhere").getAttribute("aria-pressed")).toBe("true");
    expect(meterFor("Music").textContent).toBe("−∞");
    expect(meterFor("Dialogue").textContent).toBe("-9.0");
  });

  it("names its Role in every meter, so four otherwise identical readouts differ", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    for (const role of ["Dialogue", "Music", "SFX", "Voiceover"]) {
      expect(meterFor(role)).toBeTruthy();
    }
  });

  it("asks the tap for samples while it is open and stops asking once closed", () => {
    expect(roleMeterDemandWanted()).toBe(false);

    const view = render(
      <RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />,
    );
    expect(roleMeterDemandWanted()).toBe(true);

    view.unmount();
    expect(roleMeterDemandWanted()).toBe(false);
  });

  it("asks for nothing until the Panel is visible", () => {
    const view = render(
      <RoleMixerPanel
        onMutated={vi.fn().mockResolvedValue(undefined)}
        visible={false}
      />,
    );
    expect(roleMeterDemandWanted()).toBe(false);

    view.rerender(
      <RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} visible />,
    );
    expect(roleMeterDemandWanted()).toBe(true);
  });
});

// jsdom has no layout, so nothing here can see a tick line up with a fader or a
// track measure 104px — that is the e2e's job. These assert what the console
// renders and that it behaves as the card list does.
describe("RoleMixerPanel — the console", () => {
  it("stands every Role up as a strip whose controls still name their Role", () => {
    renderConsole();

    for (const role of ["Dialogue", "Music", "SFX", "Voiceover"]) {
      expect(screen.getByLabelText(`${role} gain fader`)).toBeTruthy();
      expect(screen.getByLabelText(`${role} gain (dB)`)).toBeTruthy();
      expect(screen.getByLabelText(`Mute ${role} everywhere`)).toBeTruthy();
      expect(screen.getByLabelText(`Solo ${role} (mutes the others)`)).toBeTruthy();
      expect(screen.getByLabelText(`Reset ${role} gain to 0 dB`)).toBeTruthy();
    }
    expect(screen.getAllByRole("slider")).toHaveLength(4);
  });

  it("asks for vertical faders, so up and down are increase and decrease", () => {
    renderConsole();

    for (const role of ["Dialogue", "Music", "SFX", "Voiceover"]) {
      expect(faderFor(role).dataset.orientation).toBe("vertical");
    }
  });

  it("announces a vertical fader's value with its unit as the card's does", () => {
    renderConsole();

    expect(faderFor("Dialogue").getAttribute("aria-valuetext")).toBe("-3 dB");
    expect(faderFor("Music").getAttribute("aria-valuetext")).toBe("2 dB");
  });

  it("draws the dB scale once for the whole console, not once per fader", () => {
    renderConsole();

    expect(screen.getAllByRole("img", { name: "dB scale" })).toHaveLength(1);
    // Both ends of the gain range and unity are labelled.
    const scale = screen.getByRole("img", { name: "dB scale" });
    expect(within(scale).getByText("20")).toBeTruthy();
    expect(within(scale).getByText("0")).toBeTruthy();
    expect(within(scale).getByText("-30")).toBeTruthy();
  });

  it("stands the master meter beside the Roles as a fifth strip", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 });
    renderConsole();

    const master = screen.getByRole("group", { name: "Master output meter" });
    // Two columns, RMS and peak — not left and right.
    expect(within(master).getByText("RMS")).toBeTruthy();
    expect(within(master).getByText("Peak")).toBeTruthy();
    expect(within(master).getByText("-18.0")).toBeTruthy();
    expect(within(master).getByText("-6.0")).toBeTruthy();
    // The fifth strip IS the console's metering: the Role strips carry faders,
    // and the per-Role meter is the card's line 3.
    expect(screen.queryAllByRole("group", { name: /level meter$/ })).toHaveLength(0);
  });

  it("auditions a fader drag live and records exactly one edit on release", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    renderConsole(onMutated);
    const fader = faderFor("Dialogue");

    fireEvent.change(fader, { target: { value: "-4" } });
    expect(setRoleGainOverride).toHaveBeenCalledWith("dialogue", -4);
    expect(setRoleGain).not.toHaveBeenCalled();
    // The strip's readout mirrors the drafted value, as the card's does.
    expect(readoutFor("Dialogue").textContent).toBe("-4 dB");

    fireEvent.change(fader, { target: { value: "-5.5" } });
    fireEvent.pointerUp(fader);

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(setRoleGain).toHaveBeenCalledTimes(1);
    expect(setRoleGain).toHaveBeenCalledWith("dialogue", -5.5);
    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
  });

  it("Escape abandons a fader gesture without recording a command", () => {
    renderConsole();
    const fader = faderFor("Dialogue");

    fireEvent.change(fader, { target: { value: "-6" } });
    fireEvent.keyDown(fader, { key: "Escape" });

    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
    expect(fader.value).toBe("-3");

    // The release that still follows the Escape records nothing.
    fireEvent.pointerUp(fader);
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("resets a Role to 0 dB through the recorded gain path", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    renderConsole(onMutated);

    fireEvent.click(screen.getByLabelText("Reset Music gain to 0 dB"));

    await vi.waitFor(() => expect(setRoleGain).toHaveBeenCalledWith("music", 0));
    expect(updateRoleFlags).not.toHaveBeenCalled();
  });

  it("opens the readout for typing, and discards what Escape rejects", () => {
    renderConsole();

    const field = openReadout("Dialogue");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(setRoleGain).not.toHaveBeenCalled();
    expect(readoutFor("Dialogue").textContent).toBe("-3 dB");
  });

  it("toggles mute through the unrecorded flag path", async () => {
    renderConsole();

    fireEvent.click(screen.getByLabelText("Mute Dialogue everywhere"));

    await vi.waitFor(() => expect(updateRoleFlags).toHaveBeenCalledWith("dialogue", { muted: true }));
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("names the reason on every strip a solo silenced, and not on the soloed one", () => {
    rolesRef.current = [
      { role: "dialogue", gain_db: 0, muted: false, solo: true },
      { role: "music", gain_db: 0, muted: false, solo: false },
    ];
    renderConsole();

    // Music plus the two absent Roles, exactly as in the card list.
    expect(screen.getAllByText("Silenced")).toHaveLength(3);
    expect(
      screen.getByTitle("Music is silent because another role is soloed").textContent,
    ).toBe("Silenced");
    expect(
      screen.queryByTitle("Dialogue is silent because another role is soloed"),
    ).toBeNull();
  });
});
