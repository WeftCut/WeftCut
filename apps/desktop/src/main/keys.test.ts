import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), failRename: false }));
vi.mock("electron", () => ({
  app: { getPath: () => "/test-credentials" },
  safeStorage: {
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith("encrypted:")) throw new Error("Invalid encrypted key");
      return text.slice(10);
    },
  },
}));
vi.mock("node:fs", () => ({ default: {
  readFileSync: (file: string) => { if (!disk.files.has(file)) throw new Error("Missing"); return disk.files.get(file); },
  writeFileSync: (file: string, value: string) => { disk.files.set(file, value); },
  renameSync: (from: string, to: string) => {
    if (disk.failRename) throw new Error("Disk full");
    disk.files.set(to, disk.files.get(from)!); disk.files.delete(from);
  },
} }));
import { clearKey, loadAllKeys, setKey } from "./keys";
const target = path.join("/test-credentials", "cloud_keys.json");
beforeEach(() => { disk.files.clear(); disk.failRename = false; });

describe("credential persistence", () => {
  it("persists keys independently and clears only the requested credential", () => {
    setKey("openai", " first "); setKey("model-custom-test", "second");
    expect(loadAllKeys()).toEqual({ openai: "first", "model-custom-test": "second" });
    clearKey("model-custom-test");
    expect(loadAllKeys()).toEqual({ openai: "first" });
  });
  it("reports a failed atomic replacement and preserves all previous keys", () => {
    setKey("openai", "previous"); setKey("model-custom-test", "other");
    disk.failRename = true;
    expect(() => setKey("openai", "replacement")).toThrow("Disk full");
    expect(loadAllKeys()).toEqual({ openai: "previous", "model-custom-test": "other" });
  });
  it("still reads usable keys if removing a corrupted entry cannot be persisted", () => {
    setKey("openai", "valid");
    disk.files.set(target, JSON.stringify({ ...JSON.parse(disk.files.get(target)!), corrupt: "invalid" }));
    disk.failRename = true;
    expect(loadAllKeys()).toEqual({ openai: "valid" });
  });
});
