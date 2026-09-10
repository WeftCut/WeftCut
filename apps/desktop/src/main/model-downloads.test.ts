import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelDownloads } from "./model-downloads";
import { beginModelUse, assertModelsIdle } from "./model-usage";
import type { ContentDeps } from "./contentDownload";
import type { ModelProfile } from "../shared/inference-models";

const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-model-downloads-test-")); roots.push(root);
  const downloads = path.join(root, "downloads"), partials = path.join(root, "partials");
  fs.mkdirSync(downloads); fs.mkdirSync(partials);
  const rm = vi.fn((target: string) => {
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Test path escaped");
    fs.rmSync(target, { recursive: true, force: true });
  });
  const content = { downloadsDir: downloads, partialDir: partials, join: path.join, fs: { rm } } as unknown as ContentDeps;
  return { root, downloads, partials, rm, storage: createModelDownloads(content) };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("weftcut-model-downloads-test-")) throw new Error("Unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const profile = (binary: string): ModelProfile => ({ id: "custom-test", name: "Shared", family: "speech", backend: "whisper_cpp", locality: "local", custom: true, artifacts: [], local: { binary, model: "/own/weights" } });

describe("managed model download ownership", () => {
  it("counts installed and partial bytes and removes only the catalog-owned directory", () => {
    const { root, downloads, partials, storage } = setup();
    const artifact = path.join(downloads, "whisper-model-base", "v1"); fs.mkdirSync(artifact, { recursive: true });
    fs.writeFileSync(path.join(artifact, "weights"), "12345");
    fs.writeFileSync(path.join(partials, "whisper-model-base.part"), "123");
    const ownFile = path.join(root, "user-model.bin"); fs.writeFileSync(ownFile, "keep");
    expect(storage.downloadedBytes("whisper-model-base")).toBe(8);
    storage.removeContent("whisper-model-base");
    expect(storage.downloadedBytes("whisper-model-base")).toBe(0);
    expect(fs.readFileSync(ownFile, "utf8")).toBe("keep");
  });
  it("recognizes custom local paths into managed artifacts without matching sibling prefixes", () => {
    const { downloads, storage } = setup();
    expect(storage.referencesContent(profile(path.join(downloads, "whisper-cpp-runtime", "v1", "run.exe")), "whisper-cpp-runtime")).toBe(true);
    expect(storage.referencesContent(profile(path.join(downloads, "whisper-cpp-runtime-copy", "run.exe")), "whisper-cpp-runtime")).toBe(false);
  });
  it("rejects traversal and unknown artifact IDs before deleting anything", () => {
    const { storage, rm } = setup();
    expect(() => storage.removeContent("../outside")).toThrow("Unknown content");
    expect(() => storage.removeContent("unknown-model")).toThrow("Unknown content");
    expect(rm).not.toHaveBeenCalled();
  });
  it("refuses a catalog directory redirected outside the download root", () => {
    const { root, downloads, storage, rm } = setup();
    const outside = path.join(root, "user-files"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(downloads, "whisper-model-base"), process.platform === "win32" ? "junction" : "dir");
    expect(() => storage.removeContent("whisper-model-base")).toThrow("Unsafe download path");
    expect(rm).not.toHaveBeenCalled();
  });
  it("waits until every overlapping inference reader has finished", () => {
    const releaseA = beginModelUse(), releaseB = beginModelUse();
    try {
      expect(() => assertModelsIdle()).toThrow("in use");
      releaseA(); expect(() => assertModelsIdle()).toThrow("in use");
    } finally { releaseB(); }
    expect(() => assertModelsIdle()).not.toThrow();
  });
});
