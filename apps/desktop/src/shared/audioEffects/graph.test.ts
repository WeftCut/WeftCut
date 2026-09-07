import { describe, it, expect } from "vitest";
import {
  AUDIO_FX_OUT_LABEL,
  buildFilterComplex,
  chainMeasurements,
  measurementKey,
  readMeasurement,
  samplesFromUs,
  secsFromSamples,
  type BakeCtx,
} from "./graph";
import { CONFORM_SAMPLE_RATE } from "./conform";
import { staticParams, type AudioEffectEntry, type ChainEntry } from "./catalog";
import { DENOISE } from "./denoise";

const sp = (value: number) => ({ mode: "Static" as const, value });

/** A chain entry built DIRECTLY, without `effectiveChain`: these cases use
 *  regions far shorter than the 0.25 s a real sample region needs, so the
 *  completeness gate would (correctly) drop them. What is under test here is
 *  the graph text, not the gate. */
function entry(params: Record<string, number>): ChainEntry {
  const effect: AudioEffectEntry = {
    id: "e1",
    kind: "audio.denoise",
    enabled: true,
    params: Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, sp(v)]),
    ),
  };
  return { effect, descriptor: DENOISE, params: staticParams(effect, DENOISE) };
}

/** A ctx that answers every measurement the chain declares with `rmsDbfs`. */
function ctxFor(chain: ChainEntry[], rmsDbfs: number | null): BakeCtx {
  const measurements: Record<string, number | null> = {};
  for (const req of chainMeasurements(chain)) {
    measurements[measurementKey(req)] = rmsDbfs;
  }
  return { measurements };
}

describe("samplesFromUs", () => {
  it("rounds a source-time bound onto the conform lattice", () => {
    expect(samplesFromUs(0, CONFORM_SAMPLE_RATE)).toBe(0);
    expect(samplesFromUs(20_000, CONFORM_SAMPLE_RATE)).toBe(960);
    expect(samplesFromUs(60_000, CONFORM_SAMPLE_RATE)).toBe(2880);
    // One sample is 20.8333 µs, so most authored µs values land between two.
    expect(samplesFromUs(20_007, CONFORM_SAMPLE_RATE)).toBe(960);
    expect(samplesFromUs(60_011, CONFORM_SAMPLE_RATE)).toBe(2881);
  });
});

describe("secsFromSamples", () => {
  it("prints a sample count as a fixed 6-decimal second literal", () => {
    expect(secsFromSamples(0, CONFORM_SAMPLE_RATE)).toBe("0.000000");
    expect(secsFromSamples(1920, CONFORM_SAMPLE_RATE)).toBe("0.040000");
    expect(secsFromSamples(1921, CONFORM_SAMPLE_RATE)).toBe("0.040021");
    // No exponent form for a sub-millisecond value, which is the whole reason
    // the formatter exists rather than `String(n / rate)`.
    expect(secsFromSamples(1, CONFORM_SAMPLE_RATE)).toBe("0.000021");
  });
});

describe("measurementKey / readMeasurement", () => {
  it("keys an rms request by kind and bounds", () => {
    expect(measurementKey({ kind: "rms", inUs: 20_000, outUs: 60_000 })).toBe(
      "rms:20000:60000",
    );
  });
  it("passes a null result through — digital silence is an answer", () => {
    const req = { kind: "rms", inUs: 0, outUs: 1 } as const;
    expect(readMeasurement({ measurements: { [measurementKey(req)]: null } }, req)).toBeNull();
  });
  it("throws on a measurement that was never taken", () => {
    expect(() =>
      readMeasurement({ measurements: {} }, { kind: "rms", inUs: 0, outUs: 1 }),
    ).toThrow(/was not taken/);
  });
});

describe("chainMeasurements", () => {
  it("deduplicates identical requests across the chain", () => {
    const a = entry({ profile_in_us: 0, profile_out_us: 40_000 });
    const b = entry({ profile_in_us: 0, profile_out_us: 40_000 });
    const c = entry({ profile_in_us: 40_000, profile_out_us: 60_000 });
    expect(chainMeasurements([a, b, c])).toEqual([
      { kind: "rms", inUs: 0, outUs: 40_000 },
      { kind: "rms", inUs: 40_000, outUs: 60_000 },
    ]);
  });
});

describe("buildFilterComplex", () => {
  it("is null for an empty chain — no graph, the layer plays the raw conform", () => {
    expect(buildFilterComplex([], { measurements: {} })).toBeNull();
  });

  // The whole stage template, pinned. The real-ffmpeg smoke lives main-side
  // (src/main/audioFx/graph.ffmpeg.test.ts) because it needs Node; this is the
  // exact text that gets run there.
  it("emits the denoise stage: sample-counted trims, seconds only for asendcmd", () => {
    const chain = [entry({ profile_in_us: 20_000, profile_out_us: 60_000, strength: 12, margin: 8 })];
    expect(buildFilterComplex(chain, ctxFor(chain, -34))).toBe(
      "[0:a]asplit[fx0a][fx0b];" +
        "[fx0a]atrim=start_sample=960:end_sample=2880,asetpts=PTS-STARTPTS[fx0n];" +
        "[fx0n][fx0b]concat=n=2:v=0:a=1," +
        "asendcmd=c='0 afftdn@fx0 sn start; 0.040000 afftdn@fx0 sn stop'," +
        "afftdn@fx0=nr=12.000:nf=-26," +
        "atrim=start_sample=1920,asetpts=PTS-STARTPTS[out]",
    );
  });

  // The regression: with second-valued trims, bounds off the lattice made the
  // pre-roll and the trim that removes it disagree by one sample. Sample counts
  // make `LEN_N = OUT_N - IN_N` and the trailing `start_sample` the same number
  // by construction, whatever the µs were.
  it("keeps the pre-roll and its trim equal for bounds off the lattice", () => {
    const chain = [entry({ profile_in_us: 20_007, profile_out_us: 60_011, strength: 12, margin: 8 })];
    const g = buildFilterComplex(chain, ctxFor(chain, -34)) ?? "";
    expect(g).toContain("atrim=start_sample=960:end_sample=2881");
    expect(g).toContain("atrim=start_sample=1921,");
    expect(g).toContain("0.040021 afftdn@fx0 sn stop");
  });

  it("chains [0:a] → [s1] → … → [out] with a unique tag per stage", () => {
    const chain = [
      entry({ profile_in_us: 20_000, profile_out_us: 60_000 }),
      entry({ profile_in_us: 0, profile_out_us: 30_000 }),
    ];
    const g = buildFilterComplex(chain, ctxFor(chain, -34)) ?? "";
    expect(g.startsWith("[0:a]")).toBe(true);
    expect(g.endsWith(`[${AUDIO_FX_OUT_LABEL}]`)).toBe(true);
    expect(g).toContain("[s1]");
    expect(g).toContain("afftdn@fx0");
    expect(g).toContain("afftdn@fx1");
    expect(g).not.toContain("afftdn@fx2");
  });

  it("derives nf from the measured floor plus the margin, clamped to afftdn's range", () => {
    const chain = [entry({ profile_in_us: 0, profile_out_us: 40_000, margin: 8, strength: 12 })];
    expect(buildFilterComplex(chain, ctxFor(chain, -34))).toContain("nr=12.000:nf=-26");
    // Above the range: a −5 dBFS floor is a real recording, so the nearest
    // representable floor is what gets baked.
    expect(buildFilterComplex(chain, ctxFor(chain, -5))).toContain("nf=-20");
    // Digital silence has no dBFS — leave the quietest floor.
    expect(buildFilterComplex(chain, ctxFor(chain, null))).toContain("nf=-80");
    expect(buildFilterComplex(chain, ctxFor(chain, -200))).toContain("nf=-80");
  });
});
