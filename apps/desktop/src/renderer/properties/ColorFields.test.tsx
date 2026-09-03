// @vitest-environment jsdom
//
// The inspector's two animatable colour rows — the Text section's glyph colour
// and the Color section's fill. What they have to get right is the fork the
// stopwatch owns: unlit, a pick is a static params patch and the layer never
// grows a track; lit, the same pick is a keyframe at the playhead, and the
// swatch shows what the engine resolves there rather than the first key.
//
// Drives the real `AttributePanel` with a fixture track, the panel-test
// convention in this folder, and the real `../i18n`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack, LayerSummary, Rgba, TrackSummary } from "../ipc";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayer: vi.fn().mockResolvedValue(undefined),
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
    updateLayerParamTrack: vi.fn().mockResolvedValue(undefined),
  };
});

import { updateLayerParams, updateLayerParamTrack } from "../ipc";
import { AttributePanel } from "./PropertyPanel";
import { clearPropSectionMemory } from "./PropSection";

// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor — same convention as MotifFields.test.tsx.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, ariaLabel }: { checked: boolean; ariaLabel?: string }) => (
    <button role="switch" aria-checked={checked} aria-label={ariaLabel} />
  ),
}));

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearPropSectionMemory();
});

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
const stat = <T,>(value: T) => ({ mode: "Static" as const, value });

/// A red → green colour track over the clip's first second.
const keyedColor: AnimTrack<Rgba> = {
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: [
    { id: "k0", t_us: 0, value: RED, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
    { id: "k1", t_us: 1_000_000, value: GREEN, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
  ],
};

function trackWith(params: LayerSummary["params"]): TrackSummary {
  return {
    id: "track-1", kind: "Video", label: "V1", enabled: true, locked: false,
    muted: false, solo: false, role: null, transient: false,
    layers: [{
      id: "layer-1", kind: params.kind, label: null,
      t_start_us: 0, t_end_us: 2_000_000, enabled: true, locked: false,
      color_hint: "#000000", effects: [], params,
    } as LayerSummary],
  } as TrackSummary;
}

const colorParams = (color: AnimTrack<Rgba>): LayerSummary["params"] =>
  ({ kind: "Color", color, width: 1920, height: 1080 }) as unknown as LayerSummary["params"];

const textParams = (color: AnimTrack<Rgba>): LayerSummary["params"] =>
  ({
    kind: "Text", content: "Hello", font_family: "Liberation Sans", font_size_px: 72,
    weight: 400, italic: false, align: "Center",
    anchor_x: stat(0.5), anchor_y: stat(0.5), color,
    x: stat(960), y: stat(540), scale_x: stat(1), scale_y: stat(1), scale_linked: true,
    rotation_deg: stat(0), opacity: stat(1), outline: null, shadow: null,
    box_w: null, box_h: null, valign: "Middle", line_height: 0, letter_spacing: 0,
  }) as unknown as LayerSummary["params"];

function renderPanel(params: LayerSummary["params"], currentTimeUs = 0) {
  render(
    <AttributePanel
      tracks={[trackWith(params)]}
      selectedLayerId="layer-1"
      onMutated={vi.fn().mockResolvedValue(undefined)}
      fpsNum={30}
      fpsDen={1}
      currentTimeUs={currentTimeUs}
    />,
  );
  const section = screen.getByRole("region", { name: "Color" });
  return { section, swatch: within(section).getByLabelText("Color") as HTMLInputElement, stopwatch: stopwatchOf(section) };
}

/// The stopwatch is the only button in a section that carries `aria-pressed` —
/// the section header is a plain expander and the eyedropper is a plain action.
function stopwatchOf(section: HTMLElement): HTMLButtonElement {
  const btn = within(section).getAllByRole("button").find((b) => b.hasAttribute("aria-pressed"));
  if (!btn) throw new Error("no stopwatch in this section");
  return btn as HTMLButtonElement;
}

/// The debounced commit both paths share.
const COMMIT_DEBOUNCE_MS = 250;

describe("the Color section's fill row", () => {
  it("wears a stopwatch, unlit for a static fill", () => {
    const { stopwatch } = renderPanel(colorParams(stat(RED)));
    expect(stopwatch.getAttribute("aria-pressed")).toBe("false");
  });

  it("commits a static params patch while the stopwatch is unlit", async () => {
    vi.useFakeTimers();
    try {
      const { swatch } = renderPanel(colorParams(stat(RED)));
      fireEvent.change(swatch, { target: { value: "#00ff00" } });
      act(() => { vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS); });
      expect(updateLayerParams).toHaveBeenCalledWith("layer-1", { kind: "Color", color: GREEN });
      expect(updateLayerParamTrack).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lifts the fill to a keyframed track when the stopwatch is turned on", async () => {
    const { stopwatch } = renderPanel(colorParams(stat(RED)), 500_000);
    await userEvent.click(stopwatch);
    await waitFor(() => expect(updateLayerParamTrack).toHaveBeenCalledTimes(1));
    const [layerId, paramKey, next] = vi.mocked(updateLayerParamTrack).mock.calls[0]!;
    expect([layerId, paramKey]).toEqual(["layer-1", "color"]);
    expect(next.mode).toBe("Keyframed");
    expect(next.mode === "Keyframed" && next.value[0]).toMatchObject({ t_us: 500_000, value: RED });
  });

  it("shows the colour the engine resolves at the playhead once lit", () => {
    const { swatch } = renderPanel(colorParams(keyedColor), 500_000);
    const n = parseInt(swatch.value.slice(1), 16);
    // The OkLab mix of red and green, not the sRGB average (128, 128, 0).
    expect((n >> 16) & 0xff).toBeGreaterThan(190);
    expect((n >> 8) & 0xff).toBeGreaterThan(150);
    expect(n & 0xff).toBe(0);
  });

  it("a pick with the stopwatch lit becomes a key at the playhead, not a static patch", async () => {
    vi.useFakeTimers();
    try {
      const { swatch } = renderPanel(colorParams(keyedColor), 500_000);
      fireEvent.change(swatch, { target: { value: "#0000ff" } });
      act(() => { vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS); });
      expect(updateLayerParams).not.toHaveBeenCalled();
      expect(updateLayerParamTrack).toHaveBeenCalledTimes(1);
      const [, paramKey, next] = vi.mocked(updateLayerParamTrack).mock.calls[0]!;
      expect(paramKey).toBe("color");
      const keys = next.mode === "Keyframed" ? next.value : [];
      expect(keys).toHaveLength(3);
      expect(keys.find((k) => k.t_us === 500_000)?.value).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("only debounces once, so dragging inside the native picker is one commit", async () => {
    vi.useFakeTimers();
    try {
      const { swatch } = renderPanel(colorParams(stat(RED)));
      for (const v of ["#010000", "#020000", "#030000"]) {
        fireEvent.change(swatch, { target: { value: v } });
      }
      act(() => { vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS); });
      expect(updateLayerParams).toHaveBeenCalledTimes(1);
      expect(updateLayerParams).toHaveBeenCalledWith("layer-1", { kind: "Color", color: { r: 3, g: 0, b: 0, a: 255 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot start animating off the clip", () => {
    const { stopwatch } = renderPanel(colorParams(stat(RED)), 5_000_000);
    expect(stopwatch.disabled).toBe(true);
  });
});

describe("the Text section's colour row", () => {
  it("carries the same stopwatch and the same auto-key commit", async () => {
    vi.useFakeTimers();
    try {
      render(
        <AttributePanel
          tracks={[trackWith(textParams(keyedColor))]}
          selectedLayerId="layer-1"
          onMutated={vi.fn().mockResolvedValue(undefined)}
          fpsNum={30}
          fpsDen={1}
          currentTimeUs={500_000}
        />,
      );
      const section = screen.getByRole("region", { name: "Text" });
      const swatch = within(section).getByLabelText("Color") as HTMLInputElement;
      fireEvent.change(swatch, { target: { value: "#0000ff" } });
      act(() => { vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS); });
      expect(updateLayerParamTrack).toHaveBeenCalledTimes(1);
      const [, paramKey] = vi.mocked(updateLayerParamTrack).mock.calls[0]!;
      expect(paramKey).toBe("color");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a static Text patch while the stopwatch is unlit", () => {
    vi.useFakeTimers();
    try {
      render(
        <AttributePanel
          tracks={[trackWith(textParams(stat(RED)))]}
          selectedLayerId="layer-1"
          onMutated={vi.fn().mockResolvedValue(undefined)}
          fpsNum={30}
          fpsDen={1}
          currentTimeUs={0}
        />,
      );
      const section = screen.getByRole("region", { name: "Text" });
      fireEvent.change(within(section).getByLabelText("Color"), { target: { value: "#00ff00" } });
      act(() => { vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS); });
      expect(updateLayerParams).toHaveBeenCalledWith("layer-1", { kind: "Text", color: GREEN });
    } finally {
      vi.useRealTimers();
    }
  });
});
