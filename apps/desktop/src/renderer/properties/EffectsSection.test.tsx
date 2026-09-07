// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { addEffect, updateEffect, moveEffect, removeEffect, logEmit } = vi.hoisted(() => ({
  addEffect: vi.fn(async () => "new-id"),
  updateEffect: vi.fn(async () => {}),
  moveEffect: vi.fn(async () => {}),
  removeEffect: vi.fn(async () => {}),
  logEmit: vi.fn(async () => {}),
}));
const { updateLayerParamTracks } = vi.hoisted(() => ({
  updateLayerParamTracks: vi.fn(async (_layerId: string, _entries: [string, unknown][]) => {}),
}));
vi.mock("../ipc", () => ({ addEffect, updateEffect, moveEffect, removeEffect, updateLayerParamTracks, logEmit }));
// `initReactI18next` is part of the mock because the real i18n singleton
// (`../i18n`, reached through errors/tryMutate's refusal copy) calls
// `.use(initReactI18next)` at import time — a mock missing it fails the whole
// file at load, before any test runs.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("./EffectParamField", () => ({
  EffectParamFields: ({ effect }: { effect: EffectView }) => (
    <div data-testid={`effect-params-${effect.id}`} />
  ),
}));
// The region row renders for real (it is what the focus-store lifecycle below
// is about), so only its number widget is stubbed — Base UI's NumberField has
// no business in these tests.
vi.mock("../components/AppNumberField", () => ({
  AppNumberField: ({ value, ariaLabel }: { value: number | null; ariaLabel?: string }) => (
    <input readOnly aria-label={ariaLabel} value={String(value)} />
  ),
}));
// The picker's own ranking/keyboard behaviour is covered in EffectPicker.test;
// here it stands in as the "user chose a kind" edge so these tests never
// depend on Base UI's portal + focus machinery.
vi.mock("./EffectPicker", () => ({
  EffectPicker: ({
    catalog,
    onPick,
  }: {
    catalog: Array<{ kind: string }>;
    onPick: (kind: string) => void;
  }) => (
    <button
      data-testid="effect-add"
      data-kinds={catalog.map((d) => d.kind).join(",")}
      onClick={() => onPick(catalog[0]!.kind)}
    >
      add
    </button>
  ),
}));
const { pickColor } = vi.hoisted(() => ({
  pickColor: vi.fn(async () => ({ hex: "#0000ff", source: "composition" as const })),
}));
vi.mock("../colorpick/pickColor", () => ({ pickColor }));
const { setTransientOverrides, clearTransientOverrides } = vi.hoisted(() => ({
  setTransientOverrides: vi.fn(),
  clearTransientOverrides: vi.fn(),
}));
vi.mock("../render/effects/effectOverrides", () => ({ setTransientOverrides, clearTransientOverrides }));
// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor (which jsdom doesn't implement). EffectsSection tests cover the
// wiring, not the switch widget itself.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, onCheckedChange, "data-testid": testId }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { audioCatalogForUi, EffectsSection } from "./EffectsSection";
import type { EffectView, LayerSummary } from "../ipc";
import type { UiEffectDescriptor } from "../render/effects/effectRegistry";
import {
  regionFocus,
  useAudioRegionFocusStore,
} from "../state/audioRegionFocusStore";
import { useAudioRegionArmStore } from "../timeline/audioRegionArmStore";

// jsdom has no PointerEvent constructor; MouseEvent carries the same client
// coordinates the pointer sequence needs.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The section is data-driven off its `catalog` prop, so the tests hand it one
// instead of standing in for the registry.
const CATALOG: UiEffectDescriptor[] = [
  {
    kind: "blur",
    nameI18nKey: "effects.blur.name",
    category: "blur",
    params: { strength: { default: 8 }, extra: { default: 2 } },
  },
];

function layerWith(effects: EffectView[]): LayerSummary {
  return { id: "L1", effects } as unknown as LayerSummary;
}
const blur = (id: string, enabled = true): EffectView => ({
  id,
  kind: "blur",
  enabled,
  params: { strength: { mode: "Static", value: 8 } },
});
const onMutated = vi.fn(async () => {});

/// The secondary actions live behind the card's ⋯ overflow menu (Base UI Menu,
/// portalled), so every one of them needs its trigger opened first.
async function openCardMenu(index: number) {
  await userEvent.click(screen.getByTestId(`effect-menu-${index}`));
  return screen.findByTestId(`effect-up-${index}`);
}

describe("EffectsSection", () => {
  it("renders one row per effect, named from the catalog", () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    // effects.blur.name has no translation in the mock → falls back to defaultValue "blur".
    expect(within(screen.getByTestId("effect-row-0")).getByText("blur")).toBeTruthy();
  });

  it("picking a kind in the add picker calls addEffect with it", async () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-add"));
    expect(addEffect).toHaveBeenCalledWith("L1", "blur");
  });

  it("an empty chain states so, and shows no order hint", () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    expect(screen.getByText("effects.empty_chain")).toBeTruthy();
    expect(screen.queryByText("effects.order_hint")).toBeNull();
  });

  it("numbers the cards by chain position and states the apply direction", () => {
    render(
      <EffectsSection catalog={CATALOG} layer={layerWith([blur("E1"), blur("E2")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect(within(screen.getByTestId("effect-row-0")).getByText("1")).toBeTruthy();
    expect(within(screen.getByTestId("effect-row-1")).getByText("2")).toBeTruthy();
    expect(screen.getByText("effects.order_hint")).toBeTruthy();
  });

  it("toggling enable calls updateEffect with the negated flag", async () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([blur("E1", true)])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-enable-0"));
    expect(updateEffect).toHaveBeenCalledWith("L1", "E1", { enabled: false });
  });

  it("remove calls removeEffect", async () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await openCardMenu(0);
    await userEvent.click(screen.getByTestId("effect-remove-0"));
    expect(removeEffect).toHaveBeenCalledWith("L1", "E1");
  });

  it("up is disabled at index 0; down moves to index+1", async () => {
    render(
      <EffectsSection catalog={CATALOG} layer={layerWith([blur("E1"), blur("E2")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    const up = await openCardMenu(0);
    expect(up.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByTestId("effect-down-0"));
    expect(moveEffect).toHaveBeenCalledWith("L1", "E1", 1);
  });

  it("reset writes every catalog param back to its default as ONE batch", async () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await openCardMenu(0);
    await userEvent.click(screen.getByTestId("effect-reset-0"));
    expect(updateLayerParamTracks).toHaveBeenCalledTimes(1);
    expect(updateLayerParamTracks).toHaveBeenCalledWith("L1", [
      ["effects[E1].params[strength]", { mode: "Static", value: 8 }],
      ["effects[E1].params[extra]", { mode: "Static", value: 2 }],
    ]);
    // A visual effect has no unsettable param, so it never needs update_effect.
    expect(updateEffect).not.toHaveBeenCalled();
  });

  it("cards start expanded; the collapse toggle hides and restores the param rows", async () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    const toggle = screen.getByTestId("effect-collapse-0");
    expect(screen.getByTestId("effect-params-E1")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(toggle);
    expect(screen.queryByTestId("effect-params-E1")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(toggle);
    expect(screen.getByTestId("effect-params-E1")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapse state follows the card across a reorder, not the row position", async () => {
    const { rerender } = render(
      <EffectsSection catalog={CATALOG} layer={layerWith([blur("E1"), blur("E2")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    await userEvent.click(screen.getByTestId("effect-collapse-0")); // collapse E1

    rerender(
      <EffectsSection catalog={CATALOG} layer={layerWith([blur("E2"), blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect(screen.getByTestId("effect-params-E2")).toBeTruthy();
    expect(screen.queryByTestId("effect-params-E1")).toBeNull();
    expect(screen.getByTestId("effect-collapse-1").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("pointer reorder", () => {
  const three = () => layerWith([blur("E1"), blur("E2"), blur("E3")]);
  const rows = () => [0, 1, 2].map((i) => screen.getByTestId(`effect-row-${i}`));

  // jsdom rects are all zero; give each row a real vertical slot so the
  // gesture math has something to hit.
  function mockRowRects(tops: number[], height = 40) {
    rows().forEach((row, i) => {
      const top = tops[i]!;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 120,
          width: 120,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  function renderThreeRows() {
    render(<EffectsSection catalog={CATALOG} layer={three()} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    mockRowRects([0, 40, 80]);
  }

  it("issues exactly one moveEffect at drop, none during the move, and never starts an HTML5 drag", async () => {
    renderThreeRows();
    const dragstart = vi.fn();
    document.addEventListener("dragstart", dragstart);
    try {
      const grip = screen.getByTestId("effect-drag-0");
      expect(grip.getAttribute("draggable")).toBeNull();
      fireEvent.pointerDown(grip, { button: 0, clientX: 8, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

      // Live target indication mid-gesture, but no command before release.
      expect(rows()[0]!.className).toContain("prop-effect-row--dragging");
      expect(rows()[2]!.className).toContain("prop-effect-row--drop-before");
      expect(moveEffect).not.toHaveBeenCalled();

      fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
      expect(moveEffect).toHaveBeenCalledTimes(1);
      expect(moveEffect).toHaveBeenCalledWith("L1", "E1", 1);
      await vi.waitFor(() => expect(onMutated).toHaveBeenCalled());
      expect(dragstart).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("dragstart", dragstart);
    }
  });

  it("dropping back onto the origin gap issues no command", () => {
    renderThreeRows();
    fireEvent.pointerDown(screen.getByTestId("effect-drag-0"), { button: 0, clientX: 8, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 8, clientY: 30 });
    expect(moveEffect).not.toHaveBeenCalled();
  });

  it("Escape cancels the gesture and clears the target indication", () => {
    renderThreeRows();
    fireEvent.pointerDown(screen.getByTestId("effect-drag-0"), { button: 0, clientX: 8, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });
    expect(rows()[2]!.className).toContain("prop-effect-row--drop-before");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(rows()[2]!.className).not.toContain("prop-effect-row--drop-before");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(moveEffect).not.toHaveBeenCalled();
  });

  it("pointercancel disarms the gesture; a later pointerup commits nothing", () => {
    renderThreeRows();
    fireEvent.pointerDown(screen.getByTestId("effect-drag-0"), { button: 0, clientX: 8, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });
    expect(rows()[2]!.className).toContain("prop-effect-row--drop-before");

    fireEvent.pointerCancel(window);
    expect(rows()[2]!.className).not.toContain("prop-effect-row--drop-before");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(moveEffect).not.toHaveBeenCalled();
  });

  it("dragging the last card above the first moves it to index 0", () => {
    renderThreeRows();
    fireEvent.pointerDown(screen.getByTestId("effect-drag-2"), { button: 0, clientX: 8, clientY: 90 });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 5 });
    expect(rows()[0]!.className).toContain("prop-effect-row--drop-before");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 5 });
    expect(moveEffect).toHaveBeenCalledTimes(1);
    expect(moveEffect).toHaveBeenCalledWith("L1", "E3", 0);
  });

  it("dragging the first card below the last targets the end of the chain", () => {
    renderThreeRows();
    fireEvent.pointerDown(screen.getByTestId("effect-drag-0"), { button: 0, clientX: 8, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 110 });
    expect(rows()[2]!.className).toContain("prop-effect-row--drop-after");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 110 });
    expect(moveEffect).toHaveBeenCalledTimes(1);
    expect(moveEffect).toHaveBeenCalledWith("L1", "E1", 2);
  });
});

describe("effect color pick", () => {
  const chroma = (id: string): EffectView => ({
    id,
    kind: "chromakey",
    enabled: true,
    params: {},
  });
  const chromaDescriptor: UiEffectDescriptor = {
    kind: "chromakey",
    nameI18nKey: "effects.chromakey.name",
    category: "keying",
    colorGroups: [{ params: ["keyR", "keyG", "keyB"] }],
    params: {
      keyR: { default: 0 },
      keyG: { default: 1 },
      keyB: { default: 0 },
    },
  };
  const chromaCatalog = [chromaDescriptor];

  it("commits a pick as ONE batched three-track write", async () => {
    render(<EffectsSection catalog={chromaCatalog} layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));
    expect(pickColor).toHaveBeenCalledWith(
      expect.objectContaining({ excludeEffectId: "E1" }),
    );
    expect(clearTransientOverrides).toHaveBeenCalledWith("E1");
    expect(updateLayerParamTracks).toHaveBeenCalledTimes(1);
    const [layerId, entries] = updateLayerParamTracks.mock.calls[0]!;
    expect(layerId).toBe("L1");
    expect(entries).toEqual([
      ["effects[E1].params[keyR]", { mode: "Static", value: 0 }],
      ["effects[E1].params[keyG]", { mode: "Static", value: 0 }],
      ["effects[E1].params[keyB]", { mode: "Static", value: 1 }],
    ]);
  });

  it("hover routes through transient overrides", async () => {
    pickColor.mockImplementationOnce((async (opts?: { onHover?: (hex: string) => void }) => {
      opts?.onHover?.("#ff0000");
      return null; // then cancel
    }) as never);
    render(<EffectsSection catalog={chromaCatalog} layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));
    expect(setTransientOverrides).toHaveBeenCalledWith("E1", { keyR: 1, keyG: 0, keyB: 0 });
    expect(clearTransientOverrides).toHaveBeenCalledWith("E1");
    expect(updateLayerParamTracks).not.toHaveBeenCalled();
  });

  it("commit is skipped when the effect vanished mid-session", async () => {
    let resolvePick!: (r: { hex: string; source: "composition" } | null) => void;
    pickColor.mockImplementationOnce(
      (() =>
        new Promise((r) => {
          resolvePick = r;
        })) as never,
    );
    const { rerender } = render(
      <EffectsSection catalog={chromaCatalog} layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));

    // The effect is deleted from the track mid-session — its row unmounts —
    // before the pending pick settles.
    rerender(<EffectsSection catalog={chromaCatalog} layer={layerWith([])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);

    resolvePick({ hex: "#0000ff", source: "composition" });
    await vi.waitFor(() => expect(clearTransientOverrides).toHaveBeenCalledWith("E1"));
    expect(updateLayerParamTracks).not.toHaveBeenCalled();
  });
});

describe("audio chain", () => {
  const denoise = (id: string, params: EffectView["params"] = {}): EffectView => ({
    id,
    kind: "audio.denoise",
    enabled: true,
    params,
  });
  const region = {
    profile_in_us: { mode: "Static" as const, value: 200_000 },
    profile_out_us: { mode: "Static" as const, value: 1_800_000 },
  };
  function audioLayer(effects: EffectView[]): LayerSummary {
    return {
      id: "L1",
      t_start_us: 0,
      t_end_us: 10_000_000,
      effects,
      params: { kind: "Audio", src_in_us: 0 },
    } as unknown as LayerSummary;
  }

  beforeEach(() => {
    useAudioRegionFocusStore.setState({ mounted: [] });
    useAudioRegionArmStore.setState({ armed: null });
  });

  // The two catalogs are two lifecycles: a bake cannot run on a picture and a
  // Pixi filter cannot run on a waveform, so neither picker may offer the other.
  it("offers only the audio catalog on an Audio layer", () => {
    render(
      <EffectsSection
        catalog={audioCatalogForUi}
        layer={audioLayer([])}
        tInLayerUs={0}
        playheadInSpan
        onMutated={onMutated}
      />,
    );
    expect(screen.getByTestId("effect-add").getAttribute("data-kinds")).toBe("audio.denoise");
  });

  it("offers no audio kinds on a visual layer", () => {
    render(
      <EffectsSection catalog={CATALOG} layer={layerWith([])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    const kinds = screen.getByTestId("effect-add").getAttribute("data-kinds") ?? "";
    expect(kinds.split(",").some((k) => k.startsWith("audio."))).toBe(false);
  });

  it("names the denoise card from the audio catalog and gives it a region row", () => {
    render(
      <EffectsSection
        catalog={audioCatalogForUi}
        layer={audioLayer([denoise("E1", region)])}
        tInLayerUs={0}
        playheadInSpan
        onMutated={onMutated}
      />,
    );
    // The stub `t` answers with the fallback, which for a card name is the kind
    // — so this is the catalog's own `nameI18nKey` being asked for.
    expect(within(screen.getByTestId("effect-row-0")).getByText("audio.denoise")).toBeTruthy();
    expect(screen.getByTestId("audio-region-in")).toBeTruthy();
    expect(screen.getByTestId("audio-region-out")).toBeTruthy();
    expect(screen.getByTestId("audio-region-select")).toBeTruthy();
  });

  it("a visual card has no region row", () => {
    render(<EffectsSection catalog={CATALOG} layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    expect(screen.queryByTestId("audio-region-select")).toBeNull();
  });

  // The band is drawable only while the card that owns it is expanded, so the
  // collapse toggle is what releases the focus — no second toggle to explain.
  it("claims the region focus while expanded and releases it on collapse", async () => {
    render(
      <EffectsSection
        catalog={audioCatalogForUi}
        layer={audioLayer([denoise("E1", region)])}
        tInLayerUs={0}
        playheadInSpan
        onMutated={onMutated}
      />,
    );
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "E1" });

    await userEvent.click(screen.getByTestId("effect-collapse-0"));
    expect(regionFocus()).toBeNull();

    await userEvent.click(screen.getByTestId("effect-collapse-0"));
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "E1" });
  });

  it("releases the region focus when the card unmounts", () => {
    const { unmount } = render(
      <EffectsSection
        catalog={audioCatalogForUi}
        layer={audioLayer([denoise("E1", region)])}
        tInLayerUs={0}
        playheadInSpan
        onMutated={onMutated}
      />,
    );
    unmount();
    expect(regionFocus()).toBeNull();
  });

  // Reset puts the region back to UNSET, not to a default: an absent key is
  // what "no region yet" is, and only `update_effect` can express a removal —
  // one call, so the whole reset is one undo.
  it("reset defaults the static params and unsets the region in ONE update_effect", async () => {
    render(
      <EffectsSection
        catalog={audioCatalogForUi}
        layer={audioLayer([denoise("E1", region)])}
        tInLayerUs={0}
        playheadInSpan
        onMutated={onMutated}
      />,
    );
    await openCardMenu(0);
    await userEvent.click(screen.getByTestId("effect-reset-0"));
    expect(updateEffect).toHaveBeenCalledTimes(1);
    expect(updateEffect).toHaveBeenCalledWith("L1", "E1", {
      params: {
        strength: { mode: "Static", value: 12 },
        margin: { mode: "Static", value: 8 },
        profile_in_us: null,
        profile_out_us: null,
      },
    });
    // The param-track batch is the visual chain's path and cannot remove a key.
    expect(updateLayerParamTracks).not.toHaveBeenCalled();
  });
});
