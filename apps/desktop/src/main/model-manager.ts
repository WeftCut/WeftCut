import { MODEL_DEFINITIONS, type ModelFamily, type ModelLocalConfig, type ModelOperation, type ModelProfile, type ModelsView, type ModelUseRequest } from "../shared/inference-models";
import { cleanModelLocal, sameModelFiles, withKnownPaths, type ModelSettingsStore } from "./model-settings";

export interface ModelManagerDeps {
  store: ModelSettingsStore;
  managedLocal(id: string): ModelLocalConfig;
  content(id: string): { installed: boolean; supported: boolean; bytes: number; receivedBytes: number };
  ensureContent(ids: readonly string[], signal: AbortSignal): Promise<void>;
  cancelContent(id: string): void;
  downloadedBytes(id: string): number;
  referencesContent(profile: ModelProfile, id: string): boolean;
  assertContentIdle(ids: readonly string[]): void;
  removeContent(id: string): void;
  exists(path: string): boolean;
  getKey(tag: string): string;
  setKey(tag: string, value: string): void;
  needsComponents(profile: ModelProfile): boolean;
  installComponents(): Promise<void>;
  verify(profile: ModelProfile, key: string, signal: AbortSignal): Promise<{ device: "cpu" | "auto" | "fixed" }>;
  fingerprint(profile: ModelProfile): string;
  /** Synchronize the committed active profiles into the legacy execution boundary. */
  applyActive(): void;
  changed(): void;
  uuid(): string;
}

type Pending = { request: ModelUseRequest; profile: ModelProfile; key: string; controller: AbortController; operation: ModelOperation };
export class ModelManager {
  private pending = new Map<ModelFamily, Pending>();
  constructor(private readonly deps: ModelManagerDeps) {}

  resolved(p: ModelProfile): ModelProfile {
    return p.locality === "local" ? { ...p, local: { ...this.deps.managedLocal(p.id), ...p.local } } : { ...p };
  }
  /** What the settings fields may show. A managed path is a prediction of where
   * a download will land, so until that file is there the field is blank rather
   * than naming a file the user does not have. A path the user chose is
   * reported verbatim, present or not: that field is where they can correct it.
   * Execution reads `resolved` instead, which always carries the real paths. */
  private reported(id: string, local: ModelLocalConfig): ModelLocalConfig {
    const managed = this.deps.managedLocal(id);
    const out = { ...local };
    for (const key of ["binary", "model", "tokens", "mmproj"] as const) {
      const value = out[key];
      if (value && value === managed[key] && !this.deps.exists(value)) out[key] = "";
    }
    return out;
  }
  active(family: ModelFamily): ModelProfile | null {
    const cfg = this.deps.store.get();
    const p = cfg.profiles.find(p => p.id === cfg.active[family]);
    return p ? this.resolved(p) : null;
  }
  view(): ModelsView {
    const cfg = this.deps.store.get();
    return {
      active: cfg.active,
      models: cfg.profiles.map(stored => {
        const p = this.resolved(stored);
        const content = p.artifacts.map(id => this.deps.content(id));
        const lc = p.local;
        const installed = p.locality === "online" ? true : !!lc?.binary && !!lc.model && this.deps.exists(lc.binary) && this.deps.exists(lc.model) &&
          (p.backend !== "funasr" || !!lc.tokens && this.deps.exists(lc.tokens)) &&
          (p.family !== "vlm" || !!lc.mmproj && this.deps.exists(lc.mmproj)) && content.every(c => c.installed);
        return { ...p, ...(lc ? { local: this.reported(p.id, lc) } : {}),
          verified: !!p.verified && p.verificationFingerprint === this.deps.fingerprint(p),
          active: cfg.active[p.family] === p.id, installed, supported: content.every(c => c.supported),
          missingBytes: content.filter(c => !c.installed).reduce((s, c) => s + c.bytes, 0),
          hasKey: !!p.keyTag && !!this.deps.getKey(p.keyTag),
          customized: !!stored.custom || !!stored.local,
          downloadedBytes: p.artifacts.reduce((sum, id) => sum + this.deps.downloadedBytes(id), 0),
        };
      }),
      operations: [...this.pending.values()].map(p => {
        const c = p.profile.artifacts.map(id => this.deps.content(id));
        const bytes = c.reduce((s, x) => s + x.bytes, 0);
        return { ...p.operation, ...(p.operation.phase === "downloading" && bytes > 0 ?
          { progress: Math.min(1, c.reduce((s, x) => s + (x.installed ? x.bytes : x.receivedBytes), 0) / bytes) } : {}) };
      }),
    };
  }

  use(request: ModelUseRequest): void {
    const original = this.deps.store.get().profiles.find(p => p.id === request.id);
    if (!original) throw new Error("Unknown model");
    let candidate = this.resolved(original);
    const key = request.apiKey === undefined ? this.deps.getKey(original.keyTag ?? "") : request.apiKey.trim();
    if (request.restore) {
      if (original.custom) throw new Error("Custom models have no automatic configuration");
      candidate = { ...MODEL_DEFINITIONS.find(d => d.id === original.id)!, keyTag: original.keyTag };
      candidate = this.resolved(candidate);
    } else {
      if (request.local && original.locality === "local") candidate.local = withKnownPaths(cleanModelLocal(request.local), candidate.local);
      if (request.endpoint && original.backend === "byo_endpoint") {
        const url = new URL(request.endpoint.url.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) endpoint without embedded credentials");
        if (!request.endpoint.model.trim()) throw new Error("Enter a model name");
        candidate.endpoint = { url: url.href, model: request.endpoint.model.trim() };
      }
    }
    const filesChanged = !!candidate.local && !!this.resolved(original).local && !sameModelFiles(candidate.local, this.resolved(original).local!);
    const endpointChanged = !!candidate.endpoint && (candidate.endpoint.model !== original.endpoint?.model || candidate.endpoint.url !== original.endpoint?.url);
    if (request.createCustom || !original.custom && (filesChanged || endpointChanged)) {
      if (!request.name?.trim()) throw new Error("Name the custom model");
      const id = `custom-${this.deps.uuid()}`;
      candidate = { ...candidate, id, custom: true, artifacts: [], name: request.name.trim().slice(0, 120), keyTag: `model-${id}` };
      if (request.backend && candidate.locality === "local") {
        const allowed = candidate.family === "speech" ? ["whisper_cpp", "funasr"] : ["qwen3_vl", "minicpm_v"];
        if (!allowed.includes(request.backend)) throw new Error("Unsupported runtime for this model family");
        candidate.backend = request.backend;
      }
    } else if (original.custom && request.name?.trim()) candidate.name = request.name.trim().slice(0, 120);
    if (candidate.backend === "openai" && !key) throw new Error("Enter an API key");
    if (candidate.backend === "byo_endpoint" && !candidate.endpoint?.url) throw new Error("Configure the endpoint in advanced settings");
    // An explicit subsequent action cancels activation, not shared downloads.
    this.pending.get(original.family)?.controller.abort();
    const pending: Pending = { request, profile: candidate, key, controller: new AbortController(),
      operation: { id: original.id, family: original.family, phase: "downloading" } };
    this.pending.set(original.family, pending);
    this.deps.changed();
    void this.prepare(pending);
  }

  cancel(id: string): void {
    const p = [...this.pending.values()].find(p => p.operation.id === id);
    if (!p) return;
    p.controller.abort();
    this.pending.delete(p.profile.family);
    const retained = new Set([...this.pending.values()].flatMap(x => [...x.profile.artifacts]));
    for (const artifact of p.profile.artifacts) if (!retained.has(artifact)) this.deps.cancelContent(artifact);
    this.deps.changed();
  }

  async installComponents(id: string): Promise<void> {
    const p = [...this.pending.values()].find(p => p.operation.id === id);
    if (!p || p.operation.phase !== "needs_components") throw new Error("No component installation is pending");
    p.operation.phase = "installing_components";
    this.deps.changed();
    try {
      await this.deps.installComponents();
      if (!this.current(p)) return;
      if (this.deps.needsComponents(p.profile)) throw new Error("Runtime installation is incomplete. Restart Windows if the installer requested it, then retry.");
      await this.prepare(p);
    } catch (e) { this.fail(p, e); }
  }

  removeCustom(id: string): void {
    const cfg = this.deps.store.get();
    const p = cfg.profiles.find(p => p.id === id);
    if (!p?.custom) throw new Error("Only custom entries can be removed");
    this.cancel(id);
    if (cfg.active[p.family] === id) {
      const pending = this.pending.get(p.family);
      if (pending) this.cancel(pending.operation.id);
    }
    const previous = structuredClone(cfg);
    cfg.profiles = cfg.profiles.filter(p => p.id !== id);
    if (cfg.active[p.family] === id) cfg.active[p.family] = null;
    const key = p.keyTag ? this.deps.getKey(p.keyTag) : "";
    try {
      this.deps.store.set(cfg);
      this.deps.applyActive();
      if (p.keyTag && !cfg.profiles.some(other => other.keyTag === p.keyTag)) this.deps.setKey(p.keyTag, "");
    } catch (e) {
      this.deps.store.set(previous);
      if (p.keyTag) this.deps.setKey(p.keyTag, key);
      this.deps.applyActive();
      throw e;
    }
    this.deps.changed();
  }

  unselect(family: ModelFamily): void {
    if (family !== "speech" && family !== "vlm") throw new Error("Unknown model family");
    const pending = this.pending.get(family);
    if (pending) this.cancel(pending.operation.id);
    const previous = this.deps.store.get();
    const next = structuredClone(previous);
    next.active[family] = null;
    try { this.deps.store.set(next); this.deps.applyActive(); }
    catch (e) { this.deps.store.set(previous); this.deps.applyActive(); throw e; }
    this.deps.changed();
  }

  clearDownloads(id: string): void {
    const cfg = this.deps.store.get();
    const target = cfg.profiles.find(p => p.id === id);
    if (!target) throw new Error("Unknown model");
    this.cancel(id);
    const retained = [...cfg.profiles.filter(p => p.id !== id).map(p => this.resolved(p)),
      ...[...this.pending.values()].map(p => p.profile)];
    const removable = target.artifacts.filter(artifact => !retained.some(p =>
      p.artifacts.includes(artifact) || this.deps.referencesContent(p, artifact)));
    this.deps.assertContentIdle(removable);
    if (cfg.active[target.family] === id) this.unselect(target.family);
    // Commit None before touching files; a failed deletion must never leave an
    // active profile pointing at partially removed downloads.
    try { for (const artifact of removable) this.deps.removeContent(artifact); }
    finally { this.deps.changed(); }
  }

  private current(p: Pending): boolean { return !p.controller.signal.aborted && this.pending.get(p.profile.family) === p; }
  private fail(p: Pending, e: unknown): void {
    if (!this.current(p)) return;
    let message = e instanceof Error ? e.message : String(e);
    // Never emit credentials even if a remote provider echoes one in an error.
    if (p.key) message = message.replaceAll(p.key, "[redacted]");
    p.operation = { ...p.operation, phase: "error", error: message };
    this.deps.changed();
  }
  private async prepare(p: Pending): Promise<void> {
    try {
      if (!this.current(p)) return;
      p.operation.phase = "downloading";
      this.deps.changed();
      await this.deps.ensureContent(p.profile.artifacts, p.controller.signal);
      if (!this.current(p)) return;
      if (this.deps.needsComponents(p.profile)) {
        p.operation.phase = "needs_components";
        this.deps.changed();
        return;
      }
      p.operation.phase = "verifying";
      this.deps.changed();
      const fingerprint = this.deps.fingerprint(p.profile);
      const unchanged = p.profile.verified && p.profile.verificationFingerprint === fingerprint &&
        p.key === this.deps.getKey(p.profile.keyTag ?? "");
      const result = unchanged ? { device: p.profile.executionDevice ?? "auto" as const } : await this.deps.verify(p.profile, p.key, p.controller.signal);
      if (!this.current(p)) return;
      if (fingerprint !== this.deps.fingerprint(p.profile)) throw new Error("Model files changed during verification. Retry with the current files.");
      const cfg = this.deps.store.get();
      const previous = structuredClone(cfg);
      const candidate = { ...p.profile, verified: true, verificationFingerprint: fingerprint, executionDevice: result.device };
      // Built-in paths are derived from the catalog unless actually overridden.
      if (!candidate.custom && candidate.local && JSON.stringify(candidate.local) === JSON.stringify(this.deps.managedLocal(candidate.id))) delete candidate.local;
      const i = cfg.profiles.findIndex(x => x.id === candidate.id);
      if (i < 0) cfg.profiles.push(candidate); else cfg.profiles[i] = candidate;
      if (!p.request.saveOnly) cfg.active[candidate.family] = candidate.id;
      // Synchronous commit after verification: no request can observe a half-prepared candidate.
      const oldKey = candidate.keyTag ? this.deps.getKey(candidate.keyTag) : "";
      if (candidate.keyTag) this.deps.setKey(candidate.keyTag, p.key);
      try { this.deps.store.set(cfg); this.deps.applyActive(); }
      catch (e) {
        if (candidate.keyTag) this.deps.setKey(candidate.keyTag, oldKey);
        this.deps.store.set(previous);
        this.deps.applyActive();
        throw e;
      }
      this.pending.delete(candidate.family);
      this.deps.changed();
    } catch (e) { this.fail(p, e); }
  }
}
