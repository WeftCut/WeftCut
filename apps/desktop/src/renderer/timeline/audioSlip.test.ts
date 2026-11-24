// Sample-precision audio authoring (ADR 0038), as properties of the pure slip
// logic. The UI wiring around these (shortcut dispatch, IPC, badge render) is thin
// by design so the load-bearing behaviour is testable here rather than through a
// driven app.
import { describe, expect, it } from "vitest";
import {
  NUDGE_MS,
  NUDGE_SAMPLE,
  formatSyncOffset,
  nudgedSource,
  resyncedSource,
  slippableAudioLayers,
  syncOffsetSamples,
  type SlipLayer,
} from "./audioSlip";
import { AUDIO_GRID, frameGrid, gridIndex, timeUsAtGridIndex, travelOnGrid } from "../grid";
import {
  deriveAudioSyncOffsets,
  selectAudioSyncOffset,
} from "./audioSyncOffsetStore";

// 29.97, where a frame is not a whole number of samples (48000 × 1001/30000 =
// 1601.6 per frame). At the six nesting rates a frame boundary IS a sample
// boundary, so a test there could not tell a sample step from a frame step.
const FPS = { num: 30_000, den: 1001 };
const frame = (i: number) => timeUsAtGridIndex(i, frameGrid(FPS));
const sample = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID);
const MEDIA = "take-1";

type Params = SlipLayer["params"];

/** A layer playing `MEDIA` from `srcIn` between frames `from` and `to`, its
 *  source fields under `params` as a `LayerSummary` row carries them. */
function clip(id: string, kind: string, from: number, to: number, srcIn: number, extra: Partial<Params> = {}): SlipLayer {
  return {
    id,
    kind,
    t_start_us: frame(from),
    t_end_us: frame(to),
    params: {
      kind,
      media_id: MEDIA,
      src_in_us: srcIn,
      src_out_us: srcIn + (frame(to) - frame(from)),
      ...extra,
    },
  };
}
const audio = (id: string, from: number, to: number, srcIn: number, extra: Partial<Params> = {}) =>
  clip(id, "Audio", from, to, srcIn, extra);
const video = (id: string, from: number, to: number, srcIn: number, extra: Partial<Params> = {}) =>
  clip(id, "VideoClip", from, to, srcIn, extra);
const withParams = (l: SlipLayer, extra: Partial<Params>): SlipLayer => ({ ...l, params: { ...l.params, ...extra } });
const srcIn = (l: SlipLayer) => l.params.src_in_us!;
const srcOut = (l: SlipLayer) => l.params.src_out_us!;

/** `l` with `nudgedSource(l, steps)` written back, as the command does. */
const nudged = (l: SlipLayer, steps: number): SlipLayer => withParams(l, nudgedSource(l, steps)!);

describe("audio nudge", () => {
  it("slips the source one sample earlier for one sample later, leaving the edges alone", () => {
    const a = audio("a", 31, 91, sample(50_000));
    const out = nudgedSource(a, NUDGE_SAMPLE)!;
    expect(gridIndex(out.src_in_us, AUDIO_GRID)).toBe(50_000 - 1);
    expect(gridIndex(out.src_out_us, AUDIO_GRID)).toBe(gridIndex(srcOut(a), AUDIO_GRID) - 1);
    // The slip is a source window; nothing in it names an edge.
    expect(Object.keys(out).sort()).toEqual(["src_in_us", "src_out_us"]);
    // One sample is far less than one frame, which is what the nudge is for.
    expect(srcIn(a) - out.src_in_us).toBeLessThan(frame(1) - frame(0));
  });

  it("the coarse tier is exactly 1 ms = 48 samples", () => {
    expect(NUDGE_MS).toBe(48);
    const a = audio("a", 31, 91, sample(1000));
    const out = nudgedSource(a, NUDGE_MS)!;
    expect(gridIndex(out.src_in_us, AUDIO_GRID)).toBe(1000 - 48);
    expect(srcIn(a) - out.src_in_us).toBe(1000);
  });

  it("returns to the exact source window after 10 000 nudges out and back", () => {
    // Index arithmetic, not µs addition: 48 kHz spacing alternates 20/21 µs, so
    // an additive step would drift off the starting sample.
    const start = audio("a", 31, 91, sample(123_457));
    const len = gridIndex(srcOut(start), AUDIO_GRID) - gridIndex(srcIn(start), AUDIO_GRID);
    let a = start;
    for (let i = 0; i < 10_000; i++) a = nudged(a, NUDGE_SAMPLE);
    expect(gridIndex(srcIn(a), AUDIO_GRID)).toBe(123_457 - 10_000);
    expect(gridIndex(srcOut(a), AUDIO_GRID) - gridIndex(srcIn(a), AUDIO_GRID)).toBe(len);
    for (let i = 0; i < 10_000; i++) a = nudged(a, -NUDGE_SAMPLE);
    expect(srcIn(a)).toBe(srcIn(start));
    expect(srcOut(a)).toBe(srcOut(start));
  });

  it("has nothing to slip on a layer without a source window", () => {
    const bare: SlipLayer = { id: "a", kind: "Audio", t_start_us: frame(31), t_end_us: frame(91), params: { kind: "Audio" } };
    expect(nudgedSource(bare, NUDGE_SAMPLE)).toBeNull();
  });

  it("selects only audio layers, so a whole-link selection leaves the video alone", () => {
    const layers = [audio("a", 0, 30, 0), video("v", 3, 30, 0), audio("b", 40, 60, 0)];
    const sel = new Set(["a", "v"]);
    expect(slippableAudioLayers(sel, layers).map((l) => l.id)).toEqual(["a"]);
    expect(slippableAudioLayers(new Set(["v"]), layers)).toEqual([]);
  });
});

describe("derived link sync offset", () => {
  it("reads ZERO for a linked pair sharing its edges and its source, even off the sample lattice", () => {
    // A source in-point trimmed on a 29.97 frame is not a sample time; a pair
    // that reads the same media from it is still in sync.
    const srcIn = frame(240);
    const v = video("v", 31, 91, srcIn);
    const a = audio("a", 31, 91, srcIn);
    expect(syncOffsetSamples(a, [v, a])).toBe(0);
    expect(formatSyncOffset(syncOffsetSamples(a, [v, a]))).toBeNull();
  });

  it("reads exactly N after N nudges, in both directions", () => {
    const v = video("v", 31, 91, sample(96_000));
    let a = audio("a", 31, 91, sample(96_000));
    for (let i = 1; i <= 5; i++) {
      a = nudged(a, NUDGE_SAMPLE);
      expect(syncOffsetSamples(a, [v, a])).toBe(i);
    }
    for (let i = 4; i >= -3; i--) {
      a = nudged(a, -NUDGE_SAMPLE);
      expect(syncOffsetSamples(a, [v, a])).toBe(i);
    }
  });

  it("is kept exactly when the link moves by whole frames", () => {
    const v = video("v", 300, 400, sample(96_000));
    const a = nudged(audio("a", 300, 400, sample(96_000)), 7);
    const span = (l: SlipLayer) => ({ id: l.id, tStartUs: l.t_start_us, tEndUs: l.t_end_us });
    for (const to of [0, 1, 299, 301, 4_000]) {
      const landed = travelOnGrid([span(v), span(a)], { fromUs: v.t_start_us, toUs: frame(to) }, FPS);
      const lv = { ...v, t_start_us: landed.get("v")!.tStartUs, t_end_us: landed.get("v")!.tEndUs };
      const la = { ...a, t_start_us: landed.get("a")!.tStartUs, t_end_us: landed.get("a")!.tEndUs };
      expect(syncOffsetSamples(la, [lv, la]), `to frame ${to}`).toBe(7);
    }
  });

  it("is null with no visual partner: an audio-only link has nothing to measure against", () => {
    const a = audio("a", 0, 30, 0);
    const b = audio("b", 40, 60, 0);
    expect(syncOffsetSamples(a, [a, b])).toBeNull();
    expect(syncOffsetSamples(a, [a])).toBeNull();
  });

  it("is null against a picture of different media: the sound was not recorded with it", () => {
    const a = nudged(audio("a", 31, 91, sample(96_000)), 5);
    const broll = video("v", 31, 91, sample(96_000), { media_id: "broll" });
    expect(syncOffsetSamples(a, [a, broll])).toBeNull();
    expect(resyncedSource(a, [a, broll])).toBeNull();
  });

  it("is null when either member is retimed: source time 0 no longer lands at one instant", () => {
    const v = video("v", 31, 91, sample(96_000));
    const a = nudged(audio("a", 31, 91, sample(96_000)), 5);
    const timeMap = { kind: "speed", rate: 2 };
    expect(syncOffsetSamples(a, [a, withParams(v, { time_map: timeMap })])).toBeNull();
    expect(syncOffsetSamples(withParams(a, { time_map: timeMap }), [a, v])).toBeNull();
    expect(resyncedSource(a, [a, withParams(v, { time_map: timeMap })])).toBeNull();
  });

  it("measures against the same-media visual member CLOSEST in time when a link holds several", () => {
    const a = nudged(audio("a", 31, 91, sample(96_000)), 3);
    const near = video("near", 31, 91, sample(96_000));
    // Later on the timeline, reading the same source: against this one the
    // audio would read most of 19 seconds early.
    const far = video("far", 600, 700, sample(96_000));
    // Nearer still, but another file, so it is not the reference.
    const other = video("other", 31, 91, 0, { media_id: "broll" });
    expect(syncOffsetSamples(a, [a, far, near, other])).toBe(3);
    expect(syncOffsetSamples(a, [a, other, near, far])).toBe(3);
  });

  it("re-sync zeroes the offset under the same edges and window length, and no-ops when already synced", () => {
    const v = video("v", 31, 91, sample(96_000));
    const synced = audio("a", 31, 91, sample(96_000));
    expect(resyncedSource(synced, [v, synced])).toBeNull();

    for (const steps of [7, -7, NUDGE_MS * 3]) {
      const slipped = nudged(synced, steps);
      const back = resyncedSource(slipped, [v, slipped])!;
      const resynced = withParams(slipped, back);
      expect(syncOffsetSamples(resynced, [v, resynced]), `after ${steps}`).toBe(0);
      expect(back.src_out_us - back.src_in_us).toBe(srcOut(slipped) - srcIn(slipped));
      expect(back.src_in_us).toBe(srcIn(v));
    }
  });
});

describe("sync-offset badge text", () => {
  it("shows nothing for zero or absent, samples below 1 ms, milliseconds above", () => {
    expect(formatSyncOffset(null)).toBeNull();
    expect(formatSyncOffset(0)).toBeNull();
    expect(formatSyncOffset(1)).toBe("+1 smp");
    expect(formatSyncOffset(-7)).toBe("−7 smp");
    expect(formatSyncOffset(48)).toBe("+1.00 ms");
    expect(formatSyncOffset(-96)).toBe("−2.00 ms");
    expect(formatSyncOffset(4800)).toBe("+100.0 ms");
  });
});

describe("deriveAudioSyncOffsets", () => {
  // Built inside each test, not at module level: every grid primitive is wasm-backed
  // and `initEval()` runs in the suite's beforeAll.
  const fixtures = () => {
    const v = video("v", 31, 91, sample(96_000));
    const inSync = audio("a", 31, 91, sample(96_000));
    const slipped = { ...nudged(inSync, 5), id: "b" };
    return { v, inSync, slipped };
  };

  it("stores only NON-ZERO offsets, so an in-sync project maps to nothing", () => {
    const { v, inSync } = fixtures();
    const out = deriveAudioSyncOffsets([v, inSync], [{ id: "g", layer_ids: ["v", "a"] }]);
    expect(out).toEqual({});
    expect(selectAudioSyncOffset(out, "a")).toBeNull();
  });

  it("keys the slipped member by id", () => {
    const { v, slipped } = fixtures();
    const out = deriveAudioSyncOffsets([v, slipped], [{ id: "g", layer_ids: ["v", "b"] }]);
    expect(out).toEqual({ b: 5 });
    expect(selectAudioSyncOffset(out, "b")).toBe(5);
    expect(selectAudioSyncOffset(out, "v")).toBeNull();
  });

  it("ignores unlinked layers and a link whose member ids no longer resolve", () => {
    const { v, slipped } = fixtures();
    expect(deriveAudioSyncOffsets([v, slipped], [])).toEqual({});
    expect(deriveAudioSyncOffsets([slipped], [{ id: "g", layer_ids: ["v", "b"] }])).toEqual({});
  });
});
