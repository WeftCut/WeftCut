import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), failRename: false }));
const keyring = vi.hoisted(() => ({ available: true, checks: 0 }));
vi.mock("electron", () => ({
  app: { getPath: () => "/test-credentials" },
  safeStorage: {
    isEncryptionAvailable: () => { keyring.checks++; return keyring.available; },
    encryptString: (value: string) => {
      if (!keyring.available) throw new Error("Encryption is not available.");
      return Buffer.from(`encrypted:${value}`);
    },
    decryptString: (value: Buffer) => {
      if (!keyring.available) throw new Error("Decryption is not available.");
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
import { loadAllKeys, onKeyringChecked, setKey } from "./keys";
const target = path.join("/test-credentials", "cloud_keys.json");
const reports: boolean[] = [];
onKeyringChecked(available => { reports.push(available); });
beforeEach(() => {
  disk.files.clear(); disk.failRename = false;
  keyring.available = true; keyring.checks = 0; reports.length = 0;
});

describe("credential persistence", () => {
  it("persists keys independently and clears only the requested credential", () => {
    setKey("openai", " first "); setKey("model-custom-test", "second");
    expect(loadAllKeys()).toEqual({ openai: "first", "model-custom-test": "second" });
    setKey("model-custom-test", "");
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

describe("keyring access", () => {
  it("leaves the keyring alone while no key is stored, saved or decrypted", () => {
    expect(loadAllKeys()).toEqual({});
    setKey("openai", "  ");
    expect(keyring.checks).toBe(0);
    expect(reports).toEqual([]);
  });
  it("refuses a key it cannot encrypt, writes nothing and reports the keyring missing", () => {
    keyring.available = false;
    expect(() => setKey("openai", "secret")).toThrow("No system keyring");
    expect(disk.files.has(target)).toBe(false);
    expect(reports).toEqual([false]);
  });
  it("keeps stored keys while the keyring is gone and reads them once it is back", () => {
    setKey("openai", "kept");
    keyring.available = false;
    expect(loadAllKeys()).toEqual({});
    keyring.available = true;
    expect(loadAllKeys()).toEqual({ openai: "kept" });
    expect(reports).toEqual([true, false, true]);
  });
});
