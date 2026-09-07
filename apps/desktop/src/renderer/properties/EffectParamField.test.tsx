// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { updateLayerParamTrack, logEmit } = vi.hoisted(() => ({
  updateLayerParamTrack: vi.fn(async () => {}),
  logEmit: vi.fn(async () => {}),
}));
vi.mock("../ipc", () => ({ updateLayerParamTrack, logEmit }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
  // tryMutate's import chain pulls ../i18n, whose init `.use()`s this plugin.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// Isolate from KeyframeField internals: a stub that surfaces the wired props
// and lets the test fire onCommitTrack.
vi.mock("../components/KeyframeField", () => ({
  KeyframeField: (props: {
    paramKey: string;
    label: string;
    track: { mode: string; value: number };
    showStopwatch?: boolean;
    onCommitTrack: (k: string, t: { mode: "Static"; value: number }) => void;
  }) => (
    <button
      data-testid={`kf-${props.paramKey}`}
      data-stopwatch={String(props.showStopwatch ?? true)}
      onClick={() => props.onCommitTrack(props.paramKey, { mode: "Static", value: 42 })}
    >
      {props.label}:{props.track.mode === "Static" ? props.track.value : "kf"}
    </button>
  ),
}));

import { EffectParamFields } from "./EffectParamField";
import type { EffectView, LayerSummary } from "../ipc";
import type { UiEffectDescriptor } from "../render/effects/effectRegistry";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const layer = { id: "L1" } as unknown as LayerSummary;
const onMutated = vi.fn(async () => {});

const BLUR: UiEffectDescriptor = {
  kind: "blur",
  nameI18nKey: "effects.blur.name",
  category: "blur",
  params: { strength: { default: 8, range: [0, 100], step: 1 } },
};

const DENOISE: UiEffectDescriptor = {
  kind: "audio.denoise",
  nameI18nKey: "effects.audio_denoise.name",
  category: "audio",
  params: {
    strength: { default: 12, range: [1, 40], step: 1, unit: "dB" },
    margin: { default: 8, range: [0, 20], step: 1, unit: "dB" },
    profile_in_us: { default: 0, range: [0, 86_400_000_000], unit: "us" },
    profile_out_us: { default: 0, range: [0, 86_400_000_000], unit: "us" },
  },
  region: { inKey: "profile_in_us", outKey: "profile_out_us", minUs: 250_000 },
};

describe("EffectParamFields", () => {
  it("renders a row per registry param, reading the effect's current value", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 8 } } };
    render(<EffectParamFields layer={layer} effect={effect} descriptor={BLUR} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    // label "strength" (defaultValue) : value 8
    expect(screen.getByText("strength:8")).toBeTruthy();
  });

  it("falls back to the registry default when the param slot is absent", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} descriptor={BLUR} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    expect(screen.getByText("strength:8")).toBeTruthy(); // blur default
  });

  it("commits to the nested effects[id].params[key] track key", async () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} descriptor={BLUR} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("kf-effects[E1].params[strength]"));
    expect(updateLayerParamTrack).toHaveBeenCalledWith("L1", "effects[E1].params[strength]", { mode: "Static", value: 42 });
  });

  it("renders nothing for an unknown kind", () => {
    const effect: EffectView = { id: "E1", kind: "mystery", enabled: true, params: {} };
    const { container } = render(
      <EffectParamFields layer={layer} effect={effect} descriptor={null} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect(container.querySelector("[data-testid^='kf-']")).toBeNull();
  });

  it("keeps the stopwatch on a visual param", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} descriptor={BLUR} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    expect(screen.getByTestId("kf-effects[E1].params[strength]").getAttribute("data-stopwatch")).toBe("true");
  });
});

describe("audio effect params", () => {
  const effect: EffectView = { id: "E1", kind: "audio.denoise", enabled: true, params: {} };
  const renderRows = (playheadInSpan = true) =>
    render(
      <EffectParamFields
        layer={layer}
        effect={effect}
        descriptor={DENOISE}
        tInLayerUs={0}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated}
      />,
    );

  // An audio effect is an offline whole-clip bake, so its params are static by
  // construction — offering a stopwatch would offer an edit the command layer
  // refuses.
  it("renders the two static params with no stopwatch and no region rows", () => {
    renderRows();
    expect(screen.getByTestId("kf-effects[E1].params[strength]").getAttribute("data-stopwatch")).toBe("false");
    expect(screen.getByTestId("kf-effects[E1].params[margin]").getAttribute("data-stopwatch")).toBe("false");
    expect(screen.queryByTestId("kf-effects[E1].params[profile_in_us]")).toBeNull();
    expect(screen.queryByTestId("kf-effects[E1].params[profile_out_us]")).toBeNull();
  });

  it("spells the unit out in the label and falls back to the catalog default", () => {
    renderRows();
    expect(screen.getByText("strength (dB):12")).toBeTruthy();
    expect(screen.getByText("margin (dB):8")).toBeTruthy();
  });

  // A whole-clip value has no "off-clip", so the playhead must not disable it —
  // which is what a bare showStopwatch={false} row does.
  it("stays editable with the playhead outside the clip", () => {
    renderRows(false);
    expect(screen.getByTestId("kf-effects[E1].params[strength]")).toBeTruthy();
  });

  it("commits to the nested effects[id].params[key] track key", async () => {
    renderRows();
    await userEvent.click(screen.getByTestId("kf-effects[E1].params[strength]"));
    expect(updateLayerParamTrack).toHaveBeenCalledWith("L1", "effects[E1].params[strength]", { mode: "Static", value: 42 });
  });
});
