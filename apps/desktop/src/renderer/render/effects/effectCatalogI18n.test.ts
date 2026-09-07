// @vitest-environment jsdom
// The catalog's localisation guard.
//
// Every catalog string the UI asks for is looked up with a `defaultValue`
// fallback — `EffectPicker` for the label, description and group heading,
// `EffectsSection` for the card title, `EffectParamField` for each param label —
// so a key missing from zh-CN degrades SILENTLY at runtime: an English word in a
// Chinese panel, or the raw param key as a label. There is no linter here, so
// this file is the only thing that turns a half-localised entry red.
//
// Keys are derived from the descriptors rather than listed, so a new catalog
// entry is covered the moment it lands.
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en-US";
import zh from "../../i18n/locales/zh-CN";
import { AUDIO_EFFECTS } from "../../../shared/audioEffects/catalog";
import { effectI18nBase, listEffects, type EffectDescriptor } from "./effectRegistry";

const LOCALES = { "en-US": en, "zh-CN": zh };

/// Dotted lookup into a locale module, the way `t()` resolves a nested key.
/// Reading the modules the app reads — rather than re-parsing them as text —
/// is what makes a key that exists but holds an empty string a failure too.
const at = (loc: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<any>((acc, k) => acc?.[k], loc);

/// Every key the UI asks for on behalf of one catalog entry.
function catalogKeys(d: EffectDescriptor): string[] {
  return [
    `effects.${d.kind}.name`,
    `effects.${d.kind}.desc`,
    `effects.category.${d.category}`,
    ...Object.keys(d.params).map((p) => `effects.${d.kind}.params.${p}`),
  ];
}

/// The predicate under test. Empty / whitespace-only counts as missing — it
/// renders as a blank label, which is worse than the English fallback.
function missingKeys(loc: unknown, keys: readonly string[]): string[] {
  return keys.filter((k) => {
    const v = at(loc, k);
    return typeof v !== "string" || v.trim() === "";
  });
}

describe("effect catalog localisation", () => {
  const CATALOG = listEffects();

  // A green run over an empty catalog would prove nothing.
  it("has entries to check", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it("resolves every entry's name, description, category and param labels in both locales", () => {
    for (const [locale, loc] of Object.entries(LOCALES)) {
      for (const d of CATALOG) {
        expect(missingKeys(loc, catalogKeys(d)), `${locale} / ${d.kind}`).toEqual([]);
      }
    }
  });

  // Every key above is derived from the KIND, while the UI derives them from
  // `nameI18nKey` (`effectI18nBase`). A visual descriptor that points its name
  // key elsewhere therefore puts its whole namespace outside this guard's
  // reach — which is allowed for an audio kind, and checked separately below.
  it("derives every entry's nameI18nKey from its kind", () => {
    for (const d of CATALOG) expect(d.nameI18nKey, d.kind).toBe(`effects.${d.kind}.name`);
  });

  // The red direction. Asserted against holed copies of the real locales,
  // because the green case above runs against locales that are already
  // complete — on its own it would still pass if `missingKeys` never reported
  // anything. Each case narrows `missingKeys` to the one key it holes, so an
  // unrelated real hole cannot make these misreport (that is the case above's
  // job) and each asserts the key resolves before the hole is made.
  describe("catches a hole in either locale", () => {
    const entry = CATALOG[0]!;
    const param = Object.keys(entry.params)[0]!;
    const holed = (loc: unknown): any => structuredClone(loc);
    const bothWays = (loc: unknown, key: string, hole: (h: any) => void) => {
      expect(missingKeys(loc, [key]), `${key} resolves today`).toEqual([]);
      const h = holed(loc);
      hole(h);
      expect(missingKeys(h, [key])).toEqual([key]);
    };

    for (const [locale, loc] of Object.entries(LOCALES)) {
      it(`a deleted param label in ${locale}`, () => {
        bothWays(loc, `effects.${entry.kind}.params.${param}`,
          (h) => { delete h.effects[entry.kind].params[param]; });
      });
      it(`a blanked description in ${locale}`, () => {
        bothWays(loc, `effects.${entry.kind}.desc`,
          (h) => { h.effects[entry.kind].desc = "   "; });
      });
      it(`a deleted name in ${locale}`, () => {
        bothWays(loc, `effects.${entry.kind}.name`,
          (h) => { delete h.effects[entry.kind].name; });
      });
    }
  });
});

// The audio catalog is the same guard over the other lifecycle's entries. It
// needs its own derivation for one reason: an `audio.*` kind carries a dot, so
// its strings live under `effects.audio_denoise.*` rather than under a
// three-level `effects.audio.denoise.*` — which is exactly what `effectI18nBase`
// exists to resolve, and what the shared `effects.audio.*` block below would
// otherwise collide with.
describe("audio effect catalog localisation", () => {
  const CATALOG = Object.values(AUDIO_EFFECTS);

  /// The card's own copy plus the region row's, which is shared by every audio
  /// effect that carries a region rather than repeated per kind.
  const SHARED_KEYS = [
    "effects.audio.select_region",
    "effects.audio.select_region_too_short",
    "effects.audio.source_in",
    "effects.audio.source_out",
    "effects.audio.region_needed",
    "effects.audio.region_too_short",
    "effects.audio.region_offscreen",
    "effects.audio.status.pending",
    "effects.audio.status.failed",
  ];

  it("has entries to check", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it("resolves every entry's name, description, category and param labels in both locales", () => {
    for (const [locale, loc] of Object.entries(LOCALES)) {
      for (const d of CATALOG) {
        const base = effectI18nBase(d);
        const keys = [
          `${base}.name`,
          `${base}.desc`,
          `effects.category.${d.category}`,
          ...Object.keys(d.params).map((k) => `${base}.params.${k}`),
        ];
        expect(missingKeys(loc, keys), `${locale} / ${d.kind}`).toEqual([]);
      }
    }
  });

  it("resolves the region row's shared copy in both locales", () => {
    for (const [locale, loc] of Object.entries(LOCALES)) {
      expect(missingKeys(loc, SHARED_KEYS), locale).toEqual([]);
    }
  });

  // The card and the picker read `descI18nKey` and `nameI18nKey`; the param
  // labels are derived from the latter. A descriptor whose two keys sit under
  // different namespaces would put half its copy outside this guard's reach.
  it("keeps each entry's name and description under one namespace", () => {
    for (const d of CATALOG) {
      const base = effectI18nBase(d);
      expect(d.nameI18nKey, d.kind).toBe(`${base}.name`);
      expect(d.descI18nKey, d.kind).toBe(`${base}.desc`);
    }
  });

  // The state the whole feature exists to avoid: `effects.unsupported_audio`
  // told the user Audio layers have no effects. Both locales must be rid of it.
  it("no longer claims Audio layers have no effects", () => {
    for (const [locale, loc] of Object.entries(LOCALES)) {
      expect(at(loc, "effects.unsupported_audio"), locale).toBeUndefined();
    }
  });
});
