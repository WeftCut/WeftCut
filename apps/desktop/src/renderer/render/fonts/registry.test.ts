// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_FONT_FAMILIES,
  DEFAULT_CAPTION_FONT_FAMILY,
  ensureFaces,
  faceBytes,
} from "./registry";

describe("font registry", () => {
  it("advertises Liberation Sans + Noto CJK and a fallback-chain default", () => {
    expect(BUNDLED_FONT_FAMILIES).toContain("Liberation Sans");
    expect(BUNDLED_FONT_FAMILIES).toContain("Noto Sans SC");
    expect(DEFAULT_CAPTION_FONT_FAMILY).toBe("Liberation Sans, Noto Sans SC");
  });
});

describe("faceBytes", () => {
  const mockBytes = (impl: (sha: string) => Promise<Uint8Array | null>) => {
    const bytes = vi.fn(impl);
    (globalThis as Record<string, unknown>).window = { api: { font: { bytes } } };
    return bytes;
  };

  it("hands each caller bytes of its own: transferring one detaches no other", async () => {
    mockBytes(async () => new Uint8Array([4, 5]));
    const [first, second] = await Promise.all([faceBytes("transfer"), faceBytes("transfer")]);
    // What runExport does with every face it hands the Worker.
    structuredClone(first!, { transfer: [first!] });
    expect(first!.byteLength).toBe(0);
    expect(new Uint8Array(second!)).toEqual(new Uint8Array([4, 5]));
    expect(new Uint8Array((await faceBytes("transfer"))!)).toEqual(new Uint8Array([4, 5]));
  });

  it("answers with only the face's bytes when main's view is part of a larger buffer", async () => {
    mockBytes(async () => new Uint8Array([0, 1, 2, 3]).subarray(1, 3));
    expect(new Uint8Array((await faceBytes("view"))!)).toEqual(new Uint8Array([1, 2]));
  });

  it("answers null for a face main no longer has, and asks again next time", async () => {
    let calls = 0;
    const bytes = mockBytes(async () => (++calls === 1 ? null : new Uint8Array([1])));
    expect(await faceBytes("gone")).toBeNull();
    expect(new Uint8Array((await faceBytes("gone"))!)).toEqual(new Uint8Array([1]));
    expect(bytes).toHaveBeenCalledTimes(2);
  });

  it("passes a rejection on; the next call asks again and can succeed", async () => {
    let calls = 0;
    const bytes = mockBytes(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ipc hiccup");
      return new Uint8Array([6]);
    });
    await expect(faceBytes("retry")).rejects.toThrow("ipc hiccup");
    expect(new Uint8Array((await faceBytes("retry"))!)).toEqual(new Uint8Array([6]));
    expect(bytes).toHaveBeenCalledTimes(2);
  });

  it("holds no bytes of a face once it is registered: a later ask goes to main", async () => {
    vi.stubGlobal("FontFace", class { async load() { return this; } });
    const bytes = mockBytes(async () => new Uint8Array([3]));
    const set = new Set<FontFace>() as unknown as FontFaceSet;
    expect(await ensureFaces(set, [{ sha256: "registered", weight: 400, italic: false }])).toEqual([]);
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(new Uint8Array((await faceBytes("registered"))!)).toEqual(new Uint8Array([3]));
    expect(bytes).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
