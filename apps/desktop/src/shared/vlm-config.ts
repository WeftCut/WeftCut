// Video-understanding (VLM) backend config types, shared by the Electron main
// process (owner of persistence, src/main/vlm-config.ts) and the renderer
// (consumer via ipc). One definition → no main↔renderer drift. Twin of
// shared/speech-config.ts.
//
// Non-secret config only; the endpoint's optional API key lives in safeStorage
// (main/keys.ts) under VLM_ENDPOINT_KEY_TAG. See ADR 0036 "Config splits by
// secrecy".

/// The engine the user prefers for description. `"auto"` lets the resolver pick
/// by availability (its local-first default order). The concrete tags mirror the
/// Rust `VlmBackend::as_str` wire contract.
///
/// There is no hosted-provider tag: a hosted VLM is `"byo_endpoint"` pointed at
/// the provider's URL, because the two would be the same HTTP describer with the
/// same request shape (see native/src/vlm/endpoint.rs). A `vlm_config.json` left
/// over from when `"cloud"` was a tag degrades to `"auto"` — the store validates
/// against VLM_PREFERRED_ENGINES rather than trusting the file.
export type VlmPreferredEngine =
  | "auto"
  | "qwen3_vl"
  | "minicpm_v"
  | "byo_endpoint";

export const VLM_PREFERRED_ENGINES: readonly VlmPreferredEngine[] = [
  "auto",
  "qwen3_vl",
  "minicpm_v",
  "byo_endpoint",
];

/// What the model is asked to attend to, and therefore what populates a
/// segment's `tags`. Mirrors the Rust `Focus` wire tags, hyphen included.
export type VlmDescribeFocus = "general" | "shot-type";

export const VLM_DESCRIBE_FOCUSES: readonly VlmDescribeFocus[] = [
  "general",
  "shot-type",
];

/// Sampling bounds for [`VlmConfig.describe_fps`], in frames per second.
///
/// `MAX` is Rust's own: `describe_clip` refuses anything outside `(0.0, 30.0]`,
/// so a stored value above it would travel to a refusal instead of a run. `MIN`
/// is this layer's: below a tenth of a frame per second a minute of footage
/// yields fewer than six frames, and the model would be describing stills rather
/// than a clip. `STEP` keeps the useful range (roughly 0.5-3) reachable by a
/// stepper — a whole-number step would put its lower half out of reach.
///
/// ONE definition, read by the store's coercion and by the Settings field alike:
/// two clamps would be two answers to what a legal sampling rate is.
export const VLM_DESCRIBE_FPS_MIN = 0.1;
export const VLM_DESCRIBE_FPS_MAX = 30;
export const VLM_DESCRIBE_FPS_STEP = 0.5;

/// The `cloud_keys.json` provider tag the endpoint's optional API key is stored
/// under. Its own tag, not the speech section's `"openai"` entry: one secret,
/// one editor — a key the user typed under Video understanding must not change
/// what Transcription does, and vice versa.
export const VLM_ENDPOINT_KEY_TAG = "vlm_endpoint";

/// One local engine's on-disk config: the `llama-mtmd-cli` binary, the model
/// GGUF, and its vision projector (`mmproj`) — all three are needed for vision.
/// `device` is an optional GPU hint (empty = engine default). Paths are stored
/// verbatim (trimmed) as the OS picker returned them; the Rust availability probe
/// does the file-existence check.
export interface VlmLocalEngineConfig {
  binary: string;
  model: string;
  mmproj: string;
  device?: string;
}

/// An OpenAI-compatible endpoint — self-hosted (llama-server / vLLM / SGLang) or
/// a hosted provider. `url` is the full `/v1/chat/completions` URL; `model` names
/// the served model. NO key field: the optional API key is a credential and lives
/// in safeStorage under [`VLM_ENDPOINT_KEY_TAG`], so nothing on this interface is
/// secret and the whole file can be logged.
export interface VlmEndpointConfig {
  url: string;
  model?: string;
}

/// The persisted VLM config (<userData>/vlm_config.json).
export interface VlmConfig {
  preferred_engine: VlmPreferredEngine;
  /// Per-local-engine config, keyed by the backend tag (`"qwen3_vl"` /
  /// `"minicpm_v"`). The endpoint backend never appears here.
  local: Record<string, VlmLocalEngineConfig>;
  /// The single endpoint config, when configured.
  endpoint?: VlmEndpointConfig;
  /// How densely to sample frames, and what to bias `tags` toward. NOT backend
  /// config — they are the run parameters every describe gesture uses, and they
  /// live here beside `preferred_engine` because this file is what the Video
  /// understanding panel owns. `toVlmBackendSnapshot` projects only the backend
  /// half of this store, so neither reaches the Rust resolver's config map.
  ///
  /// Both are part of the description cache key, so changing either switches
  /// which cached view every read resolves to (`native/src/vlm/description.rs`
  /// `cache_key`). Main injects them on BOTH sides of that key — the
  /// `describe_clip` argument fill and the `media://{id}/description` read — so
  /// the view that gets written is the view that gets read back.
  describe_fps: number;
  describe_focus: VlmDescribeFocus;
}

/// Patch shape — every field optional; the store merges, persists atomically,
/// and returns the post-patch snapshot. A `local` patch sets one engine's config
/// or clears it when `config` is `null`; an `endpoint` patch sets or clears it.
export interface VlmConfigPatch {
  preferred_engine?: VlmPreferredEngine;
  local?: { backend: string; config: VlmLocalEngineConfig | null };
  endpoint?: VlmEndpointConfig | null;
  describe_fps?: number;
  describe_focus?: VlmDescribeFocus;
}

export const VLM_CONFIG_DEFAULTS: VlmConfig = {
  // ADDITIVE-FIELD SAFETY: an old vlm_config.json (or none) that lacks
  // preferred_engine must load as "auto", never undefined — an undefined engine
  // would blank a Settings selector. The store's read() backfills this default.
  preferred_engine: "auto",
  local: {},
  // ADDITIVE-FIELD SAFETY, and the whole of this feature's migration: these are
  // the values the tool's own defaults used to state, so every description ever
  // cached was written under this view and a first launch after these fields
  // appear resolves to the key it already resolved to.
  describe_fps: 1.0,
  describe_focus: "general",
};
