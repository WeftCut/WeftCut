/** Model identity is independent of its execution backend and downloaded artifacts. */
export type ModelFamily = "speech" | "vlm";
export type ModelBackend = "whisper_cpp" | "funasr" | "openai" | "qwen3_vl" | "minicpm_v" | "byo_endpoint";
export interface ModelLocalConfig {
  binary: string;
  model: string;
  tokens?: string;
  mmproj?: string;
  device?: string;
  threads?: number;
}
export interface ModelEndpoint {
  url: string;
  model: string;
  /** Per-request timeout in seconds, for a server slower than the automatic
   *  ceiling allows (#69). Absent → native scales the ceiling with the request.
   *  Run tuning, not identity: changing it neither forks a custom model nor
   *  invalidates verification. Bounds: ENDPOINT_TIMEOUT_MIN_S..MAX_S. */
  timeout_s?: number;
  /** Vision only: how many sampled frames one request carries. A window is
   *  described in requests of this many frames at the sampling rate the user
   *  chose, so a model with a larger context takes fewer, larger requests.
   *  Absent → 16. Run tuning like the timeout: not identity, not in the
   *  description cache key. Bounds: ENDPOINT_FRAMES_PER_REQUEST_MIN..MAX. */
  frames_per_request?: number;
  /** Vision only: how many of those requests may be in flight at once, for a
   *  server that batches. Absent → 1. Bounds: ENDPOINT_CONCURRENCY_MIN..MAX. */
  concurrency?: number;
}
/** Legal request-timeout range, read by the store's parsing, the manager's
 *  validation and the editor field alike. */
export const ENDPOINT_TIMEOUT_MIN_S = 10;
export const ENDPOINT_TIMEOUT_MAX_S = 3600;
/** Whether `v` is a request timeout the store keeps. */
export function isEndpointTimeout(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= ENDPOINT_TIMEOUT_MIN_S && v <= ENDPOINT_TIMEOUT_MAX_S;
}
/** Legal frames-per-request and concurrency for a vision endpoint — the same
 *  ranges native clamps to (`vlm::config::ENDPOINT_FRAMES_PER_REQUEST`,
 *  `ENDPOINT_CONCURRENCY`). */
export const ENDPOINT_FRAMES_PER_REQUEST_MIN = 1;
export const ENDPOINT_FRAMES_PER_REQUEST_MAX = 64;
export const ENDPOINT_CONCURRENCY_MIN = 1;
export const ENDPOINT_CONCURRENCY_MAX = 8;
const wholeIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
export function isEndpointFramesPerRequest(v: unknown): v is number {
  return wholeIn(v, ENDPOINT_FRAMES_PER_REQUEST_MIN, ENDPOINT_FRAMES_PER_REQUEST_MAX);
}
export function isEndpointConcurrency(v: unknown): v is number {
  return wholeIn(v, ENDPOINT_CONCURRENCY_MIN, ENDPOINT_CONCURRENCY_MAX);
}
export interface ModelDefinition {
  id: string;
  name: string;
  family: ModelFamily;
  backend: ModelBackend;
  locality: "local" | "online";
  artifacts: readonly string[];
}
export const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  { id: "whisper-base", name: "Whisper Base", family: "speech", backend: "whisper_cpp", locality: "local", artifacts: ["whisper-cpp-runtime", "whisper-model-base"] },
  { id: "paraformer-zh", name: "Paraformer 中文", family: "speech", backend: "funasr", locality: "local", artifacts: ["funasr-runtime", "funasr-model-paraformer-zh"] },
  { id: "openai-whisper", name: "OpenAI Whisper", family: "speech", backend: "openai", locality: "online", artifacts: [] },
  // Any OpenAI-compatible transcription server (whisper.cpp's whisper-server,
  // speaches, vLLM, a hosted provider) — the speech twin of `vlm-online`.
  { id: "speech-online", name: "Online model", family: "speech", backend: "byo_endpoint", locality: "online", artifacts: [] },
  { id: "qwen3-vl-4b", name: "Qwen3-VL-4B", family: "vlm", backend: "qwen3_vl", locality: "local", artifacts: ["llama-mtmd-runtime", "qwen3-vl-4b-model", "qwen3-vl-4b-mmproj"] },
  // An entry point for the existing compatible-endpoint adapter, not a new provider preset.
  { id: "vlm-online", name: "Online model", family: "vlm", backend: "byo_endpoint", locality: "online", artifacts: [] },
];
export interface ModelProfile extends ModelDefinition {
  custom?: boolean;
  local?: ModelLocalConfig;
  endpoint?: ModelEndpoint;
  /** Stable safeStorage tag; no credential material in the model file or IPC view. */
  keyTag?: string;
  verified?: boolean;
  verificationFingerprint?: string;
  executionDevice?: "cpu" | "auto" | "fixed";
}
export interface ModelSettings {
  version: 1;
  profiles: ModelProfile[];
  active: Record<ModelFamily, string | null>;
}
export type ModelPhase = "downloading" | "needs_components" | "installing_components" | "verifying" | "error";
export interface ModelOperation {
  id: string;
  family: ModelFamily;
  phase: ModelPhase;
  progress?: number;
  error?: string;
}
export interface ModelView extends ModelProfile {
  active: boolean;
  installed: boolean;
  supported: boolean;
  missingBytes: number;
  hasKey: boolean;
  customized: boolean;
  /** Bytes actually present in app-owned downloads, including paused partials. */
  downloadedBytes?: number;
}
export interface ModelsView {
  models: ModelView[];
  active: Record<ModelFamily, string | null>;
  operations: ModelOperation[];
}
export interface ModelUseRequest {
  id: string;
  /** Verify and save without changing the current selection. */
  saveOnly?: boolean;
  name?: string;
  local?: ModelLocalConfig;
  endpoint?: ModelEndpoint;
  apiKey?: string;
  restore?: boolean;
  /** Explicitly create another named configuration, even with identical weights. */
  createCustom?: boolean;
  backend?: ModelBackend;
}
export const MODEL_EVENTS = { changed: "models:changed", activated: "models:activated" } as const;
