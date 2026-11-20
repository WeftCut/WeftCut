// @vitest-environment jsdom
// apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { faceAlias } from "../../../shared/fonts/resolve";
import type { FaceRef } from "../../../shared/fonts/types";
import { loadFontsIntoFaceSet, syncFaces, type FaceLoad } from "./loadFontsIntoFaceSet";

describe("loadFontsIntoFaceSet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("constructs and adds one FontFace per family", async () => {
    const added: string[] = [];
    const fakeSet = { add: (f: { family: string }) => added.push(f.family) } as unknown as FontFaceSet;
    // jsdom lacks FontFace; stub a minimal one that resolves load().
    vi.stubGlobal("FontFace", class {
      family: string;
      constructor(family: string) { this.family = family; }
      load() { return Promise.resolve(this); }
    });
    await loadFontsIntoFaceSet(fakeSet, {
      "Liberation Sans": new ArrayBuffer(4),
      "Noto Sans SC": new ArrayBuffer(4),
    });
    expect(added.sort()).toEqual(["Liberation Sans", "Noto Sans SC"]);
  });

  it("shares font registration across repeated and concurrent preview mounts", async () => {
    const faces = new Set<FontFace>();
    const construct = vi.fn();
    let finish!: () => void;
    const loading = new Promise<void>(resolve => { finish = resolve; });
    vi.stubGlobal("FontFace", class {
      constructor(family: string) { construct(family); }
      async load() { await loading; return this; }
    });
    const faceSet = faces as unknown as FontFaceSet;
    // Each caller gets fresh byte copies, just like loadBundledFontBytes().
    const first = loadFontsIntoFaceSet(faceSet, { "Preview Font": new ArrayBuffer(4) });
    const second = loadFontsIntoFaceSet(faceSet, { "Preview Font": new ArrayBuffer(4) });
    finish();
    await Promise.all([first, second]);
    await loadFontsIntoFaceSet(faceSet, { "Preview Font": new ArrayBuffer(4) });
    expect(construct).toHaveBeenCalledTimes(1);
    expect(faces.size).toBe(1);
  });

  it("registers the same family separately in independent font sets", async () => {
    vi.stubGlobal("FontFace", class { async load() { return this; } });
    const preview = new Set<FontFace>(), worker = new Set<FontFace>();
    const fonts = { "Shared Family": new ArrayBuffer(4) };
    await loadFontsIntoFaceSet(preview as unknown as FontFaceSet, fonts);
    await loadFontsIntoFaceSet(worker as unknown as FontFaceSet, fonts);
    expect(preview.size).toBe(1);
    expect(worker.size).toBe(1);
    expect([...preview][0]).not.toBe([...worker][0]);
  });

  it("retries failed families without registering successful siblings again", async () => {
    const attempts: string[] = [];
    vi.stubGlobal("FontFace", class {
      constructor(readonly family: string) {}
      async load() {
        attempts.push(this.family);
        if (this.family === "Retry" && attempts.filter(f => f === "Retry").length === 1) {
          throw new Error("font load failed");
        }
        return this;
      }
    });
    const faces = new Set<FontFace>();
    const fonts = { Ready: new ArrayBuffer(4), Retry: new ArrayBuffer(4) };
    await expect(loadFontsIntoFaceSet(faces as unknown as FontFaceSet, fonts)).rejects.toThrow("font load failed");
    await loadFontsIntoFaceSet(faces as unknown as FontFaceSet, fonts);
    expect(attempts.filter(f => f === "Ready")).toHaveLength(1);
    expect(attempts.filter(f => f === "Retry")).toHaveLength(2);
    expect(faces.size).toBe(2);
  });
});

describe("syncFaces", () => {
  afterEach(() => vi.unstubAllGlobals());

  /// A FontFace that keeps what it was built with; `reject` names families
  /// whose load fails.
  function stubFontFace(reject: Set<string> = new Set()) {
    vi.stubGlobal("FontFace", class {
      constructor(readonly family: string, readonly source: ArrayBuffer, readonly descriptors: FontFaceDescriptors) {}
      async load() {
        if (reject.has(this.family)) throw new Error("bad font");
        return this;
      }
    });
  }
  type Built = { family: string; descriptors: FontFaceDescriptors };
  const sha = (c: string) => c.repeat(64);
  const load = (ref: FaceRef, bytes: ArrayBuffer | null = new ArrayBuffer(4)): FaceLoad => ({ ref, bytes: async () => bytes });

  it("registers a Bold face under its alias with weight 700", async () => {
    stubFontFace();
    const set = new Set<Built>();
    await syncFaces(set as unknown as FontFaceSet, [load({ sha256: sha("b"), weight: 700, italic: false })]);
    expect([...set].map(f => [f.family, f.descriptors])).toEqual([
      [faceAlias(sha("b")), { weight: "700", style: "normal" }],
    ]);
  });

  it("gives a variable face its weight range and an italic face its style", async () => {
    stubFontFace();
    const set = new Set<Built>();
    await syncFaces(set as unknown as FontFaceSet, [load({ sha256: sha("c"), weight: [100, 900], italic: true })]);
    expect([...set][0]!.descriptors).toEqual({ weight: "100 900", style: "italic" });
  });

  it("deletes faces no longer listed, and keeps the ones still listed", async () => {
    stubFontFace();
    const set = new Set<Built>();
    const a = { sha256: sha("a"), weight: 400, italic: false };
    const b = { sha256: sha("b"), weight: 700, italic: false };
    await syncFaces(set as unknown as FontFaceSet, [load(a), load(b)]);
    const kept = [...set].find(f => f.family === faceAlias(a.sha256));
    await syncFaces(set as unknown as FontFaceSet, [load(a)]);
    expect([...set]).toEqual([kept]);
  });

  it("never adds a face unlisted while it was loading", async () => {
    stubFontFace();
    const set = new Set<Built>();
    let release!: (b: ArrayBuffer) => void;
    const slow: FaceLoad = { ref: { sha256: sha("e"), weight: 400, italic: false }, bytes: () => new Promise(r => { release = r; }) };
    const first = syncFaces(set as unknown as FontFaceSet, [slow]);
    await syncFaces(set as unknown as FontFaceSet, []);
    release(new ArrayBuffer(4));
    await first;
    expect(set.size).toBe(0);
  });

  it("reports faces that could not be registered without failing the others, and retries them next time", async () => {
    const good = { sha256: sha("1"), weight: 400, italic: false };
    const gone = { sha256: sha("2"), weight: 400, italic: false };
    const broken = { sha256: sha("3"), weight: 400, italic: false };
    stubFontFace(new Set([faceAlias(broken.sha256)]));
    const set = new Set<Built>();
    const failed = await syncFaces(set as unknown as FontFaceSet, [load(good), load(gone, null), load(broken)]);
    expect(failed.sort()).toEqual([gone.sha256, broken.sha256].sort());
    expect([...set].map(f => f.family)).toEqual([faceAlias(good.sha256)]);
    const retry = vi.fn(async () => new ArrayBuffer(4));
    await syncFaces(set as unknown as FontFaceSet, [load(good), { ref: gone, bytes: retry }]);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(set.size).toBe(2);
  });
});
