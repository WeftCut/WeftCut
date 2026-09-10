// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "../i18n";
import type { LayerSummary, TrackSummary } from "../ipc";

// The stub surfaces the wired props, `catalog` included — which catalog a layer
// edits is this Panel's one decision. The real `audioCatalogForUi` comes through
// so the assertion below is against the shipped audio catalog, not a fixture.
vi.mock("../properties/EffectsSection", async () => {
  const { AUDIO_EFFECTS } = await import("../../shared/audioEffects/catalog");
  return {
    audioCatalogForUi: Object.values(AUDIO_EFFECTS),
    EffectsSection: ({
      layer,
      catalog,
      tInLayerUs,
      playheadInSpan,
    }: {
      layer: LayerSummary;
      catalog: Array<{ kind: string }>;
      tInLayerUs: number;
      playheadInSpan: boolean;
    }) => (
      <div
        data-testid="effect-chain"
        data-layer-id={layer.id}
        data-relative-time={tInLayerUs}
        data-in-span={String(playheadInSpan)}
        data-kinds={catalog.map((d) => d.kind).join(",")}
      >
        {layer.effects.length} effect
      </div>
    ),
  };
});

import { EffectPanel } from "./EffectPanel";

afterEach(() => cleanup());

function trackWithLayer(
  kind: "Color" | "Audio",
  effects = 1,
): TrackSummary {
  return {
    id: "track-1",
    kind: kind === "Audio" ? "Audio" : "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-1",
        kind,
        label: null,
        t_start_us: 1_000_000,
        t_end_us: 3_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: Array.from({ length: effects }, (_, index) => ({
          id: `effect-${index}`,
          kind: "blur",
          enabled: true,
          params: {},
        })),
        params: { kind } as LayerSummary["params"],
      },
    ],
  };
}

describe("EffectPanel boundary", () => {
  it("renders the primary visual Layer's chain with playhead context", () => {
    render(
      <EffectPanel
        tracks={[trackWithLayer("Color", 2)]}
        selectedLayerId="layer-1"
        currentTimeUs={2_000_000}
        onMutated={async () => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Effects" })).toBeTruthy();
    const chain = screen.getByTestId("effect-chain");
    expect(chain.getAttribute("data-layer-id")).toBe("layer-1");
    expect(chain.getAttribute("data-relative-time")).toBe("1000000");
    expect(chain.getAttribute("data-in-span")).toBe("true");
    expect(chain.textContent).toBe("2 effect");
  });

  it("shows an empty state with no chain surface when nothing is selected", () => {
    render(
      <EffectPanel
        tracks={[]}
        selectedLayerId={null}
        currentTimeUs={0}
        onMutated={async () => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Effects" })).toBeTruthy();
    expect(screen.getByText("Select a clip to edit its effects.")).toBeTruthy();
    expect(screen.queryByTestId("effect-chain")).toBeNull();
  });

  // An audio effect is an offline bake and a visual one a realtime filter: two
  // lifecycles on one card surface, and the layer's kind picks the catalog.
  it("renders an Audio Layer's chain with the audio catalog", () => {
    render(
      <EffectPanel
        tracks={[trackWithLayer("Audio")]}
        selectedLayerId="layer-1"
        currentTimeUs={0}
        onMutated={async () => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Effects" })).toBeTruthy();
    const chain = screen.getByTestId("effect-chain");
    expect(chain.getAttribute("data-layer-id")).toBe("layer-1");
    expect(chain.getAttribute("data-kinds")).toBe("audio.denoise");
  });

  it("offers no audio kinds to a visual Layer", () => {
    render(
      <EffectPanel
        tracks={[trackWithLayer("Color")]}
        selectedLayerId="layer-1"
        currentTimeUs={0}
        onMutated={async () => {}}
      />,
    );

    const kinds = (screen.getByTestId("effect-chain").getAttribute("data-kinds") ?? "").split(",");
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.some((k) => k.startsWith("audio."))).toBe(false);
  });
});
