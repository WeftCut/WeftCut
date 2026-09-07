import { describe, it, expect } from "vitest";
import {
  AUDIO_EFFECTS,
  effectiveChain,
  getAudioEffect,
  isAudioKind,
  staticParams,
  type AudioEffectEntry,
} from "./catalog";
import { DENOISE } from "./denoise";

const MEDIA = { duration_us: 10_000_000 };
const sp = (value: number) => ({ mode: "Static" as const, value });

/** A stored entry. `values` are plain numbers, wrapped as `Static` tracks —
 *  the shape a layer actually holds. */
function fx(
  over: {
    id?: string;
    kind?: string;
    enabled?: boolean;
    values?: Record<string, number>;
  } = {},
): AudioEffectEntry {
  return {
    id: over.id ?? "e1",
    kind: over.kind ?? "audio.denoise",
    enabled: over.enabled ?? true,
    params: Object.fromEntries(
      Object.entries(
        over.values ?? { profile_in_us: 0, profile_out_us: 1_000_000 },
      ).map(([k, v]) => [k, sp(v)]),
    ),
  };
}

describe("isAudioKind", () => {
  it("is the `audio.` prefix and nothing else", () => {
    expect(isAudioKind("audio.denoise")).toBe(true);
    // An UNKNOWN audio kind is still audio — that is what lets the namespace
    // rule refuse it on a visual layer without consulting the catalog.
    expect(isAudioKind("audio.future")).toBe(true);
    expect(isAudioKind("blur")).toBe(false);
    expect(isAudioKind("some.unknown")).toBe(false);
    expect(isAudioKind("audio")).toBe(false);
  });
});

describe("AUDIO_EFFECTS", () => {
  it("registers every descriptor under its own kind", () => {
    for (const [key, descriptor] of Object.entries(AUDIO_EFFECTS)) {
      expect(descriptor.kind).toBe(key);
      expect(isAudioKind(descriptor.kind)).toBe(true);
      expect(descriptor.category).toBe("audio");
    }
  });
  it("resolves a known kind and answers null for anything else", () => {
    expect(getAudioEffect("audio.denoise")).toBe(DENOISE);
    expect(getAudioEffect("audio.future")).toBeNull();
    expect(getAudioEffect("blur")).toBeNull();
  });
  it("names every region key in its own params record", () => {
    for (const descriptor of Object.values(AUDIO_EFFECTS)) {
      if (!descriptor.region) continue;
      expect(descriptor.params[descriptor.region.inKey]).toBeDefined();
      expect(descriptor.params[descriptor.region.outKey]).toBeDefined();
    }
  });
});

describe("staticParams", () => {
  it("fills a catalog default for every unwritten non-region param", () => {
    const params = staticParams(fx(), DENOISE);
    expect(params.strength).toBe(DENOISE.params.strength.default);
    expect(params.margin).toBe(DENOISE.params.margin.default);
  });
  it("leaves an unwritten region bound ABSENT — a default would invent a region", () => {
    const params = staticParams(fx({ values: { strength: 20 } }), DENOISE);
    expect(params.profile_in_us).toBeUndefined();
    expect(params.profile_out_us).toBeUndefined();
    expect(params.strength).toBe(20);
  });
  it("skips a Keyframed track rather than sampling it", () => {
    const effect = fx();
    effect.params.strength = {
      mode: "Keyframed",
      extrapolate: { before: "Hold", after: "Hold" },
      value: [],
    };
    expect(staticParams(effect, DENOISE).strength).toBe(
      DENOISE.params.strength.default,
    );
  });
});

describe("audio.denoise isComplete", () => {
  const complete = { profile_in_us: 200_000, profile_out_us: 1_800_000 };
  const check = (values: Record<string, number>) =>
    DENOISE.isComplete(staticParams(fx({ values }), DENOISE), MEDIA);

  it("accepts a region at least 0.25 s long inside the media", () => {
    expect(check(complete)).toBe(true);
    expect(check({ profile_in_us: 0, profile_out_us: 250_000 })).toBe(true);
  });
  it("refuses a missing bound, a short span, a negative start, and a span past the end", () => {
    expect(check({ profile_in_us: 200_000 })).toBe(false);
    expect(check({ profile_out_us: 200_000 })).toBe(false);
    expect(check({})).toBe(false);
    expect(check({ profile_in_us: 0, profile_out_us: 249_999 })).toBe(false);
    expect(check({ profile_in_us: -1, profile_out_us: 1_000_000 })).toBe(false);
    expect(check({ profile_in_us: 1_800_000, profile_out_us: 200_000 })).toBe(false);
    expect(check({ profile_in_us: 0, profile_out_us: 10_000_001 })).toBe(false);
  });
  it("refuses an unprobed media duration — an unbounded region is unverifiable", () => {
    expect(
      DENOISE.isComplete(staticParams(fx({ values: complete }), DENOISE), {
        duration_us: null,
      }),
    ).toBe(false);
  });
  it("asks for the region's RMS, and for nothing without a region", () => {
    expect(DENOISE.measurements(staticParams(fx({ values: complete }), DENOISE))).toEqual([
      { kind: "rms", inUs: 200_000, outUs: 1_800_000 },
    ]);
    expect(DENOISE.measurements(staticParams(fx({ values: {} }), DENOISE))).toEqual([]);
  });
});

describe("effectiveChain", () => {
  const region = { profile_in_us: 200_000, profile_out_us: 1_800_000 };

  it("keeps enabled, catalogued, complete audio effects in stored order", () => {
    const a = fx({ id: "a", values: region });
    const b = fx({ id: "b", values: { ...region, strength: 30 } });
    expect(effectiveChain({ effects: [a, b] }, MEDIA).map((e) => e.effect.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops disabled, incomplete, non-audio and uncatalogued entries", () => {
    const keep = fx({ id: "keep", values: region });
    const effects = [
      fx({ id: "off", values: region, enabled: false }),
      fx({ id: "incomplete", values: {} }),
      { id: "visual", kind: "blur", enabled: true, params: {} },
      fx({ id: "unknown", kind: "audio.future", values: region }),
      keep,
    ];
    expect(effectiveChain({ effects }, MEDIA).map((e) => e.effect.id)).toEqual(["keep"]);
  });

  it("pairs each entry with its descriptor and flattened params", () => {
    const [entry] = effectiveChain({ effects: [fx({ values: region })] }, MEDIA);
    expect(entry.descriptor).toBe(DENOISE);
    expect(entry.params.strength).toBe(DENOISE.params.strength.default);
    expect(entry.params.profile_in_us).toBe(region.profile_in_us);
  });
});
