// Best-effort family-name → font-file resolver for the burn-in path. Scans the
// platform font directories AND the app-managed imported-font directory
// (<userData>/fonts/), builds a family→path map by reading each font's sfnt
// `name` table (no native deps). Returns null when not found — the renderer
// then applies the bundled-font fallback (never tofu). NOT part of the
// cross-OS determinism contract: different machines, different files.
//
// Imported fonts (<userData>/fonts/) ARE part of the determinism guarantee for
// a single machine: they are app-managed, present on every launch, and shared
// across all workspaces and projects.
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

let familyMap: Map<string, string> | null = null;

/// The app-managed imported-font directory, set once at startup.
/// Fonts here resolve just like OS fonts and are shared across all workspaces.
let importedFontsDir: string | null = null;

/// Call once at app startup with app.getPath('userData') to enable the
/// app-managed imported-font directory (<userData>/fonts/).
export function setImportedFontsDir(userDataPath: string): void {
  importedFontsDir = path.join(userDataPath, 'fonts');
  // Ensure the directory exists so later scans and copies never throw.
  try { fs.mkdirSync(importedFontsDir, { recursive: true }); } catch { /* already exists */ }
}

export async function resolveSystemFont(family: string): Promise<Buffer | null> {
  if (!familyMap) familyMap = buildFamilyMap();
  const hit = familyMap.get(family.toLowerCase());
  if (!hit) return null;
  try {
    return fs.readFileSync(hit);
  } catch {
    return null;
  }
}

/// Import a font file into <userData>/fonts/. Reads the family name from the
/// sfnt name table, copies the file, invalidates the family-map cache so the
/// new font resolves on the next `font:resolve` call, and returns the family
/// name. Throws with a user-readable message on any failure.
export async function importFont(
  srcPath: string,
): Promise<{ family: string; filename: string }> {
  if (!importedFontsDir) throw new Error('importedFontsDir not initialized');

  const ext = path.extname(srcPath).toLowerCase();
  if (!/^\.(ttf|otf|woff2)$/i.test(ext)) {
    throw new Error(`Unsupported font format "${ext}". Use .ttf, .otf, or .woff2.`);
  }

  const buf = fs.readFileSync(srcPath);
  const family = readFamilyName(buf as Buffer);
  if (!family) throw new Error('Could not read font family name from file.');

  const destFilename = `${family.replace(/[/\\:*?"<>|]/g, '_')}${ext}`;
  const destPath = path.join(importedFontsDir, destFilename);
  fs.writeFileSync(destPath, buf);

  // Invalidate so the next resolve re-scans and picks up the new file.
  familyMap = null;

  return { family, filename: destFilename };
}

/// List every font previously imported into <userData>/fonts/.
/// Returns `{ family, filename }` pairs — filename is relative to the dir.
export function listImportedFonts(): { family: string; filename: string }[] {
  if (!importedFontsDir) return [];
  const out: { family: string; filename: string }[] = [];
  for (const file of walk(importedFontsDir)) {
    if (!/\.(ttf|otf|woff2)$/i.test(file)) continue;
    try {
      const name = readFamilyName(fs.readFileSync(file) as Buffer);
      if (name) out.push({ family: name, filename: path.basename(file) });
    } catch { /* skip unreadable */ }
  }
  return out;
}

function buildFamilyMap(): Map<string, string> {
  const map = new Map<string, string>();
  // OS platform dirs first, then the app-managed imported-font dir.
  const dirs = [...(FONT_DIRS[process.platform] ?? []), ...(importedFontsDir ? [importedFontsDir] : [])];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (!/\.(ttf|otf|ttc|woff2)$/i.test(file)) continue;
      try {
        const name = readFamilyName(fs.readFileSync(file) as Buffer);
        if (name) map.set(name.toLowerCase(), file);
      } catch {
        // skip unreadable / unparsable
      }
    }
  }
  return map;
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
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
