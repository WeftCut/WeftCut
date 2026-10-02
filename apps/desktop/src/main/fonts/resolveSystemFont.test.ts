// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFamilyName } from "./resolveSystemFont.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
afterEach(() => vi.restoreAllMocks());

describe("system font catalog", () => {
  it("shares a single asynchronous scan between concurrent listing and resolution, preserving display names", async () => {
    vi.resetModules();
    const { listSystemFontFamilies, resolveSystemFont } = await import("./resolveSystemFont");
    const family = "Example Sans";
    const name = Buffer.from(family, "utf16le").swap16();
    const bytes = Buffer.alloc(46 + name.length);
    bytes.writeUInt16BE(1, 4); // one table
    bytes.write("name", 12);
    bytes.writeUInt32BE(28, 20); // name table offset
    bytes.writeUInt16BE(1, 30); // one name record
    bytes.writeUInt16BE(18, 32); // string storage offset
    bytes.writeUInt16BE(3, 34); // Windows, UTF-16BE
    bytes.writeUInt16BE(1, 40); // family name
    bytes.writeUInt16BE(name.length, 42);
    name.copy(bytes, 46);
    const entry = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });
    const readdir = vi.spyOn(fs.promises, "readdir").mockResolvedValue([
      entry("regular.ttf"), entry("duplicate.otf"), entry("broken.ttf"), entry("ignored.txt"),
    ] as never);
    const readFile = vi.spyOn(fs.promises, "readFile").mockImplementation(async (file) => {
      if (String(file).endsWith("broken.ttf")) throw new Error("unreadable");
      return bytes;
    });
    const [first, second, resolved] = await Promise.all([
      listSystemFontFamilies(), listSystemFontFamilies(), resolveSystemFont(family.toUpperCase()),
    ]);
    expect(first).toEqual([family]);
    expect(second).toEqual(first);
    expect(resolved).toEqual(bytes);
    const directoriesRead = readdir.mock.calls.length;
    expect(directoriesRead).toBeGreaterThan(0);
    expect(new Set(readdir.mock.calls.map(([dir]) => String(dir))).size).toBe(directoriesRead);
    expect(readFile).toHaveBeenCalledTimes(directoriesRead * 3 + 1);
    first.push("Caller mutation");
    expect(await listSystemFontFamilies()).toEqual([family]);
    expect(await resolveSystemFont("Missing Family")).toBeNull();
    expect(readdir).toHaveBeenCalledTimes(directoriesRead);
    readFile.mockRejectedValue(new Error("font removed"));
    expect(await resolveSystemFont(family)).toBeNull();
  });

  it("tolerates missing or inaccessible platform directories", async () => {
    vi.resetModules();
    const { listSystemFontFamilies } = await import("./resolveSystemFont");
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(new Error("EACCES"));
    expect(await listSystemFontFamilies()).toEqual([]);
  });
});

describe("readFamilyName", () => {
  it("reads the family from a TTF/OTF name table", () => {
    const otf = fs.readFileSync(
      path.resolve(__dirname, "../../../assets/fonts/NotoSansSC-VF.ttf"),
    );
    const name = readFamilyName(otf);
    expect(name?.toLowerCase()).toContain("noto");
  });
});
