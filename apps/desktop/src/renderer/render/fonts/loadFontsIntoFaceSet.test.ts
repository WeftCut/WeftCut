// @vitest-environment jsdom
// apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFontsIntoFaceSet } from "./loadFontsIntoFaceSet";

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
