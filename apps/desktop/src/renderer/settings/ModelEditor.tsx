import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelBackend, ModelLocalConfig, ModelOperation, ModelUseRequest, ModelView } from "../../shared/inference-models";
import { modelsInstallComponents } from "../ipc";
import { open as openFileDialog } from "@/bridge/dialog";
import { Button } from "@/components/ui/button";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";

type Props = {
  model: ModelView; name: string; mode: "prepare" | "edit" | "new";
  backendOverride?: ModelBackend | undefined; operation: ModelOperation | undefined; submittingRequest: boolean;
  draft?: ModelUseRequest | undefined;
  onUse(request: ModelUseRequest): Promise<void>; onError(message: string): void; onCancel(): void;
};
const adapterNames: Record<ModelBackend, string> = {
  whisper_cpp: "Whisper · whisper.cpp", funasr: "FunASR · sherpa-onnx", openai: "OpenAI Whisper · whisper-1",
  qwen3_vl: "Qwen3-VL · llama-mtmd", minicpm_v: "MiniCPM-V · llama-mtmd", byo_endpoint: "OpenAI-compatible",
};
export function ModelEditor({ model, name: displayName, mode, backendOverride, operation, submittingRequest, onUse, onError, onCancel, draft }: Props) {
  const { t } = useTranslation();
  const isNew = mode === "new";
  const backend = backendOverride ?? model.backend;
  const [local, setLocal] = useState<ModelLocalConfig>(draft?.local ?? (isNew ? { binary: "", model: "" } : model.local ?? { binary: "", model: "" }));
  const [endpoint, setEndpoint] = useState(draft?.endpoint ?? (isNew ? { url: "", model: "" } : model.endpoint ?? { url: "", model: "" }));
  const [apiKey, setApiKey] = useState(draft?.apiKey ?? "");
  const [name, setName] = useState(draft?.name ?? (!isNew && model.custom ? model.name : ""));
  const [busyAction, setBusyAction] = useState(false);
  const busy = submittingRequest || busyAction || !!operation && operation.phase !== "error" && operation.phase !== "needs_components";
  const filesChanged = ["model", "tokens", "mmproj"].some(k => (local[k as keyof ModelLocalConfig] ?? "") !== (model.local?.[k as keyof ModelLocalConfig] ?? ""));
  const endpointChanged = endpoint.url !== (model.endpoint?.url ?? "") || endpoint.model !== (model.endpoint?.model ?? "");
  const newIdentity = isNew || !model.custom && (model.locality === "local" ? filesChanged : endpointChanged);
  const requiresName = newIdentity || model.custom || backend === "byo_endpoint";
  const localComplete = !!local.binary.trim() && !!local.model.trim() && (backend !== "funasr" || !!local.tokens?.trim()) && (model.family !== "vlm" || !!local.mmproj?.trim());
  const canSubmit = (!requiresName || !!name.trim()) && (model.locality === "local" ? localComplete : backend === "openai" ? !!apiKey.trim() || !isNew && model.hasKey : !!endpoint.url.trim() && !!endpoint.model.trim());
  const needsDownload = !newIdentity && model.locality === "local" && !model.installed && model.missingBytes > 0;
  const run = async (fn: () => Promise<void>) => {
    setBusyAction(true); onError("");
    try { await fn(); } catch (e) { onError(String(e)); }
    finally { setBusyAction(false); }
  };
  const submit = (saveOnly: boolean, restore = false) => void run(() => onUse({ id: model.id,
    ...(saveOnly ? { saveOnly: true } : {}), ...(restore ? { restore: true } : {
      ...(model.locality === "local" ? { local } : {}), ...(backend === "byo_endpoint" ? { endpoint } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(requiresName ? { name: name.trim() } : {}),
      ...(isNew ? { createCustom: true, backend } : {}),
    }),
  }));
  const pathField = (key: "binary" | "model" | "tokens" | "mmproj", label: string) => <div className="settings-key-input-row" key={key}>
    <span className="settings-slider-label">{label}</span>
    <AppInput value={local[key] ?? ""} ariaLabel={label} mono spellCheck={false} disabled={busy} onValueChange={value => setLocal(prev => ({ ...prev, [key]: value }))} />
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
      const picked = await openFileDialog({ title: label });
      if (typeof picked === "string") setLocal(prev => ({ ...prev, [key]: picked }));
    })}>{t("settings.speech_browse")}</Button>
  </div>;
  const fields = <>
    {model.locality === "local" ? <>
      <p className="settings-toggle-hint">{t(model.family === "vlm" ? "models.vision_local_hint" : backend === "funasr" ? "models.funasr_hint" : "models.whisper_hint")}</p>
      {pathField("binary", t("settings.speech_binary"))}
      {pathField("model", t("settings.speech_model"))}
      {backend === "funasr" && pathField("tokens", t("settings.speech_tokens"))}
      {model.family === "vlm" && pathField("mmproj", t("settings.vlm_mmproj"))}
      <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.speech_device")}</span>
        <AppInput value={local.device ?? ""} ariaLabel={t("settings.speech_device")} placeholder={t("models.device_auto")} disabled={busy}
          onValueChange={device => setLocal(prev => { const next = { ...prev }; if (device.trim()) next.device = device; else delete next.device; return next; })} />
      </div>
      {model.family === "speech" && <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.speech_threads")}</span>
        <AppNumberField value={local.threads ?? null} min={1} max={256} ariaLabel={t("settings.speech_threads")} disabled={busy}
          onValueChange={threads => setLocal(prev => { const next = { ...prev }; if (threads != null) next.threads = threads; else delete next.threads; return next; })}
          onClear={() => setLocal(prev => { const next = { ...prev }; delete next.threads; return next; })} />
      </div>}
    </> : <>
      {backend === "byo_endpoint" ? <>
        <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.vlm_endpoint_url")}</span>
          <AppInput value={endpoint.url} ariaLabel={t("settings.vlm_endpoint_url")} disabled={busy} placeholder="https://…/v1/chat/completions" onValueChange={url => setEndpoint(prev => ({ ...prev, url }))} /></div>
        <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.vlm_endpoint_model")}</span>
          <AppInput value={endpoint.model} ariaLabel={t("settings.vlm_endpoint_model")} disabled={busy} onValueChange={model => setEndpoint(prev => ({ ...prev, model }))} /></div>
      </> : <p className="settings-toggle-hint">{t("models.openai_speech_hint")}</p>}
      <div className="settings-key-input-row"><span className="settings-slider-label">API Key</span>
        <AppInput type="password" value={apiKey} autoComplete="off" spellCheck={false} ariaLabel="API Key" disabled={busy}
          placeholder={t(!isNew && model.hasKey ? "settings.placeholder_set" : backend === "byo_endpoint" ? "models.key_optional" : "settings.placeholder_unset")} onValueChange={setApiKey} />
      </div>
      <p className="settings-toggle-hint">{t("models.online_notice")}</p>
    </>}
  </>;
  return <div className="settings-model-editor">
    <p className="settings-model-state">{isNew ? adapterNames[backend] : displayName}</p>
    {requiresName && <div className="settings-key-input-row"><span className="settings-slider-label">{t("models.name")}</span><AppInput value={name} ariaLabel={t("models.name")} disabled={busy} onValueChange={setName} /></div>}
    {needsDownload && <p className="settings-toggle-hint">{t("models.download_size", { size: `${(model.missingBytes / 1024 ** 3).toFixed(2)} GB` })}</p>}
    {!model.supported && !newIdentity && <p className="settings-toggle-hint">{t("models.unsupported")}</p>}
    {mode === "prepare" && model.locality === "local" && !model.custom ? <details className="settings-model-fields"><summary>{t("models.edit_model")}</summary>{fields}</details> : <div className="settings-model-fields">{fields}</div>}
    {newIdentity && !isNew && <p className="settings-toggle-hint">{t("models.custom_identity")}</p>}
    {operation && <p className="settings-model-state" role="status">{t(`models.${operation.phase}`)}</p>}
    {operation?.progress !== undefined && <div className="progress-track" role="progressbar" aria-label={t("models.downloading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(operation.progress * 100)}><div className="progress-fill" style={{ width: `${operation.progress * 100}%` }} /></div>}
    {operation?.error && <p className="settings-test-err" role="alert">{operation.error}</p>}
    <div className="settings-model-actions">
      {operation?.phase === "needs_components" ? <Button size="sm" disabled={busyAction || submittingRequest} onClick={() => void run(() => modelsInstallComponents(model.id))}>{t("models.install_components")}</Button>
        : !busy && <>
          <Button size="sm" disabled={!canSubmit || !model.supported && !newIdentity} onClick={() => submit(operation?.phase === "error" && draft ? !!draft.saveOnly : mode === "edit")}>{t(operation?.phase === "error" ? "models.retry" : needsDownload ? mode === "edit" ? "models.download_save" : "models.download_use" : mode === "edit" ? "models.save" : newIdentity ? "models.add_use" : "models.configure_use")}</Button>
          {isNew && <Button size="sm" variant="outline" disabled={!canSubmit} onClick={() => submit(true)}>{t("models.add_only")}</Button>}
          {mode === "edit" && !model.custom && model.customized && <Button size="sm" variant="ghost" onClick={() => submit(true, true)}>{t("models.restore")}</Button>}
        </>}
      {operation && <Button size="sm" variant="ghost" disabled={submittingRequest || busyAction} onClick={onCancel}>{t("models.cancel")}</Button>}
    </div>
  </div>;
}
