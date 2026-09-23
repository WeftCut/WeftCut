import { describe, expect, it } from "vitest";
import { isMachO, resignInvalidMachO, type ContentSignDeps } from "./contentSign";

// What these pin: only Mach-O files are considered, only the ones whose
// signature fails verification are re-signed (a valid upstream signature is
// left as shipped), and a signing failure surfaces instead of passing quietly.

const bytes = (...b: number[]) => new Uint8Array(b);
const THIN64_LE = bytes(0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01);
const FAT_2 = bytes(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02);
const JAVA_CLASS = bytes(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41);
const TEXT = new TextEncoder().encode("tokens a b c");

describe("isMachO", () => {
  it("recognizes thin images in both byte orders and fat wrappers", () => {
    expect(isMachO(THIN64_LE)).toBe(true);
    expect(isMachO(bytes(0xfe, 0xed, 0xfa, 0xcf))).toBe(true);
    expect(isMachO(bytes(0xce, 0xfa, 0xed, 0xfe))).toBe(true);
    expect(isMachO(FAT_2)).toBe(true);
  });

  it("does not mistake a Java class file, text, or a short file for Mach-O", () => {
    expect(isMachO(JAVA_CLASS)).toBe(false);
    expect(isMachO(TEXT)).toBe(false);
    expect(isMachO(bytes(0xcf, 0xfa))).toBe(false);
    expect(isMachO(bytes(0xca, 0xfe, 0xba, 0xbe))).toBe(false);
  });
});

function fakeDeps(
  files: Record<string, { head: Uint8Array; valid: boolean }>,
  signError?: Error,
): ContentSignDeps & { verified: string[]; signed: string[][] } {
  const deps = {
    verified: [] as string[],
    signed: [] as string[][],
    listFiles: () => Object.keys(files),
    readHead: (p: string, n: number) => files[p]!.head.slice(0, n),
    verify: async (p: string) => {
      deps.verified.push(p);
      return files[p]!.valid;
    },
    sign: async (paths: string[]) => {
      deps.signed.push(paths);
      if (signError) throw signError;
    },
  };
  return deps;
}

describe("resignInvalidMachO", () => {
  it("re-signs only the Mach-O files whose signature fails, in one call", async () => {
    const deps = fakeDeps({
      "rt/bin/sherpa-onnx-offline": { head: THIN64_LE, valid: true },
      "rt/lib/libonnxruntime.1.27.0.dylib": { head: THIN64_LE, valid: false },
      "rt/lib/libonnxruntime.dylib": { head: FAT_2, valid: false },
      "rt/README.md": { head: TEXT, valid: false },
    });
    const signed = await resignInvalidMachO(deps, "rt");
    expect(signed).toEqual([
      "rt/lib/libonnxruntime.1.27.0.dylib",
      "rt/lib/libonnxruntime.dylib",
    ]);
    expect(deps.signed).toEqual([signed]);
    // Non-Mach-O files are never handed to codesign at all.
    expect(deps.verified).not.toContain("rt/README.md");
  });

  it("a payload whose signatures all verify is left untouched", async () => {
    const deps = fakeDeps({
      "llama-b10103/llama-mtmd-cli": { head: THIN64_LE, valid: true },
      "llama-b10103/libllama.0.dylib": { head: THIN64_LE, valid: true },
    });
    expect(await resignInvalidMachO(deps, "llama-b10103")).toEqual([]);
    expect(deps.signed).toEqual([]);
  });

  it("a signing failure throws rather than reporting the install clean", async () => {
    const deps = fakeDeps(
      { "rt/lib/libx.dylib": { head: THIN64_LE, valid: false } },
      new Error("codesign exited 1"),
    );
    await expect(resignInvalidMachO(deps, "rt")).rejects.toThrow("codesign exited 1");
  });
});
