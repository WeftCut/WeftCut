// Best-effort family-name → font-file resolver for the burn-in path. Scans the
// platform font directories, builds a family→path map by reading each font's
// sfnt `name` table (no native deps). Returns null when not found — the
// renderer then applies the bundled-font fallback (never tofu). NOT part of the
// cross-OS determinism contract: different machines, different files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FONT_DIRS: Record<string, string[]> = {
  win32: [
    path.join(process.env["WINDIR"] ?? "C:\\Windows", "Fonts"),
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "Windows", "Fonts"),
  ],
  darwin: [
    "/System/Library/Fonts",
    "/Library/Fonts",
    path.join(os.homedir(), "Library/Fonts"),
  ],
  linux: [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(os.homedir(), ".fonts"),
    path.join(os.homedir(), ".local/share/fonts"),
  ],
};

interface FontEntry { family: string; file: string }

// One lazy, in-flight-inclusive cache for listing AND export resolution. The
// snapshot lasts until app restart; opening another picker never scans again.
let familyMap: Promise<Map<string, FontEntry>> | null = null;

function getFamilyMap(): Promise<Map<string, FontEntry>> {
  return familyMap ??= buildFamilyMap().catch((error: unknown) => {
    familyMap = null;
    throw error;
  });
}

export async function listSystemFontFamilies(): Promise<string[]> {
  return [...(await getFamilyMap()).values()]
    .map((entry) => entry.family).sort((a, b) => a.localeCompare(b));
}

export async function resolveSystemFont(family: string): Promise<Buffer | null> {
  const hit = (await getFamilyMap()).get(family.toLowerCase());
  if (!hit) return null;
  try {
    return await fs.promises.readFile(hit.file);
  } catch {
    return null;
  }
}

async function buildFamilyMap(): Promise<Map<string, FontEntry>> {
  const map = new Map<string, FontEntry>();
  const dirs = FONT_DIRS[process.platform] ?? [];
  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      try {
        const name = readFamilyName(await fs.promises.readFile(file));
        if (name) map.set(name.toLowerCase(), { family: name, file });
      } catch {
        // skip unreadable / unparsable
      }
    }
  }
  return map;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/// Read the family name (nameID 1) from an sfnt `name` table. Handles the
/// single-font sfnt header; `.ttc` collections read the first font's offset.
/// Returns null for any malformed / truncated buffer — never throws.
export function readFamilyName(buf: Buffer): string | null {
  try {
    let base = 0;
    const tag = buf.toString("ascii", 0, 4);
    if (tag === "ttcf") base = buf.readUInt32BE(12); // first font in the collection
    const numTables = buf.readUInt16BE(base + 4);
    let nameOff = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (buf.toString("ascii", rec, rec + 4) === "name") {
        nameOff = buf.readUInt32BE(rec + 8);
        break;
      }
    }
    if (!nameOff) return null;
    const count = buf.readUInt16BE(nameOff + 2);
    const storage = nameOff + buf.readUInt16BE(nameOff + 4);
    let fallback: string | null = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12;
      const platformId = buf.readUInt16BE(rec);
      const nameId = buf.readUInt16BE(rec + 6);
      const len = buf.readUInt16BE(rec + 8);
      const off = storage + buf.readUInt16BE(rec + 10);
      if (nameId !== 1) continue;
      // platform 3 (Windows) / 0 (Unicode) → UTF-16BE; platform 1 (Mac) → ascii.
      const cleaned =
        platformId === 1
          ? buf.toString("ascii", off, off + len).trim()
          : swap16(buf.subarray(off, off + len)).trim();
      if (cleaned) {
        if (platformId === 3) return cleaned;
        fallback ??= cleaned;
      }
    }
    return fallback;
  } catch {
    return null;
  }
}

function swap16(b: Buffer): string {
  const out = Buffer.from(b);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i] as number;
    out[i] = out[i + 1] as number;
    out[i + 1] = t;
  }
  return out.toString("utf16le").replace(/\0/g, "");
}
