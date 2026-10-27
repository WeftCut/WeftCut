// Speech-backend config persisted at <userData>/speech_config.json, owned by
// the Electron main process. NON-secret: the preferred engine + each local
// engine's binary/model paths (device/threads hints). The OpenAI API KEY is
// secret and lives in safeStorage (keys.ts / cloud_keys.json) — NEVER here.
// (ADR 0036 "Config splits by secrecy".)
//
// The on-disk file path + JSON field names are a COMPATIBILITY SURFACE: once
// users have a speech_config.json it must keep loading, so neither may change
// without a migration. Bad-config recovery: a missing / empty / corrupt file,
// or one written by an older build that lacks a field, degrades to defaults.

import {
  SPEECH_CONFIG_DEFAULTS,
  PREFERRED_ENGINES,
  type SpeechConfig,
  type SpeechConfigPatch,
  type PreferredEngine,
  type LocalEngineConfig,
} from "../shared/speech-config";

/** Minimal fs surface — injected so tests run in-memory; node:fs in production.
 *  Mirrors AppSettingsFs (atomic tmp-then-rename write). */
export interface SpeechConfigFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

export interface SpeechConfigStore {
  get(): SpeechConfig;
  /** Apply a patch atomically; returns the post-patch config. */
  apply(patch: SpeechConfigPatch): SpeechConfig;
}

function isPreferred(v: unknown): v is PreferredEngine {
  return typeof v === "string" && (PREFERRED_ENGINES as readonly string[]).includes(v);
}

/// Coerce one on-disk local-engine entry into a valid `LocalEngineConfig`, or
/// `null` when it has no usable binary/model. Trims paths (verbatim otherwise —
/// no lowercasing, so display stays faithful and the OS-returned casing is
/// preserved); carries `tokens` when present (FunASR's model-bundle file — an
/// old config that predates it simply omits it, no migration needed); drops
/// empty/blank device/tokens and non-finite threads.
function readLocalEntry(raw: unknown): LocalEngineConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const binary = typeof o.binary === "string" ? o.binary.trim() : "";
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (binary === "" && model === "") return null;
  const out: LocalEngineConfig = { binary, model };
  if (typeof o.tokens === "string" && o.tokens.trim() !== "") out.tokens = o.tokens.trim();
  if (typeof o.device === "string" && o.device.trim() !== "") out.device = o.device.trim();
  if (typeof o.threads === "number" && Number.isFinite(o.threads) && o.threads > 0) {
    out.threads = Math.floor(o.threads);
  }
  return out;
}

export function createSpeechConfigStore(deps: {
  fs: SpeechConfigFs;
  path: string;
  dir: string;
}): SpeechConfigStore {
  function read(): SpeechConfig {
    if (!deps.fs.exists(deps.path)) return { preferred_engine: "auto", local: {} };
    let body: string;
    try {
      body = deps.fs.readFile(deps.path);
    } catch (e) {
      console.warn(`[speech-config] read ${deps.path}:`, e);
      return { preferred_engine: "auto", local: {} };
    }
    if (body.trim() === "") return { preferred_engine: "auto", local: {} };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[speech-config] parse ${deps.path}:`, e);
      return { preferred_engine: "auto", local: {} };
    }
    // Per-field defaulting (the ONE backfill point): a missing / wrong-typed
    // preferred_engine falls back to "auto" so the selector is never undefined.
    const preferred_engine: PreferredEngine = isPreferred(parsed.preferred_engine)
      ? parsed.preferred_engine
      : SPEECH_CONFIG_DEFAULTS.preferred_engine;
    const local: Record<string, LocalEngineConfig> = {};
    if (parsed.local && typeof parsed.local === "object") {
      for (const [tag, raw] of Object.entries(parsed.local as Record<string, unknown>)) {
        const entry = readLocalEntry(raw);
        if (entry) local[tag] = entry;
      }
    }
    return { preferred_engine, local };
  }

  function write(cfg: SpeechConfig): void {
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
      write(current);
      return current;
    },
  };
}

/// The tagged `BackendConfig` JSON shapes the Rust `speech::config::BackendConfig`
/// deserializes (`kind`-tagged, snake_case — `WireConfig` in config.rs).
export type SpeechBackendConfigJson =
  | { kind: "api_key"; key: string }
  | { kind: "local"; binary: string; model: string; tokens?: string; device?: string; threads?: number }
  | { kind: "endpoint"; url: string; api_key?: string; model?: string; timeout_s?: number };

/// Everything a speech snapshot is merged from, read by the caller at call time.
export interface SpeechSnapshotSources {
  /// The store's local engines (`speech_config.json`), keyed by backend tag.
  local: Record<string, LocalEngineConfig>;
  /// The OpenAI key from safeStorage: the active cloud profile's own key when
  /// that is the selection, else the `openai` tag's — TTS needs it even while
  /// transcription runs on a local engine.
  openaiKey?: string | null;
  /// The active speech profile's endpoint, when it is one, and its key.
  endpoint?: { url: string; model?: string; timeout_s?: number } | null;
  endpointKey?: string | null;
}

/// Merge the non-secret store config + the secrets into the
/// `Record<backendTag, BackendConfig>` snapshot every speech call carries
/// (`speech_config` on `transcribe_clip` / `synthesize_speech`, `speechConfig`
/// on the speech Settings commands; ADR 0148). Pure — the twin of
/// `modelProfileToVlmSnapshot`. Built per call, so a key saved or a model
/// switched a moment ago is what the next call sees, with nothing to push.
///
/// A blank key is ABSENT, never `""`: the cloud row counts any `api_key` entry
/// as configured, and the endpoint would send a bare `Bearer ` for one.
export function toSpeechBackendSnapshot(src: SpeechSnapshotSources): Record<string, SpeechBackendConfigJson> {
  const out: Record<string, SpeechBackendConfigJson> = {};
  const openaiKey = src.openaiKey?.trim() ?? "";
  if (openaiKey !== "") out.openai = { kind: "api_key", key: openaiKey };
  for (const [tag, lc] of Object.entries(src.local)) {
    out[tag] = {
      kind: "local",
      binary: lc.binary,
      model: lc.model,
      ...(lc.tokens ? { tokens: lc.tokens } : {}),
      ...(lc.device ? { device: lc.device } : {}),
      ...(lc.threads != null ? { threads: lc.threads } : {}),
    };
  }
  if (src.endpoint && src.endpoint.url.trim() !== "") {
    const key = src.endpointKey?.trim() ?? "";
    const model = src.endpoint.model?.trim() ?? "";
    out.byo_endpoint = {
      kind: "endpoint",
      url: src.endpoint.url,
      ...(key !== "" ? { api_key: key } : {}),
      ...(model !== "" ? { model } : {}),
      // Absent → native's audio-scaled ceiling; only a set one rides along.
      ...(src.endpoint.timeout_s !== undefined ? { timeout_s: src.endpoint.timeout_s } : {}),
    };
  }
  return out;
}
