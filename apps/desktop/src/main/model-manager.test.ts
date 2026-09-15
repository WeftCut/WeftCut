import { describe, expect, it, vi } from "vitest";
import { ModelManager, type ModelManagerDeps } from "./model-manager";
import { freshModelSettings } from "./model-settings";
import type { ModelLocalConfig } from "../shared/inference-models";

const local = (id: string): ModelLocalConfig => ({ binary: `/managed/${id}/run.exe`, model: `/managed/${id}/weights`, ...(id === "qwen3-vl-4b" ? { mmproj: "/managed/projector" } : {}), ...(id === "paraformer-zh" ? { tokens: "/managed/tokens" } : {}) });
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(over: Partial<ModelManagerDeps> = {}) {
  let state = freshModelSettings();
  const keys = new Map<string, string>();
  const deps: ModelManagerDeps = {
    store: { get: () => structuredClone(state), set: next => { state = structuredClone(next); } },
    managedLocal: local, content: () => ({ installed: true, supported: true, bytes: 100, receivedBytes: 0 }),
    downloadedBytes: () => 200, referencesContent: () => false, assertContentIdle: vi.fn(), removeContent: vi.fn(),
    ensureContent: vi.fn(async () => {}), cancelContent: vi.fn(), exists: () => true,
    getKey: tag => keys.get(tag) ?? "", setKey: (tag, key) => { keys.set(tag, key); },
    needsComponents: () => false, installComponents: vi.fn(async () => {}),
    verify: vi.fn(async () => ({ device: "cpu" as const })),
    fingerprint: p => JSON.stringify({ backend: p.backend, local: p.local, endpoint: p.endpoint }),
    applyActive: vi.fn(), changed: vi.fn(), uuid: () => "test", ...over,
  };
  return { manager: new ModelManager(deps), deps, keys, state: () => deps.store.get() };
}
describe("model preparation and activation", () => {
  it("does not activate a freshly previewed model or claim it is verified", () => {
    const { manager } = setup();
    expect(manager.active("speech")).toBeNull();
    expect(manager.view().models.find(m => m.id === "whisper-base")?.verified).toBe(false);
  });
  it("waits for the whole download and real verification before activating", async () => {
    const download = deferred<void>(); const verify = deferred<{ device: "cpu" }>();
    const { manager, deps } = setup({ ensureContent: () => download.promise, verify: vi.fn(() => verify.promise) });
    manager.use({ id: "whisper-base" });
    expect(manager.active("speech")).toBeNull(); expect(deps.verify).not.toHaveBeenCalled();
    download.resolve(); await settle();
    expect(manager.view().operations[0]?.phase).toBe("verifying");
    expect(manager.active("speech")).toBeNull();
    verify.resolve({ device: "cpu" }); await settle();
    expect(manager.active("speech")?.id).toBe("whisper-base");
    expect(manager.view().operations).toEqual([]);
  });
  it("failed verification preserves the old active model and stored credential", async () => {
    const { manager, deps, keys, state } = setup();
    manager.use({ id: "whisper-base" }); await settle();
    keys.set("openai", "old-key");
    deps.verify = vi.fn(async () => { throw new Error("rejected new-key"); });
    manager.use({ id: "openai-whisper", apiKey: "new-key" }); await settle();
    expect(state().active.speech).toBe("whisper-base");
    expect(keys.get("openai")).toBe("old-key");
    expect(JSON.stringify(manager.view())).not.toContain("new-key");
  });
  it("a late verification cannot override a newer use request", async () => {
    const first = deferred<{ device: "cpu" }>();
    const { manager } = setup({ verify: p => p.id === "whisper-base" ? first.promise : Promise.resolve({ device: "cpu" }) });
    manager.use({ id: "whisper-base" }); await settle();
    manager.use({ id: "paraformer-zh" }); await settle();
    first.resolve({ device: "cpu" }); await settle();
    expect(manager.active("speech")?.id).toBe("paraformer-zh");
  });
  it("runtime overrides stay on the model, replacement weights get an independent name", async () => {
    const { manager, state } = setup();
    manager.use({ id: "whisper-base", local: { ...local("whisper-base"), threads: 4 } }); await settle();
    expect(state().profiles.find(p => p.id === "whisper-base")?.local?.threads).toBe(4);
    expect(() => manager.use({ id: "whisper-base", local: { ...local("whisper-base"), model: "/own/model" } })).toThrow("Name");
    manager.use({ id: "whisper-base", name: "My model", local: { ...local("whisper-base"), model: "/own/model" } }); await settle();
    expect(manager.active("speech")?.name).toBe("My model");
    expect(state().profiles.find(p => p.id === "whisper-base")?.local?.threads).toBe(4);
    expect(manager.active("speech")?.local?.model).toBe("/own/model");
  });
  it("shows a managed path only once its file exists, and keeps a chosen one visible when it does not", async () => {
    const present = new Set<string>();
    const { manager, state } = setup({ exists: (path: string) => present.has(path) });
    const view = (id: string) => manager.view().models.find(m => m.id === id)!;
    expect(view("whisper-base").local).toEqual({ binary: "", model: "" });
    // Execution keeps the real destinations; only the settings view is blank.
    expect(manager.resolved(state().profiles.find(p => p.id === "whisper-base")!).local).toEqual(local("whisper-base"));
    present.add(local("whisper-base").binary);
    expect(view("whisper-base").local).toEqual({ binary: local("whisper-base").binary, model: "" });
    manager.use({ id: "whisper-base", name: "My model", local: { ...local("whisper-base"), model: "/own/model" } }); await settle();
    const custom = manager.view().models.find(m => m.custom)!;
    expect(custom.local?.model).toBe("/own/model");
  });
  it("a blank path keeps the managed file rather than clearing it or forking a custom model", async () => {
    const { manager, state } = setup({ exists: () => false });
    manager.use({ id: "paraformer-zh", local: { binary: "", model: "", device: "cpu" } }); await settle();
    expect(manager.active("speech")?.id).toBe("paraformer-zh");
    expect(manager.active("speech")?.local).toEqual({ ...local("paraformer-zh"), device: "cpu" });
    expect(state().profiles.some(p => p.custom)).toBe(false);
  });
  it("restoring automatic configuration keeps downloads and verifies the defaults", async () => {
    const { manager, deps } = setup();
    manager.use({ id: "whisper-base", local: { ...local("whisper-base"), threads: 4, device: "cpu" } }); await settle();
    manager.use({ id: "whisper-base", restore: true }); await settle();
    expect(manager.active("speech")?.local).toEqual(local("whisper-base"));
    expect(manager.view().models.find(p => p.id === "whisper-base")?.customized).toBe(false);
    expect(deps.verify).toHaveBeenCalledTimes(2);
  });
  it("waits for explicit component installation, then continues verification", async () => {
    let missing = true;
    const { manager, deps } = setup({ needsComponents: () => missing, installComponents: async () => { missing = false; } });
    manager.use({ id: "qwen3-vl-4b" }); await settle();
    expect(manager.view().operations[0]?.phase).toBe("needs_components");
    expect(deps.verify).not.toHaveBeenCalled();
    await manager.installComponents("qwen3-vl-4b");
    expect(manager.active("vlm")?.id).toBe("qwen3-vl-4b");
  });
  it("cancelling during verification prevents activation", async () => {
    const verify = deferred<{ device: "cpu" }>();
    const { manager } = setup({ verify: () => verify.promise });
    manager.use({ id: "whisper-base" }); await settle();
    manager.cancel("whisper-base"); verify.resolve({ device: "cpu" }); await settle();
    expect(manager.active("speech")).toBeNull();
  });
  it("reuses verification only for unchanged files and settings", async () => {
    let revision = "1";
    const { manager, deps } = setup({ fingerprint: () => revision });
    manager.use({ id: "whisper-base" }); await settle();
    manager.use({ id: "whisper-base" }); await settle();
    expect(deps.verify).toHaveBeenCalledTimes(1);
    revision = "2";
    expect(manager.view().models.find(m => m.id === "whisper-base")?.verified).toBe(false);
    manager.use({ id: "whisper-base" }); await settle();
    expect(deps.verify).toHaveBeenCalledTimes(2);
  });
  it("refuses a file changed while validation was running", async () => {
    let revision = "1"; const verify = deferred<{ device: "cpu" }>();
    const { manager } = setup({ fingerprint: () => revision, verify: () => verify.promise });
    manager.use({ id: "whisper-base" }); await settle(); revision = "2";
    verify.resolve({ device: "cpu" }); await settle();
    expect(manager.active("speech")).toBeNull();
    expect(manager.view().operations[0]?.error).toContain("changed during");
  });
  it("speech and vision prepare independently", async () => {
    const { manager } = setup();
    manager.use({ id: "whisper-base" }); manager.use({ id: "qwen3-vl-4b" }); await settle();
    expect(manager.active("speech")?.id).toBe("whisper-base"); expect(manager.active("vlm")?.id).toBe("qwen3-vl-4b");
  });
  it("endpoint identity changes create a separate profile only after verification", async () => {
    const verification = deferred<{ device: "cpu" }>();
    const { manager, state } = setup({ verify: () => verification.promise });
    manager.use({ id: "vlm-online", name: "My endpoint", endpoint: { url: "http://localhost:9000/v1/chat/completions", model: "vision" } });
    await settle();
    expect(state().profiles.find(p => p.id === "vlm-online")?.endpoint).toBeUndefined();
    expect(manager.active("vlm")).toBeNull();
    verification.resolve({ device: "cpu" }); await settle();
    expect(manager.active("vlm")?.id).toBe("custom-test");
    expect(state().profiles.find(p => p.id === "vlm-online")?.endpoint).toBeUndefined();
  });
  it("persistence failure rolls back both selection and credentials", async () => {
    const { manager, deps, keys } = setup();
    manager.use({ id: "whisper-base" }); await settle();
    keys.set("openai", "previous");
    const save = deps.store.set;
    deps.store.set = next => { if (next.active.speech === "openai-whisper") throw new Error("Disk full"); save(next); };
    manager.use({ id: "openai-whisper", apiKey: "replacement" }); await settle();
    expect(manager.active("speech")?.id).toBe("whisper-base");
    expect(keys.get("openai")).toBe("previous");
    expect(manager.view().operations[0]?.error).toBe("Disk full");
  });
});

describe("model library lifecycle", () => {
  it("saves a verified inactive profile without switching the active profile", async () => {
    const { manager, state } = setup();
    manager.use({ id: "whisper-base" }); await settle();
    manager.use({ id: "paraformer-zh", saveOnly: true }); await settle();
    expect(state().active.speech).toBe("whisper-base");
    expect(state().profiles.find(p => p.id === "paraformer-zh")?.verified).toBe(true);
  });
  it("saves a new custom profile independently and edits its endpoint in place", async () => {
    const { manager, state } = setup();
    manager.use({ id: "vlm-online", name: "Local", endpoint: { url: "http://localhost/v1/chat/completions", model: "first" }, saveOnly: true }); await settle();
    expect(state().active.vlm).toBeNull();
    manager.use({ id: "custom-test", name: "Renamed", endpoint: { url: "http://localhost/v1/chat/completions", model: "second" }, saveOnly: true }); await settle();
    expect(state().profiles.filter(p => p.custom)).toHaveLength(1);
    expect(state().profiles.find(p => p.id === "custom-test")?.endpoint?.model).toBe("second");
    expect(state().active.vlm).toBeNull();
  });
  it("None cancels pending activation while preserving credentials and files", async () => {
    const late = deferred<{ device: "cpu" }>(); const { manager, deps, keys, state } = setup();
    manager.use({ id: "openai-whisper", apiKey: "saved" }); await settle();
    deps.verify = () => late.promise;
    manager.use({ id: "whisper-base" }); await settle();
    manager.unselect("speech"); late.resolve({ device: "cpu" }); await settle();
    expect(state().active.speech).toBeNull(); expect(keys.get("openai")).toBe("saved");
    expect(state().profiles).toHaveLength(5); expect(deps.removeContent).not.toHaveBeenCalled();
  });
  it("removes the active custom profile and its key without deleting files", async () => {
    const { manager, deps, state, keys } = setup();
    manager.use({ id: "openai-whisper", createCustom: true, name: "My service", apiKey: "secret" }); await settle();
    manager.removeCustom("custom-test");
    expect(state().active.speech).toBeNull();
    expect(state().profiles.some(p => p.id === "custom-test")).toBe(false);
    expect(keys.get("model-custom-test")).toBe("");
    expect(deps.removeContent).not.toHaveBeenCalled();
    expect(() => manager.removeCustom("whisper-base")).toThrow("Only custom");
  });
  it("rolls back active custom removal if credential persistence fails", async () => {
    const { manager, deps, state } = setup();
    manager.use({ id: "openai-whisper", createCustom: true, name: "My service", apiKey: "secret" }); await settle();
    const setKey = deps.setKey; deps.setKey = (tag, value) => { if (!value) throw new Error("Key store unavailable"); setKey(tag, value); };
    expect(() => manager.removeCustom("custom-test")).toThrow("Key store unavailable");
    expect(state().active.speech).toBe("custom-test");
    expect(state().profiles.some(p => p.id === "custom-test")).toBe(true);
  });
  it("clears only unshared artifacts and unselects the target without removing its configuration", async () => {
    const { manager, deps, state } = setup({ referencesContent: (p, id) => p.custom === true && id === "whisper-cpp-runtime" });
    manager.use({ id: "whisper-base", createCustom: true, name: "Shared runtime", local: { binary: local("whisper-base").binary, model: "/own/weights" }, saveOnly: true }); await settle();
    manager.use({ id: "whisper-base" }); await settle();
    manager.clearDownloads("whisper-base");
    expect(state().active.speech).toBeNull();
    expect(state().profiles.some(p => p.id === "whisper-base")).toBe(true);
    expect(deps.removeContent).toHaveBeenCalledExactlyOnceWith("whisper-model-base");
  });
  it("refuses deletion during file use and preserves the current selection", async () => {
    const { manager, deps, state } = setup({ assertContentIdle: () => { throw new Error("in use"); } });
    manager.use({ id: "whisper-base" }); await settle();
    expect(() => manager.clearDownloads("whisper-base")).toThrow("in use");
    expect(state().active.speech).toBe("whisper-base"); expect(deps.removeContent).not.toHaveBeenCalled();
  });
  it("a failed deletion leaves None and never restarts a download", async () => {
    const { manager, deps, state } = setup({ removeContent: () => { throw new Error("locked file"); } });
    manager.use({ id: "whisper-base" }); await settle(); vi.mocked(deps.ensureContent).mockClear();
    expect(() => manager.clearDownloads("whisper-base")).toThrow("locked file");
    expect(state().active.speech).toBeNull(); expect(deps.ensureContent).not.toHaveBeenCalled();
  });
  it("legacy content removal cannot bypass model references", () => {
    const { manager, deps } = setup();
    expect(() => manager.removeUnusedContent("whisper-model-base")).toThrow("model library");
    expect(deps.removeContent).not.toHaveBeenCalled();
  });
});
