import { describe, it, expect } from "vitest";
import {
  parseManifestIsland,
  stripManifestIsland,
  composeMotifHtml,
  idFromName,
  assignUniqueId,
  BUILTIN_IDS,
  builtinLineage,
  isBuiltinLineage,
  validateManifest,
  validateDefaultFor,
  motifCtxDurationS,
  type Manifest,
} from "./catalog";

function base(): Manifest {
  return {
    id: "x", name: "X", version: 1, size: [640, 480],
    default_duration_s: 5, props_schema: {},
  };
}

describe("parseManifestIsland", () => {
  it("parses a well-formed island", () => {
    const html = `<head><script type="application/json" id="motif-manifest">{"id":"demo","name":"Demo","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script></head><body></body>`;
    const m = parseManifestIsland(html);
    expect(m.id).toBe("demo");
    expect(m.name).toBe("Demo");
  });
  it("throws when no island present", () => {
    expect(() => parseManifestIsland("<html><body>no island</body></html>")).toThrow();
  });
  it("throws on invalid island JSON", () => {
    const html = `<script type="application/json" id="motif-manifest">{not json}</script>`;
    expect(() => parseManifestIsland(html)).toThrow();
  });
});

describe("stripManifestIsland", () => {
  it("removes the island and preserves surrounding HTML", () => {
    const html = `<head><script type="application/json" id="motif-manifest">{"x":1}</script></head><body>keep</body>`;
    const stripped = stripManifestIsland(html);
    expect(stripped).not.toContain(`id="motif-manifest"`);
    expect(stripped).toContain("keep");
    expect(stripped).toContain("<head>");
    expect(stripped).toContain("</head>");
  });
  it("no-ops when no island present", () => {
    const html = `<head></head><body>hi</body>`;
    expect(stripManifestIsland(html)).toBe(html);
  });
});

describe("composeMotifHtml", () => {
  it("injects an island that parses back (round-trip)", () => {
    const m = { ...base(), id: "demo", name: "Demo" };
    const html = `<!doctype html><html><head></head><body><script>motif.define({setup(){}})</script></body></html>`;
    const composed = composeMotifHtml(m, html);
    const parsed = parseManifestIsland(composed);
    expect(parsed.id).toBe("demo");
    expect(parsed.name).toBe("Demo");
    expect(composed).toContain("motif.define");
  });
  it("survives a </script> inside a string field", () => {
    const m = { ...base(), id: "evil", name: "Evil</script><script>x" };
    const composed = composeMotifHtml(m, `<head></head><body><script>motif.define({setup(){}})</script></body>`);
    const parsed = parseManifestIsland(composed);
    expect(parsed.name).toBe("Evil</script><script>x");
    expect(parsed.id).toBe("evil");
  });
  it("prepends island when no <head>", () => {
    const m = { ...base(), id: "nohead" };
    const composed = composeMotifHtml(m, `<body><script>motif.define({setup(){}})</script></body>`);
    expect(parseManifestIsland(composed).id).toBe("nohead");
    expect(composed.trimStart().startsWith("<script")).toBe(true);
  });
  it("replaces a pre-existing island (exactly one remains)", () => {
    const m = { ...base(), id: "new-id" };
    const seed = `<head><script type="application/json" id="motif-manifest">{"id":"old-id","name":"Old","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script></head><body><script>motif.define({setup(){}})</script></body>`;
    const composed = composeMotifHtml(m, seed);
    expect(parseManifestIsland(composed).id).toBe("new-id");
    expect((composed.match(/id="motif-manifest"/g) ?? []).length).toBe(1);
  });
});

const LINEAGE_A = "3f9a2c1d-0b4e-4c5a-9d7e-2a6b8c0d1e2f";
const LINEAGE_B = "8e7d6c5b-4a39-4281-b706-f5e4d3c2b1a0";

describe("idFromName", () => {
  it("slugifies display names, whatever the lineage", () => {
    expect(idFromName("My Cool Motif!", LINEAGE_A)).toBe("my-cool-motif");
    expect(idFromName("  Trailing--dashes  ", LINEAGE_A)).toBe("trailing-dashes");
    expect(idFromName("Lower/Third", LINEAGE_B)).toBe("lower-third");
  });

  it("gives a name with no ASCII letter or digit an ASCII id of its own lineage", () => {
    const a = idFromName("标题卡", LINEAGE_A);
    const b = idFromName("歌词条", LINEAGE_B);
    // A `motif://` host, and one path segment the proposal suffix cannot mimic.
    for (const id of [a, b, idFromName("___", LINEAGE_A)]) {
      expect(id).toMatch(/^motif-[0-9a-f]+$/);
      expect(id).not.toContain("--");
    }
    expect(a).not.toBe(b);
    expect(idFromName("另一个名字", LINEAGE_A)).toBe(a);
  });

  it("never gives an id Windows reserves for a device, which no folder may take", () => {
    for (const name of ["Con", "nul", "COM1", "Lpt9"])
      expect(idFromName(name, LINEAGE_A)).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/);
    expect(idFromName("Console", LINEAGE_A)).toBe("console");
  });
});

describe("assignUniqueId", () => {
  it("avoids collisions, built-ins, and the reserved drafts dir", () => {
    expect(assignUniqueId("My Motif", LINEAGE_A, ["my-motif", "my-motif-2"])).toBe("my-motif-3");
    expect(assignUniqueId("countdown", LINEAGE_A, [])).toBe("countdown-2");
    expect(assignUniqueId("Drafts", LINEAGE_A, [])).toBe("drafts-2");
    expect(assignUniqueId("Fresh", LINEAGE_A, ["my-motif", "my-motif-2"])).toBe("fresh");
  });

  it("puts the suffix after the name's id", () => {
    expect(assignUniqueId("My Motif", LINEAGE_A, [], "-draft")).toBe("my-motif-draft");
    expect(assignUniqueId("My Motif", LINEAGE_A, ["my-motif-draft"], "-draft")).toBe("my-motif-draft-2");
    expect(assignUniqueId("标题卡", LINEAGE_A, [], "-draft")).toBe(`${idFromName("标题卡", LINEAGE_A)}-draft`);
  });
});

describe("built-in lineage", () => {
  it("gives every built-in its own lineage, the same on every install", () => {
    const lineages = BUILTIN_IDS.map((id) => builtinLineage(id));
    expect(lineages.every((uid) => uid !== null && isBuiltinLineage(uid))).toBe(true);
    expect(new Set(lineages).size).toBe(BUILTIN_IDS.length);
    // A fixed value: changing one makes every copy of that built-in a stranger.
    expect(builtinLineage("countdown")).toBe("697b544c-7aa2-460a-87cd-8e646bdaa149");
    expect(builtinLineage("my-motif")).toBeNull();
    expect(isBuiltinLineage(LINEAGE_A)).toBe(false);
  });
});

describe("BUILTIN_IDS", () => {
  it("is the three built-ins", () => {
    expect([...BUILTIN_IDS].sort()).toEqual(["clipping-headline", "clipping-paper", "clipping-stamp", "clipping-sticker", "countdown", "lower-third", "text-fx"]);
  });
});

describe("validateManifest", () => {
  it("accepts a sane manifest", () => {
    expect(() => validateManifest(base())).not.toThrow();
  });
  it("rejects empty name / zero / huge size", () => {
    expect(() => validateManifest({ ...base(), name: "  " })).toThrow();
    expect(() => validateManifest({ ...base(), size: [0, 100] })).toThrow();
    expect(() => validateManifest({ ...base(), size: [99999, 100] })).toThrow();
  });
  it("rejects negative size", () => { expect(() => validateManifest({ ...base(), size: [-1, 100] })).toThrow(); });
  it("takes sizes up to the frame limit in whole pixels", () => {
    expect(() => validateManifest({ ...base(), size: [8192, 8192] })).not.toThrow();
    expect(() => validateManifest({ ...base(), size: [8193, 100] })).toThrow(/within \[1,8192\]/);
    expect(() => validateManifest({ ...base(), size: [100.5, 100] })).toThrow(/whole pixels/);
  });
  it("rejects bad durations", () => {
    expect(() => validateManifest({ ...base(), default_duration_s: 0 })).toThrow();
    expect(() => validateManifest({ ...base(), content_duration_s: -1 })).toThrow();
  });
  it("rejects inverted number bounds and bad color default", () => {
    expect(() => validateManifest({ ...base(), props_schema: { n: { type: "number", default: 5, min: 10, max: 1 } } })).toThrow();
    expect(() => validateManifest({ ...base(), props_schema: { c: { type: "color", default: "not-a-hex" } } })).toThrow();
  });
});

describe("validateDefaultFor", () => {
  it("rejects an enum default not in options; accepts one that is", () => {
    expect(() => validateDefaultFor("e", { type: "enum", default: "x", options: ["a", "b"] })).toThrow();
    expect(() => validateDefaultFor("e", { type: "enum", default: "a", options: ["a", "b"] })).not.toThrow();
  });
});

describe("motifCtxDurationS", () => {
  it("prefers content_duration_s, then prop value, then max_duration_s, then default", () => {
    expect(motifCtxDurationS({ ...base(), content_duration_s: 2.5 }, {})).toBeCloseTo(2.5);
    expect(motifCtxDurationS({ ...base(), max_duration_prop: "seconds" }, { seconds: 7 })).toBeCloseTo(7);
    expect(motifCtxDurationS({ ...base(), max_duration_s: 4 }, {})).toBeCloseTo(4);
    expect(motifCtxDurationS({ ...base(), default_duration_s: 5 }, {})).toBeCloseTo(5);
  });
});
