// macOS-only install step for app-managed content (ADR 0075): give every
// Mach-O file in a freshly extracted runtime a signature the kernel accepts.
//
// Apple Silicon refuses to map code whose signature is missing or does not
// match its bytes — the process is SIGKILLed at load, not handed an error. The
// upstream sherpa-onnx v1.13.4 osx-arm64 tarball ships exactly that:
// libonnxruntime*.dylib carries a signature that no longer covers the file
// (modified after signing), so sherpa-onnx-offline dies with exit 137 before
// printing anything. `codesign --force --sign -` (ad-hoc) repairs it.
//
// Only files that FAIL verification are re-signed: a valid upstream signature
// (ad-hoc or otherwise) is left exactly as shipped, so this step changes
// nothing about an archive that was already fine. The sha256 pin still covers
// the downloaded archive — re-signing happens after verification, to bytes
// already known to be the pinned artifact, and only rewrites their signature.
//
// Pure + DI like contentDownload.ts: the production adapter (node:fs walk +
// /usr/bin/codesign) is built at the call site in src/main/index.ts, and only
// on darwin.

export interface ContentSignDeps {
  /** Absolute paths of every regular file under `dir`, recursively. Symlinks
   *  are neither listed nor followed — their targets are listed themselves. */
  listFiles(dir: string): string[];
  /** Up to the first `n` bytes of a file. */
  readHead(path: string, n: number): Uint8Array;
  /** `codesign --verify` — true when the file's signature is valid. */
  verify(path: string): Promise<boolean>;
  /** `codesign --force --sign -` over the given files; throws on failure. */
  sign(paths: string[]): Promise<void>;
}

/**
 * Whether a file header is Mach-O: a thin 32/64-bit image in either byte
 * order, or a fat (universal) wrapper. The fat magic is shared with Java class
 * files, which `file(1)` tells apart by the second word — a fat header's arch
 * count is small, a class file's major version is 45 or more.
 */
export function isMachO(head: Uint8Array): boolean {
  if (head.byteLength < 4) return false;
  const magic =
    ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  switch (magic) {
    case 0xfeedface:
    case 0xfeedfacf:
    case 0xcefaedfe:
    case 0xcffaedfe:
      return true;
    case 0xcafebabe:
    case 0xcafebabf: {
      if (head.byteLength < 8) return false;
      const count =
        ((head[4]! << 24) | (head[5]! << 16) | (head[6]! << 8) | head[7]!) >>> 0;
      return count > 0 && count < 45;
    }
    default:
      return false;
  }
}

/**
 * Ad-hoc re-sign every Mach-O file under `dir` whose signature does not
 * verify. Returns the paths it re-signed (empty when the payload was already
 * clean). Throws when signing fails — an install that would be killed at load
 * must not be marked installed.
 */
export async function resignInvalidMachO(
  deps: ContentSignDeps,
  dir: string,
): Promise<string[]> {
  const invalid: string[] = [];
  for (const file of deps.listFiles(dir)) {
    if (!isMachO(deps.readHead(file, 8))) continue;
    if (!(await deps.verify(file))) invalid.push(file);
  }
  if (invalid.length > 0) await deps.sign(invalid);
  return invalid;
}
