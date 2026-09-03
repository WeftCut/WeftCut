import { describe, expect, it } from "vitest";

import { keyframeSnapshot, pasteEntriesFor, type KeyframeClipGroup } from "./clipboard";
import type { AnimTrack, Keyframe, LayerSummary, TrackSummary } from "../ipc";
import type { ParamTrackEntry } from "../timeline/keyframeBatch";

type Keyframed = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

const kf = (id: string, tUs: number, value = 1): Keyframe<number> => ({
  id,
  t_us: tUs,
  value,
  in: { x: 2 / 3, y: 2 / 3, mode: "Free" },
  out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
  continuity: "Broken",
  segment: { kind: "Linear" },
});

const keyed = (keys: Keyframe<number>[]): Keyframed => ({
  mode: "Keyframed",
  extrapolate: { before: "Loop", after: "PingPong" },
  value: keys,
});

function layer(
  id: string,
  params: Record<string, unknown>,
  over: Partial<LayerSummary> = {},
): LayerSummary {
  const kind = (over.kind as string) ?? "VideoClip";
  return {
    id,
    kind,
    label: null,
    t_start_us: 0,
    t_end_us: 5_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind, ...params },
    effects: [],
    ...over,
  } as unknown as LayerSummary;
}

const trackOf = (layers: LayerSummary[]): TrackSummary =>
  ({
    id: "T1",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  }) as unknown as TrackSummary;

/// Deterministic ids so a paste's output can be named.
function idGen(): () => string {
  let n = 0;
  return () => `new-${(n += 1)}`;
}

const trackOfEntry = (e: ParamTrackEntry): AnimTrack<number> =>
  e[2] as AnimTrack<number>;

const keysOf = (e: ParamTrackEntry): Keyframe<number>[] => {
  const t = trackOfEntry(e);
  return t.mode === "Keyframed" ? t.value : [];
};

describe("keyframeSnapshot", () => {
  it("rebases the EARLIEST key of the whole snapshot to zero", () => {
    const tracks = [
      trackOf([layer("L1", { opacity: keyed([kf("a", 500_000), kf("b", 900_000)]) })]),
    ];
    const [group] = keyframeSnapshot({
      selected: [
        { layerId: "L1", paramKey: "opacity", kfId: "a" },
        { layerId: "L1", paramKey: "opacity", kfId: "b" },
      ],
      tracks,
    });

    expect(group!.keys.map((k) => k.t_us)).toEqual([0, 400_000]);
  });

  it("compares two layers on the COMPOSITION clock, so a later clip's keys stay later", () => {
    // Both keys sit at the same layer-local time; only the clips' starts differ,
    // and the snapshot has to preserve that gap.
    const tracks = [
      trackOf([
        layer("early", { opacity: keyed([kf("e", 0)]) }, { t_start_us: 1_000_000 }),
        layer("late", { opacity: keyed([kf("l", 0)]) }, { t_start_us: 3_000_000 }),
      ]),
    ];
    const [group] = keyframeSnapshot({
      selected: [
        { layerId: "late", paramKey: "opacity", kfId: "l" },
        { layerId: "early", paramKey: "opacity", kfId: "e" },
      ],
      tracks,
    });

    // ONE group: layer identity is dropped, `paramKey` is the whole address.
    expect(group!.paramKey).toBe("opacity");
    expect(group!.keys.map((k) => k.t_us)).toEqual([0, 2_000_000]);
  });

  it("keeps one group per property, in the order the selection first reached them", () => {
    const tracks = [
      trackOf([
        layer("L1", {
          rotation_deg: keyed([kf("r", 0, 45)]),
          opacity: keyed([kf("o", 0)]),
        }),
      ]),
    ];
    const groups = keyframeSnapshot({
      selected: [
        { layerId: "L1", paramKey: "rotation_deg", kfId: "r" },
        { layerId: "L1", paramKey: "opacity", kfId: "o" },
      ],
      tracks,
    });

    expect(groups.map((g) => g.paramKey)).toEqual(["rotation_deg", "opacity"]);
  });

  it("answers nothing for an empty selection", () => {
    expect(keyframeSnapshot({ selected: [], tracks: [] })).toEqual([]);
  });
});

describe("pasteEntriesFor", () => {
  const groups: KeyframeClipGroup[] = [
    { paramKey: "opacity", keys: [kf("src-0", 0, 1), kf("src-1", 400_000, 0)] },
  ];

  it("lifts a Static target to a Keyframed track holding ONLY the pasted keys", () => {
    const target = layer("T", { opacity: { mode: "Static", value: 0.25 } });
    const { entries } = pasteEntriesFor({
      groups,
      layers: [target],
      atUs: 1_000_000,
      mkId: idGen(),
    });

    const track = trackOfEntry(entries[0]!);
    expect(track.mode).toBe("Keyframed");
    expect(keysOf(entries[0]!).map((k) => k.t_us)).toEqual([1_000_000, 1_400_000]);
    // Hold on both sides: a lifted track states its own extrapolation rather
    // than inheriting one from wherever the keys were copied.
    expect(track.mode === "Keyframed" && track.extrapolate).toEqual({
      before: "Hold",
      after: "Hold",
    });
  });

  it("appends the pasted keys LAST on a Keyframed target and keeps its extrapolation", () => {
    const target = layer("T", { opacity: keyed([kf("own-0", 0), kf("own-1", 1_000_000)]) });
    const { entries } = pasteEntriesFor({
      groups,
      layers: [target],
      atUs: 1_000_000,
      mkId: idGen(),
    });

    // `own-1` sits at exactly the paste point; the pasted key coming after it is
    // what makes main's last-wins dedupe replace it rather than the reverse.
    expect(keysOf(entries[0]!).map((k) => k.id)).toEqual([
      "own-0",
      "own-1",
      "new-1",
      "new-2",
    ]);
    const track = trackOfEntry(entries[0]!);
    expect(track.mode === "Keyframed" && track.extrapolate).toEqual({
      before: "Loop",
      after: "PingPong",
    });
  });

  it("places the keys in the target's own local time, not the composition's", () => {
    const target = layer("T", { opacity: { mode: "Static", value: 1 } }, {
      t_start_us: 2_000_000,
      t_end_us: 6_000_000,
    });
    const { entries } = pasteEntriesFor({
      groups,
      layers: [target],
      atUs: 3_000_000,
      mkId: idGen(),
    });

    expect(keysOf(entries[0]!).map((k) => k.t_us)).toEqual([1_000_000, 1_400_000]);
  });

  it("retains a key past the target's end rather than clipping it", () => {
    const target = layer("T", { opacity: { mode: "Static", value: 1 } }, {
      t_start_us: 0,
      t_end_us: 1_000_000,
    });
    const { entries } = pasteEntriesFor({
      groups,
      layers: [target],
      atUs: 900_000,
      mkId: idGen(),
    });

    expect(keysOf(entries[0]!).map((k) => k.t_us)).toEqual([900_000, 1_300_000]);
  });

  it("mints fresh ids and reports them as the selection the paste leaves behind", () => {
    const target = layer("T", { opacity: { mode: "Static", value: 1 } });
    const { entries, pasted } = pasteEntriesFor({
      groups,
      layers: [target],
      atUs: 0,
      mkId: idGen(),
    });

    expect(keysOf(entries[0]!).map((k) => k.id)).toEqual(["new-1", "new-2"]);
    expect(pasted).toEqual([
      { layerId: "T", paramKey: "opacity", kfId: "new-1" },
      { layerId: "T", paramKey: "opacity", kfId: "new-2" },
    ]);
  });

  it("skips a property the target kind does not carry, and writes nothing for it", () => {
    const audio = layer("A", { gain_db: { mode: "Static", value: 0 } }, { kind: "Audio" });
    const { entries, skipped } = pasteEntriesFor({
      groups,
      layers: [audio],
      atUs: 0,
      mkId: idGen(),
    });

    expect(skipped).toEqual(["opacity"]);
    expect(entries).toEqual([]);
  });

  it("pastes onto every selected layer in one set of entries", () => {
    const a = layer("A", { opacity: { mode: "Static", value: 1 } });
    const b = layer("B", { opacity: { mode: "Static", value: 1 } });
    const { entries } = pasteEntriesFor({
      groups,
      layers: [a, b],
      atUs: 0,
      mkId: idGen(),
    });

    expect(entries.map((e) => [e[0], e[1]])).toEqual([
      ["A", "opacity"],
      ["B", "opacity"],
    ]);
  });

  it("lands both scale axes on the axis a LINKED layer reads", () => {
    // The pair is one property on a linked layer, so a copied `scale_y` must not
    // write the hidden twin on its own — that is what main reads as divergence.
    const linked = layer("T", {
      scale_x: { mode: "Static", value: 1 },
      scale_y: { mode: "Static", value: 1 },
      scale_linked: true,
    });
    const { entries } = pasteEntriesFor({
      groups: [{ paramKey: "scale_y", keys: [kf("s", 0, 2)] }],
      layers: [linked],
      atUs: 0,
      mkId: idGen(),
    });

    expect(entries.map((e) => e[1])).toEqual(["scale_x"]);
  });
});
