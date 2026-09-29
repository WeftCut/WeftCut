import { describe, it, expect } from "vitest";
import { motifContentHash } from "./contentHash";
import type { Manifest } from "../../shared/motifs/catalog";

const m: Manifest = { id: "x", name: "X", version: 1, size: [10, 10], default_duration_s: 1, props_schema: {} };

describe("motifContentHash", () => {
  it('hashes asset names and binary bytes independent of enumeration order', () => {
    const a = { path: 'mesh.bin', bytes: Buffer.from([0, 255]) };
    const b = { path: 'scene.js', bytes: Buffer.from('scene') };
    const hash = motifContentHash(m, '<html/>', [a, b]);
    expect(motifContentHash(m, '<html/>', [b, a])).toBe(hash);
    expect(motifContentHash(m, '<html/>', [a])).not.toBe(hash);
    expect(motifContentHash(m, '<html/>', [a, { ...b, path: 'other.js' }])).not.toBe(hash);
    expect(motifContentHash(m, '<html/>', [{ ...a, bytes: Buffer.from([0, 254]) }, b])).not.toBe(hash);
    expect(motifContentHash(m, '<html/>', [a, b, { path: 'target', bytes: Buffer.from('private') }])).toBe(hash);
  });
  it("is a 64-char lowercase hex sha256", () => {
    const h = motifContentHash(m, "<html></html>");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable for identical inputs", () => {
    expect(motifContentHash(m, "<a/>")).toBe(motifContentHash(m, "<a/>"));
  });
  it("changes when html changes", () => {
    expect(motifContentHash(m, "<a/>")).not.toBe(motifContentHash(m, "<b/>"));
  });
  it("changes when a core manifest field changes", () => {
    expect(motifContentHash(m, "<a/>")).not.toBe(motifContentHash({ ...m, version: 2 }, "<a/>"));
  });
  it("ignores decoration fields (status/content_hash/target_id/settle_rafs)", () => {
    const decorated = { ...m, status: "draft", content_hash: "deadbeef", target_id: "y", settle_rafs: 3 } as Manifest;
    expect(motifContentHash(decorated, "<a/>")).toBe(motifContentHash(m, "<a/>"));
  });
});
