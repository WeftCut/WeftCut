import { describe, expect, it } from "vitest";
import { createModelSettingsStore, freshModelSettings, migrateModelSettings } from "./model-settings";
import { VLM_CONFIG_DEFAULTS } from "../shared/vlm-config";

const managed = (id: string) => ({ binary: `C:/managed/${id}/run.exe`, model: `C:/managed/${id}/model` });
describe("model settings migration", () => {
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
