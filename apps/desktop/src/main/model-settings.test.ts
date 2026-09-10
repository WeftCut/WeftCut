import { describe, expect, it } from "vitest";
import { createModelSettingsStore, freshModelSettings, migrateModelSettings } from "./model-settings";
import { modelProfileToVlmSnapshot } from "./vlm-config";
import { VLM_CONFIG_DEFAULTS } from "../shared/vlm-config";

const managed = (id: string) => ({ binary: `C:/managed/${id}/run.exe`, model: `C:/managed/${id}/model` });
describe("model settings migration", () => {
  it("persists an explicit None across restart even when verified profiles remain", () => {
    const files = new Map<string, string>();
    const factory = () => createModelSettingsStore({ dir: "/config", path: "/config/models.json", migrate: freshModelSettings,
      fs: { exists: p => files.has(p), readFile: p => files.get(p)!, writeFile: (p, s) => { files.set(p, s); }, rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a); }, mkdirp: () => {} } });
    const store = factory(), state = store.get();
    state.profiles[0]!.verified = true;
    state.active.speech = "whisper-base"; store.set(state);
    state.active.speech = null; store.set(state);
    const restored = factory().get();
    expect(restored.active).toEqual({ speech: null, vlm: null });
    expect(restored.profiles[0]?.verified).toBe(true);
  });
  it("keeps a fresh installation inactive", () => {
    const next = migrateModelSettings({ speech: { preferred_engine: "auto", local: {} }, vlm: VLM_CONFIG_DEFAULTS,
      managedLocal: managed, exists: () => true, hasKey: () => false, copyKey: () => {} });
    expect(next.active).toEqual({ speech: null, vlm: null });
  });
  it("preserves manual model paths and resolves legacy auto only once", () => {
    const next = migrateModelSettings({ speech: { preferred_engine: "auto", local: { whisper_cpp: { binary: "C:/my/run.exe", model: "D:/my/model.bin" } } },
      vlm: VLM_CONFIG_DEFAULTS, managedLocal: managed, exists: () => true, hasKey: () => true, copyKey: () => {} });
    expect(next.active.speech).toBe("openai-whisper");
    expect(next.profiles.find(p => p.id === "custom-legacy-whisper_cpp")?.local?.model).toBe("D:/my/model.bin");
    expect(next.profiles.find(p => p.id === "whisper-base")?.custom).toBeUndefined();
  });
  it("keeps an explicit unavailable selection instead of switching to a cloud key", () => {
    const next = migrateModelSettings({ speech: { preferred_engine: "whisper_cpp", local: {} }, vlm: VLM_CONFIG_DEFAULTS,
      managedLocal: managed, exists: () => false, hasKey: () => true, copyKey: () => {} });
    expect(next.active.speech).toBe("whisper-base");
  });
  it("recognizes managed files and retains their tuning", () => {
    const next = migrateModelSettings({ speech: { preferred_engine: "whisper_cpp", local: { whisper_cpp: { ...managed("whisper-base"), threads: 8 } } },
      vlm: VLM_CONFIG_DEFAULTS, managedLocal: managed, exists: () => true, hasKey: () => false, copyKey: () => {} });
    expect(next.active.speech).toBe("whisper-base");
    expect(next.profiles.find(p => p.id === "whisper-base")?.local?.threads).toBe(8);
  });
  it("moves an endpoint to an independent credential tag without copying its secret into config", () => {
    const copies: string[][] = [];
    const next = migrateModelSettings({ speech: { preferred_engine: "auto", local: {} },
      vlm: { ...VLM_CONFIG_DEFAULTS, preferred_engine: "byo_endpoint", endpoint: { url: "http://localhost/v1/chat/completions", model: "my-model" } },
      managedLocal: managed, exists: () => true, hasKey: () => false, copyKey: (a, b) => { copies.push([a, b]); } });
    expect(next.active.vlm).toBe("custom-legacy-endpoint");
    expect(copies).toEqual([["vlm_endpoint", "model-custom-legacy-endpoint"]]);
    expect(next.profiles.find(p => p.id === next.active.vlm)?.name).toBe("my-model");
  });
  // A legacy VLM engine configured one field at a time could be saved with a
  // blank projector. Migration keeps the explicit selection (files disappearing
  // must never re-pick a model) and carries the blank through — but the RELOAD
  // sanitizes a blank path away, so from the second launch on the ACTIVE
  // profile legitimately has no `mmproj` key at all. `mmproj` is required by the
  // Rust `BackendConfig::Local`, so the snapshot must still carry it as an
  // empty path: omit the field and serde rejects the whole map, turning one
  // under-configured model into an unparseable config for every describe.
  it("keeps a legacy vision selection whose projector was never configured", () => {
    const files = new Map<string, string>();
    const store = () => createModelSettingsStore({ dir: "/config", path: "/config/models.json",
      migrate: () => migrateModelSettings({ speech: { preferred_engine: "auto", local: {} },
        vlm: { ...VLM_CONFIG_DEFAULTS, preferred_engine: "qwen3_vl", local: { qwen3_vl: { binary: "C:/my/llama.exe", model: "C:/my/q.gguf", mmproj: "" } } },
        managedLocal: managed, exists: () => true, hasKey: () => false, copyKey: () => {} }),
      fs: { exists: p => files.has(p), readFile: p => files.get(p)!, writeFile: (p, s) => { files.set(p, s); }, rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a); }, mkdirp: () => {} } });
    expect(store().get().active.vlm).toBe("custom-legacy-qwen3_vl");
    const reloaded = store().get();
    expect(reloaded.active.vlm).toBe("custom-legacy-qwen3_vl");
    const profile = reloaded.profiles.find(p => p.id === reloaded.active.vlm)!;
    expect(profile.local?.mmproj).toBeUndefined();
    expect(modelProfileToVlmSnapshot(profile).qwen3_vl).toEqual({
      kind: "local", binary: "C:/my/llama.exe", model: "C:/my/q.gguf", mmproj: "",
    });
  });
  it("reloads custom models while refusing forged catalog and credential references", () => {
    const files = new Map<string, string>();
    const factory = () => createModelSettingsStore({ dir: "/config", path: "/config/models.json", migrate: freshModelSettings,
      fs: { exists: p => files.has(p), readFile: p => files.get(p)!, writeFile: (p, s) => { files.set(p, s); }, rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a); }, mkdirp: () => {} } });
    const store = factory(); const state = store.get();
    state.profiles.push({ id: "custom-legacy-qwen3_vl", name: "Own model", family: "vlm", backend: "byo_endpoint", locality: "online", custom: true,
      artifacts: ["evil-runtime"], keyTag: "openai", endpoint: { url: "http://local/v1/chat/completions", model: "a" } });
    state.active.vlm = "custom-legacy-qwen3_vl"; store.set(state);
    const restored = factory().get();
    expect(restored.active.vlm).toBe("custom-legacy-qwen3_vl");
    const custom = restored.profiles.find(p => p.id === "custom-legacy-qwen3_vl")!;
    expect(custom.artifacts).toEqual([]); expect(custom.keyTag).toBe("model-custom-legacy-qwen3_vl");
  });
});
