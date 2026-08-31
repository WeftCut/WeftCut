// VLM (video-understanding) backend config persisted at <userData>/vlm_config.json,
// owned by the Electron main process. Twin of src/main/speech-config.ts.
//
// NON-secret ONLY: the preferred engine + each local engine's binary/model/mmproj
// paths (+ device) + the endpoint URL/model. The endpoint's optional API key is a
// credential and lives in safeStorage (keys.ts / cloud_keys.json under
// VLM_ENDPOINT_KEY_TAG) — NEVER here. Earlier builds did persist it here in
// plaintext; `takeLegacyEndpointKey` below is the one-shot move.
//
// The on-disk file path + JSON field names are a COMPATIBILITY SURFACE: once a
// user has a vlm_config.json it must keep loading, so neither may change without
// a migration. Bad-config recovery: a missing / empty / corrupt file, or one from
// an older build lacking a field, degrades to defaults.
//
// `toVlmBackendSnapshot` is the pure merge that turns this store's config + the
// safeStorage endpoint key into the tagged `HashMap<String, BackendConfig>` JSON
// the stateless Rust describe_clip resolver reads (via the injected `vlm_config`
// arg).

import {
  VLM_CONFIG_DEFAULTS,
  VLM_PREFERRED_ENGINES,
  type VlmConfig,
  type VlmConfigPatch,
  type VlmPreferredEngine,
  type VlmLocalEngineConfig,
  type VlmEndpointConfig,
} from "../shared/vlm-config";

/** Minimal fs surface — injected so tests run in-memory; node:fs in production.
 *  Mirrors SpeechConfigFs (atomic tmp-then-rename write). */
export interface VlmConfigFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

export interface VlmConfigStore {
  get(): VlmConfig;
  /** Apply a patch atomically; returns the post-patch config. */
  apply(patch: VlmConfigPatch): VlmConfig;
  /** One-shot migration for a plaintext `endpoint.api_key` written by a build
   *  that persisted it here. Returns the key and scrubs it from disk, so the
   *  caller can move it into safeStorage; `null` when there is nothing to move
   *  (the normal case, and every call after the first). Never throws. */
  takeLegacyEndpointKey(): string | null;
}

function isPreferred(v: unknown): v is VlmPreferredEngine {
  return typeof v === "string" && (VLM_PREFERRED_ENGINES as readonly string[]).includes(v);
}

/// Coerce one on-disk local-engine entry into a valid `VlmLocalEngineConfig`, or
/// `null` when it has no usable paths. Trims paths verbatim (no lowercasing —
/// display stays faithful, OS casing preserved); drops empty device.
function readLocalEntry(raw: unknown): VlmLocalEngineConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const binary = typeof o.binary === "string" ? o.binary.trim() : "";
  const model = typeof o.model === "string" ? o.model.trim() : "";
  const mmproj = typeof o.mmproj === "string" ? o.mmproj.trim() : "";
  if (binary === "" && model === "" && mmproj === "") return null;
  const out: VlmLocalEngineConfig = { binary, model, mmproj };
  if (typeof o.device === "string" && o.device.trim() !== "") out.device = o.device.trim();
  return out;
}

/// Coerce an endpoint entry, or `null` when it has no URL. An `api_key` on the
/// raw object is IGNORED here — reading it back would put the credential into
/// every snapshot this store hands out. `takeLegacyEndpointKey` is the one reader
/// of that legacy field, and it deletes it.
function readEndpoint(raw: unknown): VlmEndpointConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (url === "") return null;
  const out: VlmEndpointConfig = { url };
  if (typeof o.model === "string" && o.model.trim() !== "") out.model = o.model.trim();
  return out;
}

export function createVlmConfigStore(deps: {
  fs: VlmConfigFs;
  path: string;
  dir: string;
}): VlmConfigStore {
  function read(): VlmConfig {
    if (!deps.fs.exists(deps.path)) return { preferred_engine: "auto", local: {} };
    let body: string;
    try {
      body = deps.fs.readFile(deps.path);
    } catch (e) {
      console.warn(`[vlm-config] read ${deps.path}:`, e);
      return { preferred_engine: "auto", local: {} };
    }
    if (body.trim() === "") return { preferred_engine: "auto", local: {} };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[vlm-config] parse ${deps.path}:`, e);
      return { preferred_engine: "auto", local: {} };
    }
    // Per-field defaulting (the ONE backfill point): a missing / wrong-typed
    // preferred_engine falls back to "auto" so the selector is never undefined.
    const preferred_engine: VlmPreferredEngine = isPreferred(parsed.preferred_engine)
      ? parsed.preferred_engine
      : VLM_CONFIG_DEFAULTS.preferred_engine;
    const local: Record<string, VlmLocalEngineConfig> = {};
    if (parsed.local && typeof parsed.local === "object") {
      for (const [tag, raw] of Object.entries(parsed.local as Record<string, unknown>)) {
        const entry = readLocalEntry(raw);
        if (entry) local[tag] = entry;
      }
    }
    const out: VlmConfig = { preferred_engine, local };
    const endpoint = readEndpoint(parsed.endpoint);
    if (endpoint) out.endpoint = endpoint;
    return out;
  }

  function write(cfg: VlmConfig): void {
    deps.fs.mkdirp(deps.dir);
    const tmp = deps.path + ".tmp";
    deps.fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
    deps.fs.rename(tmp, deps.path); // atomic promote
  }

  return {
    get: read,
    apply(patch) {
      const current = read();
      if (patch.preferred_engine !== undefined && isPreferred(patch.preferred_engine)) {
        current.preferred_engine = patch.preferred_engine;
      }
      if (patch.local !== undefined) {
        if (patch.local.config === null) {
          delete current.local[patch.local.backend];
        } else {
          const entry = readLocalEntry(patch.local.config);
          if (entry) current.local[patch.local.backend] = entry;
          else delete current.local[patch.local.backend];
        }
      }
      if (patch.endpoint !== undefined) {
        if (patch.endpoint === null) delete current.endpoint;
        else {
          const ep = readEndpoint(patch.endpoint);
          if (ep) current.endpoint = ep;
          else delete current.endpoint;
        }
      }
      write(current);
      return current;
    },
    takeLegacyEndpointKey() {
      // Read the RAW file, not read() — read() drops `api_key` by design, so
      // this is the only place the legacy field is visible.
      if (!deps.fs.exists(deps.path)) return null;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(deps.fs.readFile(deps.path)) as Record<string, unknown>;
      } catch {
        return null; // corrupt file: read() already degrades to defaults
      }
      const ep = parsed.endpoint;
      if (!ep || typeof ep !== "object") return null;
      const raw = (ep as Record<string, unknown>).api_key;
      const key = typeof raw === "string" ? raw.trim() : "";
      // Rewrite unconditionally when the field is PRESENT — a blank or
      // wrong-typed leftover is still a field that should not linger. Writing
      // read()'s output is the scrub: it never carries `api_key`.
      if (!("api_key" in (ep as Record<string, unknown>))) return null;
      write(read());
      return key === "" ? null : key;
    },
  };
}

/// The tagged `BackendConfig` JSON shapes the Rust `vlm::config::BackendConfig`
/// enum deserializes (`#[serde(tag = "kind", rename_all = "snake_case")]`).
type BackendConfigJson =
  | { kind: "local"; binary: string; model: string; mmproj: string; device?: string }
  | { kind: "endpoint"; url: string; api_key?: string; model?: string };

/// Merge the non-secret store config + the secret endpoint key into the
/// `Record<backendTag, BackendConfig>` snapshot the stateless describe_clip
/// resolver reads. Keyed by the Rust `VlmBackend::as_str` tags. Pure — the
/// caller supplies `endpointKey` from safeStorage (keys.ts, tag
/// `VLM_ENDPOINT_KEY_TAG`). index.ts feeds the result to the MCP host's
/// vlm-config callback, which injects it per call into `describe_clip` /
/// `media://{id}/description`.
///
/// The key rides the `byo_endpoint` ENTRY rather than an entry of its own: a key
/// without a URL configures nothing, so it must never make a backend look
/// available on its own.
export function toVlmBackendSnapshot(
  cfg: VlmConfig,
  endpointKey?: string | null,
): Record<string, BackendConfigJson> {
  const out: Record<string, BackendConfigJson> = {};
  for (const [tag, lc] of Object.entries(cfg.local)) {
    out[tag] = {
      kind: "local",
      binary: lc.binary,
      model: lc.model,
      mmproj: lc.mmproj,
      ...(lc.device ? { device: lc.device } : {}),
    };
  }
  if (cfg.endpoint && cfg.endpoint.url.trim() !== "") {
    const key = endpointKey?.trim() ?? "";
    out.byo_endpoint = {
      kind: "endpoint",
      url: cfg.endpoint.url,
      ...(key !== "" ? { api_key: key } : {}),
      ...(cfg.endpoint.model ? { model: cfg.endpoint.model } : {}),
    };
  }
  return out;
}
