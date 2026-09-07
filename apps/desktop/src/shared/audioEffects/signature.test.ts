import { describe, it, expect } from "vitest";
import { canonicalChain } from "./signature";
import { CONFORM_FORMAT_VERSION } from "./conform";
import {
  effectiveChain,
  staticParams,
  type AudioEffectEntry,
  type ChainEntry,
  type EffectiveChain,
} from "./catalog";
import { DENOISE } from "./denoise";

const MEDIA = { duration_us: 10_000_000 };
const HASH = "abc123";
const sp = (value: number) => ({ mode: "Static" as const, value });

/** A stored denoise entry. `values` is given as plain numbers — insertion
 *  order is preserved, which is what the key-sorting test needs. */
function fx(
  id: string,
  values: Record<string, number>,
  enabled = true,
): AudioEffectEntry {
  return {
    id,
    kind: "audio.denoise",
    enabled,
    params: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, sp(v)]),
    ),
  };
}

/** A complete region, spelled once. */
const REGION = { profile_in_us: 200_000, profile_out_us: 1_800_000 };

function chainOf(...effects: AudioEffectEntry[]): EffectiveChain {
  return effectiveChain({ effects }, MEDIA);
}
function canonicalOf(...effects: AudioEffectEntry[]): string | null {
  return canonicalChain(HASH, CONFORM_FORMAT_VERSION, chainOf(...effects));
}

describe("canonicalChain", () => {
  it("names media, conform format and each effect's kind@version with its params", () => {
    expect(canonicalOf(fx("e1", { ...REGION, strength: 12, margin: 8 }))).toBe(
      "v1|abc123|1|audio.denoise@1{margin=8.000000,profile_in_us=200000.000000,profile_out_us=1800000.000000,strength=12.000000}",
    );
  });

  it("preserves chain order — the render order is part of the identity", () => {
    const a = fx("e1", { ...REGION, strength: 12 });
    const b = fx("e2", { ...REGION, strength: 30 });
    const forward = canonicalOf(a, b);
    const reversed = canonicalOf(b, a);
    expect(forward).not.toBe(reversed);
    expect(forward?.indexOf("strength=12")).toBeLessThan(
      forward?.indexOf("strength=30") ?? -1,
    );
  });

  it("drops disabled effects", () => {
    const on = fx("e1", { ...REGION, strength: 12 });
    const off = fx("e2", { ...REGION, strength: 30 }, false);
    expect(canonicalOf(on, off)).toBe(canonicalOf(on));
  });

  it("drops incomplete effects — no region, too short, past the media end", () => {
    const ok = fx("e1", { ...REGION, strength: 12 });
    const noRegion = fx("e2", { strength: 30 });
    const tooShort = fx("e3", { profile_in_us: 0, profile_out_us: 100_000 });
    const pastEnd = fx("e4", { profile_in_us: 0, profile_out_us: 99_000_000 });
    const negative = fx("e5", { profile_in_us: -1, profile_out_us: 1_000_000 });
    expect(canonicalOf(ok, noRegion, tooShort, pastEnd, negative)).toBe(
      canonicalOf(ok),
    );
  });

  it("excludes the effect id, so two layers configured alike share one bake", () => {
    const a = canonicalOf(fx("e1", { ...REGION, strength: 12 }));
    const b = canonicalOf(fx("e2-different-id", { ...REGION, strength: 12 }));
    expect(a).toBe(b);
    expect(a).not.toContain("e1");
  });

  it("sorts params by key, so the write order never changes the artifact", () => {
    const written = canonicalOf(
      fx("e1", { strength: 12, margin: 8, ...REGION }),
    );
    const other = canonicalOf(
      fx("e1", {
        profile_out_us: REGION.profile_out_us,
        margin: 8,
        profile_in_us: REGION.profile_in_us,
        strength: 12,
      }),
    );
    expect(written).toBe(other);
  });

  it("reflects the stored value — a quantized edit is a different chain", () => {
    const a = canonicalOf(fx("e1", { ...REGION, strength: 12 }));
    const b = canonicalOf(fx("e1", { ...REGION, strength: 12.001 }));
    expect(a).not.toBe(b);
    expect(b).toContain("strength=12.001000");
  });

  it("prints the catalog default for a param the layer never wrote", () => {
    const canonical = canonicalOf(fx("e1", REGION));
    expect(canonical).toBe(
      "v1|abc123|1|audio.denoise@1{margin=8.000000,profile_in_us=200000.000000,profile_out_us=1800000.000000,strength=12.000000}",
    );
  });

  // The bake reads the RESOLVED params, so an unset param and one stored at its
  // default render the same audio — two signatures would mean two runs of
  // ffmpeg and two byte-identical files under the disk LRU.
  it("names one artifact whether the default was written or left unset", () => {
    const unset = canonicalOf(fx("e1", REGION));
    expect(canonicalOf(fx("e1", { ...REGION, strength: 12 }))).toBe(unset);
    expect(canonicalOf(fx("e1", { ...REGION, strength: 13 }))).not.toBe(unset);
  });

  // A key the descriptor does not declare reaches no filter, so it cannot name
  // a different bake — a hand-edited project must not fork the cache.
  it("ignores a stored param the descriptor does not declare", () => {
    expect(canonicalOf(fx("e1", { ...REGION, nonsense: 3 }))).toBe(
      canonicalOf(fx("e1", REGION)),
    );
  });

  it("is null for an empty effective chain", () => {
    expect(canonicalOf()).toBeNull();
    expect(canonicalOf(fx("e1", { ...REGION }, false))).toBeNull();
  });

  it("changes with the media hash and with the conform format version", () => {
    const chain = chainOf(fx("e1", { ...REGION, strength: 12 }));
    const base = canonicalChain(HASH, CONFORM_FORMAT_VERSION, chain);
    expect(canonicalChain("other", CONFORM_FORMAT_VERSION, chain)).not.toBe(
      base,
    );
    expect(canonicalChain(HASH, CONFORM_FORMAT_VERSION + 1, chain)).not.toBe(
      base,
    );
  });

  // A version bump is the catalog's invalidation lever: same params, different
  // graph, so every artifact baked from the old entry has to be re-rendered.
  it("changes when the descriptor version bumps", () => {
    const effect = fx("e1", { ...REGION, strength: 12 });
    const v1: ChainEntry = {
      effect,
      descriptor: DENOISE,
      params: staticParams(effect, DENOISE),
    };
    const v2: ChainEntry = { ...v1, descriptor: { ...DENOISE, version: 2 } };
    const a = canonicalChain(HASH, CONFORM_FORMAT_VERSION, [v1]);
    const b = canonicalChain(HASH, CONFORM_FORMAT_VERSION, [v2]);
    expect(a).toContain("audio.denoise@1{");
    expect(b).toContain("audio.denoise@2{");
    expect(a).not.toBe(b);
  });
});
