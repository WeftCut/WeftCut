import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalizePropsLenient,
  resolveMotifContentDurationUs,
  getMotif,
  motifUnavailable,
  setProjectMotifs,
  subscribeMotifCatalog,
  motifCatalogRevision,
  type MotifManifest,
} from "./catalog";
import { canonicalizeProps } from "./Rasterizer";

afterEach(() => setProjectMotifs([]));

const base: MotifManifest = {
  id: "countdown",
  name: "Countdown",
  version: 1,
  size: [480, 480],
  default_duration_s: 5,
  max_duration_s: 5,
  max_duration_prop: "seconds",
  props_schema: { seconds: { type: "number", default: 5, min: 1, max: 60 } },
};

describe("resolveMotifContentDurationUs", () => {
  it("prefers content_duration_s over a max_duration cap", () => {
    const m: any = {
      content_duration_s: 0.8,
      max_duration_s: 5,
      max_duration_prop: "seconds",
      props_schema: {},
    };
    expect(resolveMotifContentDurationUs(m, { seconds: 5 })).toBe(800_000);
  });
  it("uses the live prop value when present", () => {
    expect(resolveMotifContentDurationUs(base, { seconds: 6 })).toBe(6_000_000);
  });
  it("falls back to max_duration_s when the prop is missing/invalid/non-number", () => {
    expect(resolveMotifContentDurationUs(base, {})).toBe(5_000_000);
    expect(resolveMotifContentDurationUs(base, { seconds: -3 })).toBe(5_000_000);
    expect(resolveMotifContentDurationUs(base, { seconds: "x" })).toBe(5_000_000);
    expect(resolveMotifContentDurationUs(base, { seconds: "6" })).toBe(5_000_000); // string not coerced (Rust parity)
    expect(resolveMotifContentDurationUs(base, { seconds: true })).toBe(5_000_000); // bool not coerced
  });
  it("returns null when fully unbounded", () => {
    const unbounded: MotifManifest = {
      id: base.id,
      name: base.name,
      version: base.version,
      size: base.size,
      default_duration_s: base.default_duration_s,
      props_schema: base.props_schema,
    };
    expect(resolveMotifContentDurationUs(unbounded, {})).toBeNull();
  });
});

const userManifest = {
  id: "user-demo",
  name: "User Demo",
  version: 1,
  size: [800, 200] as [number, number],
  default_duration_s: 3,
  props_schema: {},
};

describe("the project's Motifs only", () => {
  it("resolves the Motifs the project holds and nothing else, built-ins included", () => {
    // A built-in renders from the project's copy, never from the bundle.
    expect(getMotif("countdown")).toBeNull();
    setProjectMotifs([userManifest, { ...base, size: [99, 99] }]);
    expect(getMotif("user-demo")?.manifest.size).toEqual([800, 200]);
    expect(getMotif("countdown")?.manifest.size).toEqual([99, 99]);
    setProjectMotifs([]);
    expect(getMotif("user-demo")).toBeNull();
    expect(getMotif("countdown")).toBeNull();
  });

  it("tells a Motif the project records but cannot render from one it has not heard of", () => {
    setProjectMotifs([userManifest], [{ motif_id: "gone", status: "missing", diagnostic: "Motifs/gone/ is missing" }]);
    expect(getMotif("gone")).toBeNull();
    expect(motifUnavailable("gone")).toEqual({ motif_id: "gone", status: "missing", diagnostic: "Motifs/gone/ is missing" });
    expect(motifUnavailable("user-demo")).toBeNull();
    expect(motifUnavailable("never-synced")).toBeNull();
  });
});

it("canonicalizePropsLenient drops unknown, fills defaults, falls back on invalid", () => {
  const manifest = {
    id: "u", name: "U", version: 1, size: [10, 10] as [number, number], default_duration_s: 1,
    props_schema: {
      title: { type: "string", default: "Hi" },
      n: { type: "number", default: 5, min: 1, max: 10 },
    },
  };
  const out = canonicalizePropsLenient({ title: "Yo", n: 999, bogus: 1 }, manifest as never);
  expect(out.title).toBe("Yo");
  expect(out.n).toBe(5);
  expect("bogus" in out).toBe(false);
  const out2 = canonicalizePropsLenient({}, manifest as never);
  expect(out2.title).toBe("Hi");
  expect(out2.n).toBe(5);
});

it("lenient output for valid props matches strict output (cacheKey stability)", () => {
  const manifest = {
    id: "u", name: "U", version: 1, size: [10, 10] as [number, number], default_duration_s: 1,
    props_schema: {
      n: { type: "number", default: 5, min: 1, max: 10 },
      title: { type: "string", default: "Hi" },
    },
  };
  const props = { n: 3, title: "OK" };
  const strict = canonicalizeProps(props, manifest as never);
  const lenient = canonicalizePropsLenient(props, manifest as never);
  expect(JSON.stringify(lenient)).toBe(JSON.stringify(strict));
});

it("setProjectMotifs bumps the revision and notifies subscribers", () => {
  const before = motifCatalogRevision();
  let calls = 0;
  const un = subscribeMotifCatalog(() => { calls += 1; });
  setProjectMotifs([]);
  expect(motifCatalogRevision()).toBeGreaterThan(before);
  expect(calls).toBe(1);
  un();
  setProjectMotifs([]);
  expect(calls).toBe(1); // unsubscribed → no further calls
});

describe("has_params_ui", () => {
  it("reaches getMotif for a user Motif and clears when the file goes away", () => {
    const user: MotifManifest = {
      id: "u-params", name: "U", version: 1, size: [10, 10], default_duration_s: 1,
      props_schema: {}, has_params_ui: true,
    };
    setProjectMotifs([user]);
    expect(getMotif("u-params")!.hasParamsUi).toBe(true);
    // The watcher re-pulls the whole catalog; a vanished params.html comes back
    // as an absent flag.
    setProjectMotifs([{ ...user, has_params_ui: false }]);
    expect(getMotif("u-params")!.hasParamsUi).toBe(false);
  });

  it("defaults to false for a payload that omits the field", () => {
    setProjectMotifs([{ id: "plain", name: "P", version: 1, size: [10, 10], default_duration_s: 1, props_schema: {} }]);
    expect(getMotif("plain")!.hasParamsUi).toBe(false);
  });
});
