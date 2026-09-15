import path from "node:path";
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import type { Backend } from "@weftcut/core";
import { CONTENT_CATALOG } from "../shared/content-catalog";
import { MODEL_DEFINITIONS, type ModelLocalConfig } from "../shared/inference-models";
import type { ContentPlatformKey } from "../shared/content-download";
import { ModelManager } from "./model-manager";
import { createModelSettingsStore, migrateModelSettings } from "./model-settings";
import { type ContentDeps, itemStatus } from "./contentDownload";
import type { ContentQueue } from "./contentQueue";
import type { SpeechConfigStore, SpeechConfigFs } from "./speech-config";
import type { VlmConfigStore } from "./vlm-config";
import { loadAllKeys, setKey } from "./keys";
import { installModelComponents, missingModelComponents } from "./model-components";
import { createModelDownloads } from "./model-downloads";
import { assertModelsIdle, beginModelUse } from "./model-usage";

export function createModelFeature(deps: {
  dir: string; cacheDir: string; atomicFs: SpeechConfigFs;
  content: ContentDeps; platform: ContentPlatformKey | null; queue: ContentQueue;
  speech: SpeechConfigStore; vlm: VlmConfigStore; backend: Backend;
  changed(): void;
  activated(): void;
}): ModelManager {
  // Where a managed profile's files land once downloaded. The paths come from
  // THIS platform's artifacts, so an unsupported platform yields the blank
  // config its `supported: false` row already implies rather than a set of
  // foreign paths that will never exist.
  const managedLocal = (id: string): ModelLocalConfig => {
    const config: ModelLocalConfig = { binary: "", model: "" };
    for (const artifact of MODEL_DEFINITIONS.find(d => d.id === id)?.artifacts ?? []) {
      const item = CONTENT_CATALOG.find(c => c.id === artifact)!;
      const fields = (deps.platform ? item.platforms[deps.platform]?.fields : undefined) ?? {};
      for (const [field, relative] of Object.entries(fields)) {
        (config as unknown as Record<string, string>)[field] = path.join(deps.content.downloadsDir, item.id, item.version, relative);
      }
    }
    return config;
  };
  const getKey = (tag: string) => loadAllKeys()[tag] ?? "";
  const persistKey = (tag: string, value: string) => {
    setKey(tag, value);
    if (getKey(tag) !== value.trim()) throw new Error("Could not save the model credential");
  };
  const store = createModelSettingsStore({
    fs: deps.atomicFs, path: path.join(deps.dir, "model_settings.json"), dir: deps.dir,
    migrate: () => migrateModelSettings({ speech: deps.speech.get(), vlm: deps.vlm.get(), managedLocal,
      exists: fs.existsSync, hasKey: tag => !!getKey(tag),
      copyKey: (from, to) => { if (getKey(from)) persistKey(to, getKey(from)); },
    }),
  });
  const applyActive = () => {
    const p = manager.active("speech");
    if (p) {
      // A projection for existing IPC/readers; the model store owns the selection.
      deps.speech.apply({ preferred_engine: p.backend as "whisper_cpp" | "funasr" | "openai" });
      if (p.local) {
        const l = p.local;
        deps.speech.apply({ local: { backend: p.backend, config: l } });
        deps.backend.setLocalBackend(p.backend, l.binary, l.model, l.device ?? null, l.threads ?? null, l.tokens ?? null);
      } else deps.backend.setCloudKey("openai", getKey(p.keyTag ?? "openai"));
    }
    const v = manager.active("vlm");
    if (v) {
      deps.vlm.apply({ preferred_engine: v.backend as "qwen3_vl" | "minicpm_v" | "byo_endpoint" });
      if (v.local) deps.vlm.apply({ local: { backend: v.backend, config: { ...v.local, mmproj: v.local.mmproj ?? "" } } });
      if (v.endpoint) deps.vlm.apply({ endpoint: v.endpoint });
    }
    deps.activated();
  };
  const manager = new ModelManager({
    store, managedLocal,
    ...createModelDownloads(deps.content),
    assertContentIdle: ids => {
      if (!ids.length) return;
      assertModelsIdle();
      if (ids.some(id => deps.queue.isPending(id))) throw new Error("Download is stopping or still in progress. Retry after it finishes.");
    },
    content: id => {
      const item = CONTENT_CATALOG.find(c => c.id === id)!;
      const status = itemStatus(deps.content, item, deps.platform);
      return { installed: status.state === "installed", supported: status.state !== "unavailable",
        bytes: (deps.platform ? item.platforms[deps.platform]?.bytes : 0) ?? 0,
        receivedBytes: deps.queue.entryOf(id)?.receivedBytes ?? 0 };
    },
    ensureContent: (ids, signal) => deps.queue.ensure(ids, signal),
    cancelContent: id => deps.queue.cancel(id),
    exists: fs.existsSync, getKey, setKey: persistKey,
    needsComponents: p => missingModelComponents(p),
    fingerprint: p => {
      const files = [p.local?.binary, p.local?.model, p.local?.tokens, p.local?.mmproj].filter((s): s is string => !!s).map(file => {
        try { const st = fs.statSync(file); return [file, st.size, st.mtimeMs]; } catch { return [file, null]; }
      });
      return createHash("sha256").update(JSON.stringify({ backend: p.backend, local: p.local, endpoint: p.endpoint, files })).digest("hex");
    },
    installComponents: () => installModelComponents(deps.cacheDir),
    verify: async (p, key, signal) => {
      const bundledSpeech = !p.custom && p.family === "speech" && p.locality === "local" && p.local?.binary === managedLocal(p.id).binary;
      if (bundledSpeech && p.local?.device && p.local.device !== "cpu") {
        throw new Error("This bundled speech runtime supports CPU only. Choose Automatic or CPU, or configure a custom runtime.");
      }
      const requestId = randomUUID();
      const cancel = () => { void deps.backend.invoke("settings_cancel_model_verification", JSON.stringify({ requestId })).catch(() => {}); };
      signal.throwIfAborted();
      signal.addEventListener("abort", cancel, { once: true });
      let result: string;
      // An absent key must stay absent: the endpoint describer sends an
      // `Authorization` header for any `Some(_)`, so `""` would verify a
      // self-hosted server with a bare `Bearer ` that the real run never sends.
      const release = beginModelUse();
      try { result = await deps.backend.invoke("settings_verify_model", JSON.stringify({ requestId, family: p.family, backend: p.backend, local: p.local, endpoint: p.endpoint, ...(key ? { apiKey: key } : {}) })); }
      finally { release(); signal.removeEventListener("abort", cancel); }
      const verified = JSON.parse(result) as { device: "cpu" | "auto" | "fixed" };
      if (bundledSpeech) verified.device = "cpu";
      return verified;
    },
    applyActive, changed: deps.changed, uuid: randomUUID,
  });
  applyActive();
  return manager;
}
