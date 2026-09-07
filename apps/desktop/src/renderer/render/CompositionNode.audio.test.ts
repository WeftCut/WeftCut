import { Container } from "pixi.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioGraph } from "./audio/AudioGraph";
import { CompositionNode, type CompositionNodeHost } from "./CompositionNode";
import type { CompositionSummary, LayerSummary, TrackSummary } from "../ipc";
import { ROOT_ID, summaryFixture } from "../testing/summaryFixture";

// A layer's mixer is opened on ONE artifact and its `ConformSource` is opened
// once, so the only way to follow a bake landing (or an effect being switched
// off) is to replace the mixer. These tests pin exactly that: one replacement
// per url change, and none for the param edits that fire on every tick.

const mixers = vi.hoisted(() => ({
  built: [] as Array<{ url: string; dispose: () => void; disposed: boolean }>,
}));

vi.mock("./audio/AudioMixer", () => ({
  AudioMixer: class {
    private readonly record: {
      url: string;
      dispose: () => void;
      disposed: boolean;
    };
    updateView = vi.fn();
    tick = vi.fn();
    constructor(init: { conformUrl: string }) {
      this.record = {
        url: init.conformUrl,
        dispose: () => {
          this.record.disposed = true;
        },
        disposed: false,
      };
      mixers.built.push(this.record);
    }
    dispose(): void {
      this.record.dispose();
    }
  },
}));

function audioLayer(over: Partial<LayerSummary> = {}): LayerSummary {
  return {
    id: "layer-audio",
    label: null,
    t_start_us: 0,
    t_end_us: 2_000_000,
    kind: "Audio",
    color_hint: "#3c7",
    enabled: true,
    locked: false,
    effects: [],
    ...over,
    params: {
      kind: "Audio",
      media_id: "media-1",
      media_label: "vo.wav",
      src_in_us: 0,
      src_out_us: 2_000_000,
      gain_db: { mode: "Static", value: 0 },
      pan: { mode: "Static", value: 0 },
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "dialogue",
    },
  };
}

function compositionWith(layers: LayerSummary[]): CompositionSummary {
  const track: TrackSummary = {
    id: "track-a",
    kind: "Audio",
    label: "A1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "audio-a",
    transient: false,
    layers,
  };
  return summaryFixture({ root: { duration_us: 2_000_000, tracks: [track] } })
    .compositions[ROOT_ID]!;
}

function setup(url: string) {
  const source = { url };
  const audioSourceUrl = vi.fn(
    (_layerId: string, _mediaId: string): string | null => source.url,
  );
  const host: CompositionNodeHost = {
    renderer: undefined,
    pool: {} as CompositionNodeHost["pool"],
    mode: "preview",
    fpsNum: () => 30,
    fpsDen: () => 1,
    playing: () => true,
    scrubbing: () => false,
    clockAnchor: () => null,
    audioGraph: () => ({}) as AudioGraph,
    audioRoles: () => [],
    resolveSource: () => null,
    proxyAssetUrl: () => null,
    originalAssetUrl: () => null,
    sourceColor: () => undefined,
    mediaById: () => undefined,
    audioSourceUrl,
    motifFrames: () => undefined,
    ensureTenBitIngest: () =>
      ({}) as ReturnType<CompositionNodeHost["ensureTenBitIngest"]>,
    ensureNv12Ingest: () =>
      ({}) as ReturnType<CompositionNodeHost["ensureNv12Ingest"]>,
    releaseIngest: () => {},
    scheduleRepaint: () => {},
    noteUnsupported: () => {},
    noteLateLayer: () => {},
  };
  const composition = compositionWith([audioLayer()]);
  const node = new CompositionNode({
    host,
    composition,
    summary: summaryFixture({ root: composition }),
    width: 1920,
    height: 1080,
    path: "",
    depth: 0,
    offsetUs: 0,
    windowStartUs: Number.NEGATIVE_INFINITY,
    windowEndUs: Number.POSITIVE_INFINITY,
    container: new Container(),
  });
  return { node, source, audioSourceUrl };
}

describe("CompositionNode audio source swaps", () => {
  beforeEach(() => {
    mixers.built.length = 0;
  });

  it("builds one mixer and keeps it while the url is unchanged", () => {
    const { node } = setup("weftcut-media://raw.conform");
    node.compositeAudio(0);
    node.compositeAudio(33_333);
    node.compositeAudio(66_667);
    expect(mixers.built).toHaveLength(1);
    expect(mixers.built[0]!.disposed).toBe(false);
  });

  // Param edits arrive on every tick (the mix folds the role gain in), and are
  // handled by `updateView` — they must never cost a re-open.
  it("keeps the mixer across a param edit on the same url", () => {
    const { node } = setup("weftcut-media://raw.conform");
    node.compositeAudio(0);
    const louder = audioLayer();
    (louder.params as { gain_db: unknown }).gain_db = {
      mode: "Static",
      value: -6,
    };
    node.setComposition(
      compositionWith([louder]),
      summaryFixture({ root: compositionWith([louder]) }),
    );
    node.compositeAudio(33_333);
    expect(mixers.built).toHaveLength(1);
    expect(mixers.built[0]!.disposed).toBe(false);
  });

  it("replaces the mixer exactly once when the url changes", () => {
    const { node, source } = setup("weftcut-media://raw.conform");
    node.compositeAudio(0);
    source.url = "weftcut-media://baked.fx.conform";
    node.compositeAudio(33_333);
    node.compositeAudio(66_667);
    expect(mixers.built.map((m) => m.url)).toEqual([
      "weftcut-media://raw.conform",
      "weftcut-media://baked.fx.conform",
    ]);
    expect(mixers.built[0]!.disposed).toBe(true);
    expect(mixers.built[1]!.disposed).toBe(false);
  });

  // The resolution is per LAYER because two layers can share one media and
  // carry different chains; a per-media answer would play one layer's effects
  // on the other.
  it("resolves the url per layer and per media", () => {
    const { node, audioSourceUrl } = setup("weftcut-media://raw.conform");
    node.compositeAudio(0);
    expect(audioSourceUrl).toHaveBeenCalledWith("layer-audio", "media-1");
  });

  // A url that goes null under a LIVE mixer keeps that mixer: the audio it
  // already holds is closer to the truth than silence.
  it("keeps a live mixer when the url goes null", () => {
    const { node, source } = setup("weftcut-media://raw.conform");
    node.compositeAudio(0);
    (source as { url: string | null }).url = null;
    node.compositeAudio(33_333);
    expect(mixers.built).toHaveLength(1);
    expect(mixers.built[0]!.disposed).toBe(false);
  });

  it("builds nothing while no artifact exists at all", () => {
    const { node } = setup(null as unknown as string);
    node.compositeAudio(0);
    expect(mixers.built).toHaveLength(0);
  });
});
