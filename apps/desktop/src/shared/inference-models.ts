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
export interface ModelEndpoint { url: string; model: string }
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
  { id: "qwen3-vl-4b", name: "Qwen3-VL-4B", family: "vlm", backend: "qwen3_vl", locality: "local", artifacts: ["llama-mtmd-runtime", "qwen3-vl-4b-model", "qwen3-vl-4b-mmproj"] },
  // An entry point for the existing compatible-endpoint adapter, not a new provider preset.
  { id: "vlm-online", name: "Online model", family: "vlm", backend: "byo_endpoint", locality: "online", artifacts: [] },
];
export const INITIAL_MODEL: Record<ModelFamily, string> = { speech: "whisper-base", vlm: "qwen3-vl-4b" };
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
}
export interface ModelsView {
  models: ModelView[];
  active: Record<ModelFamily, string | null>;
  operations: ModelOperation[];
}
export interface ModelUseRequest {
  id: string;
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
