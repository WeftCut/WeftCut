// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { updateLayerParamTracks, logEmit } = vi.hoisted(() => ({
  updateLayerParamTracks: vi.fn(async () => {}),
  logEmit: vi.fn(async () => {}),
}));
vi.mock("../ipc", () => ({ updateLayerParamTracks, logEmit }));
// `initReactI18next` is part of the mock because the real i18n singleton
// (reached through errors/tryMutate's refusal copy) calls `.use()` on it at
// import time. The `error` arm keeps the failed line's interpolation visible.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; error?: string }) =>
      o?.error !== undefined ? `${k}:${o.error}` : (o?.defaultValue ?? k),
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// Base UI's NumberField has no business in these tests; the stub surfaces the
// wired value and lets a change fire the commit.
vi.mock("../components/AppNumberField", () => ({
  AppNumberField: ({
    value,
    onCommit,
    ariaLabel,
  }: {
    value: number | null;
    onCommit?: (v: number) => void;
    ariaLabel?: string;
  }) => (
    <input
      aria-label={ariaLabel}
      value={String(value)}
      onChange={(e) => onCommit?.(Number(e.currentTarget.value))}
    />
  ),
}));

import { AudioRegionRow } from "./AudioRegionRow";
import type { AnimTrack, EffectView, LayerSummary } from "../ipc";
import { clear as clearAudioFx, hydrate } from "../state/audioFxStore";
import { useAudioRegionFocusStore } from "../state/audioRegionFocusStore";
import { useAudioRegionArmStore } from "../timeline/audioRegionArmStore";

const REGION = { inKey: "profile_in_us", outKey: "profile_out_us", minUs: 250_000 };
const SIG = "a".repeat(64);

/// A 3 s clip starting 2 s into its media, so the source span is
/// [2 s, 5 s) — distinct from the composition span on purpose: region bounds
/// are SOURCE time and a test that shares the two numbers proves nothing.
function audioLayer(clipUs = 3_000_000): LayerSummary {
  return {
    id: "L1",
    t_start_us: 1_000_000,
    t_end_us: 1_000_000 + clipUs,
    effects: [],
    params: { kind: "Audio", src_in_us: 2_000_000 },
  } as unknown as LayerSummary;
}

function denoise(bounds: { inUs?: number; outUs?: number } = {}): EffectView {
  const params: Record<string, AnimTrack<number>> = {};
  if (bounds.inUs !== undefined) params[REGION.inKey] = { mode: "Static", value: bounds.inUs };
  if (bounds.outUs !== undefined) params[REGION.outKey] = { mode: "Static", value: bounds.outUs };
  return { id: "E1", kind: "audio.denoise", enabled: true, params };
}

const onMutated = vi.fn(async () => {});

function renderRow(effect: EffectView, layer = audioLayer()) {
  return render(
    <AudioRegionRow layer={layer} effect={effect} region={REGION} onMutated={onMutated} />,
  );
}

function stateLine(): string | null {
  return screen.queryByTestId("audio-region-state")?.textContent ?? null;
}

/// A bake that satisfies its own desire — the ready case.
function readyFx() {
  hydrate({
    L1: {
      desired_sig: SIG,
      ready: {
        sig: SIG,
        media_hash: "deadbeef",
        audio_path: "/cache/audio/deadbeef.fx.conform",
        peaks_path: "/cache/audio/waveforms/deadbeef.fx.v4.peaks",
      },
      pending: null,
      error: null,
    },
  });
}

beforeEach(() => {
  clearAudioFx();
  useAudioRegionFocusStore.setState({ focus: null });
  useAudioRegionArmStore.setState({ armed: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AudioRegionRow state line", () => {
  it("asks for a region while either bound is unwritten", () => {
    renderRow(denoise());
    expect(stateLine()).toBe("effects.audio.region_needed");
    cleanup();
    renderRow(denoise({ inUs: 2_200_000 }));
    expect(stateLine()).toBe("effects.audio.region_needed");
  });

  it("calls out a span shorter than the filter can learn from", () => {
    renderRow(denoise({ inUs: 2_200_000, outUs: 2_300_000 }));
    expect(stateLine()).toBe("effects.audio.region_too_short");
  });

  // Region bounds are source time, so a trim can move the clip's window off
  // the region without invalidating the bake — the card says so.
  it("calls out a region outside the part of the media this clip plays", () => {
    renderRow(denoise({ inUs: 10_000_000, outUs: 11_000_000 }));
    expect(stateLine()).toBe("effects.audio.region_offscreen");
  });

  it("says nothing once the bake is ready", () => {
    readyFx();
    renderRow(denoise({ inUs: 2_200_000, outUs: 3_000_000 }));
    expect(stateLine()).toBeNull();
  });

  it("reports a running bake", () => {
    hydrate({ L1: { desired_sig: SIG, ready: null, pending: SIG, error: null } });
    renderRow(denoise({ inUs: 2_200_000, outUs: 3_000_000 }));
    expect(stateLine()).toBe("effects.audio.status.pending");
  });

  it("names the failure, because a silent fallback is not what the user heard", () => {
    hydrate({
      L1: {
        desired_sig: SIG,
        ready: null,
        pending: null,
        error: { message: "ffmpeg exited 1", effect_id: "E1", kind: "audio.denoise" },
      },
    });
    renderRow(denoise({ inUs: 2_200_000, outUs: 3_000_000 }));
    expect(stateLine()).toBe("effects.audio.status.failed:ffmpeg exited 1");
  });

  // An incomplete region keeps the effect out of the chain entirely, so any
  // status the baker last published describes a PREVIOUS region.
  it("a region problem outranks the published status", () => {
    hydrate({ L1: { desired_sig: SIG, ready: null, pending: SIG, error: null } });
    renderRow(denoise());
    expect(stateLine()).toBe("effects.audio.region_needed");
  });
});

describe("AudioRegionRow bounds", () => {
  it("shows both bounds in source seconds", () => {
    renderRow(denoise({ inUs: 2_200_000, outUs: 3_000_000 }));
    expect(within(screen.getByTestId("audio-region-in")).getByRole("textbox")).toHaveProperty(
      "value",
      "2.2",
    );
    expect(within(screen.getByTestId("audio-region-out")).getByRole("textbox")).toHaveProperty(
      "value",
      "3",
    );
  });

  // One edit is one undo entry covering the pair, so a region typed into an
  // empty card lands whole instead of as a key its sibling cannot complete.
  it("an edit to either field commits both keys as ONE batch", () => {
    renderRow(denoise({ inUs: 2_200_000, outUs: 3_000_000 }));
    fireEvent.change(within(screen.getByTestId("audio-region-in")).getByRole("textbox"), {
      target: { value: "2.5" },
    });
    expect(updateLayerParamTracks).toHaveBeenCalledTimes(1);
    expect(updateLayerParamTracks).toHaveBeenCalledWith("L1", [
      ["effects[E1].params[profile_in_us]", { mode: "Static", value: 2_500_000 }],
      ["effects[E1].params[profile_out_us]", { mode: "Static", value: 3_000_000 }],
    ]);
  });

  it("an unwritten sibling commits as zero rather than staying absent", () => {
    renderRow(denoise());
    fireEvent.change(within(screen.getByTestId("audio-region-out")).getByRole("textbox"), {
      target: { value: "1.5" },
    });
    expect(updateLayerParamTracks).toHaveBeenCalledWith("L1", [
      ["effects[E1].params[profile_in_us]", { mode: "Static", value: 0 }],
      ["effects[E1].params[profile_out_us]", { mode: "Static", value: 1_500_000 }],
    ]);
  });
});

describe("AudioRegionRow arming", () => {
  it("arms the timeline with the ids, both param keys and the minimum span", async () => {
    renderRow(denoise());
    await userEvent.click(screen.getByTestId("audio-region-select"));
    expect(useAudioRegionArmStore.getState().armed).toEqual({
      layerId: "L1",
      effectId: "E1",
      inKey: "profile_in_us",
      outKey: "profile_out_us",
      minUs: 250_000,
    });
  });

  // A clip shorter than the minimum span has no region to paint, so the button
  // says why instead of arming a gesture that could never commit.
  it("is disabled with a reason on a clip shorter than the minimum span", async () => {
    renderRow(denoise(), audioLayer(200_000));
    const button = screen.getByTestId("audio-region-select");
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBe("effects.audio.select_region_too_short");
    await userEvent.click(button);
    expect(useAudioRegionArmStore.getState().armed).toBeNull();
  });

  it("carries no tooltip when the clip is long enough", () => {
    renderRow(denoise());
    expect(screen.getByTestId("audio-region-select").getAttribute("title")).toBeNull();
  });
});

describe("AudioRegionRow band focus", () => {
  it("claims the band while on screen and releases it on unmount", () => {
    const { unmount } = renderRow(denoise());
    expect(useAudioRegionFocusStore.getState().focus).toEqual({ layerId: "L1", effectId: "E1" });
    unmount();
    expect(useAudioRegionFocusStore.getState().focus).toBeNull();
  });
});
