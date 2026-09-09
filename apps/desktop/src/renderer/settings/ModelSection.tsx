import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { INITIAL_MODEL, MODEL_EVENTS, type ModelBackend, type ModelFamily, type ModelLocalConfig, type ModelOperation, type ModelsView, type ModelUseRequest, type ModelView } from "../../shared/inference-models";
import { modelsList, modelsUse, modelsCancel, modelsInstallComponents, modelsRemoveCustom } from "../ipc";
import { listen, type UnlistenFn } from "@/bridge/events";
import { open as openFileDialog } from "@/bridge/dialog";
import { Button } from "@/components/ui/button";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";

export function ModelSection({ family, onError, advancedContent }: { family: ModelFamily; onError(msg: string): void; advancedContent?: ReactNode }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelsView | null>(null);
  const [selected, setSelected] = useState(INITIAL_MODEL[family]);
  const initialized = useRef(false);
  const wanted = useRef<string | null>(null);
  const lastActive = useRef<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let generation = 0;
    const refresh = async () => {
      const version = ++generation;
      try {
        const next = await modelsList();
        if (disposed || version !== generation) return;
        const active = next.active[family];
        if (!initialized.current) {
          setSelected(active ?? INITIAL_MODEL[family]);
          initialized.current = true;
        } else if (active && active !== lastActive.current && wanted.current === selectedRef.current) {
          setSelected(active);
          wanted.current = null;
        }
        lastActive.current = active;
        setView(next);
      } catch (e) { if (!disposed) onError(String(e)); }
    };
    void (async () => {
      // Subscribe first, then read: preparation completion cannot be lost between them.
      unlisten = await listen(MODEL_EVENTS.changed, () => { void refresh(); });
      if (disposed) { unlisten(); return; }
      await refresh();
    })().catch(e => { if (!disposed) onError(String(e)); });
    return () => { disposed = true; unlisten?.(); };
  }, [family]);
  if (!view) return <section className="settings-section"><p className="settings-status">…</p></section>;
  const models = view.models.filter(m => m.family === family);
  const model = models.find(m => m.id === selected) ?? models[0];
  if (!model) return null;
  const displayName = (m: ModelView) => m.id === "vlm-online" ? t("models.online_model") : m.name;
  const active = models.find(m => m.active);
  return <section className="settings-section settings-model-section">
    <div className="settings-model-selector">
      <label className="settings-slider-label" id={`model-label-${family}`}>{t("models.model")}</label>
      <AppSelect value={model.id} ariaLabel={t("models.model")} onValueChange={id => { wanted.current = null; setSelected(id); }}
        options={models.map(m => ({ value: m.id, label: `${displayName(m)} · ${t(m.locality === "local" ? "models.local" : "models.online")}${m.active ? ` · ${t("models.current")}` : ""}` }))} />
    </div>
    {active && !model.active && <p className="settings-toggle-hint">{t("models.current_model", { name: displayName(active) })}</p>}
    <ModelCard key={model.id} model={model} name={displayName(model)}
      operation={view.operations.find(o => o.id === model.id)}
      advancedContent={advancedContent}
      onUse={() => { wanted.current = model.id; }}
      onRemoved={() => setSelected(INITIAL_MODEL[family])} onError={onError} />
  </section>;
}

function ModelCard({ model, name: displayName, operation, onUse, onRemoved, onError, advancedContent }: {
  model: ModelView; name: string; operation: ModelOperation | undefined;
  advancedContent?: ReactNode;
  onUse(): void; onRemoved(): void; onError(msg: string): void;
}) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const [local, setLocal] = useState<ModelLocalConfig>(model.local ?? { binary: "", model: "" });
  const [endpoint, setEndpoint] = useState(model.endpoint ?? { url: "", model: "" });
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState(model.custom ? model.name : "");
  const [createCustom, setCreateCustom] = useState(false);
  const [backend, setBackend] = useState<ModelBackend>(model.backend);
  const [submitting, setSubmitting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const wasPreparing = useRef(false);
  useEffect(() => {
    if (wasPreparing.current && !operation && model.active && model.verified) {
      setApiKey(""); setCreateCustom(false);
    }
    wasPreparing.current = !!operation;
  }, [operation, model.active, model.verified]);
  // Background progress must not overwrite drafts. Only committed config changes resync.
  const savedLocal = JSON.stringify(model.local ?? { binary: "", model: "" });
  const savedEndpoint = JSON.stringify(model.endpoint ?? { url: "", model: "" });
  useEffect(() => { setLocal(JSON.parse(savedLocal)); }, [savedLocal]);
  useEffect(() => { setEndpoint(JSON.parse(savedEndpoint)); }, [savedEndpoint]);
  const busy = submitting || !!operation && operation.phase !== "error" && operation.phase !== "needs_components";
  const filesChanged = ["model", "tokens", "mmproj"].some(k => (local[k as keyof ModelLocalConfig] ?? "") !== (model.local?.[k as keyof ModelLocalConfig] ?? ""));
  const endpointChanged = endpoint.url !== (model.endpoint?.url ?? "") || endpoint.model !== (model.endpoint?.model ?? "");
  const customIdentity = createCustom || filesChanged || endpointChanged;
  const dirty = JSON.stringify(local) !== savedLocal || JSON.stringify(endpoint) !== savedEndpoint || !!apiKey || customIdentity || model.custom && name !== model.name;
  const requiresName = customIdentity || model.custom;
  const configured = model.locality === "local" || model.backend === "openai" ? true : !!endpoint.url.trim() && !!endpoint.model.trim();
  const canUse = configured && (!requiresName || !!name.trim()) && (model.backend !== "openai" || !!apiKey.trim() || model.hasKey);
  const act = async (fn: () => Promise<void>) => {
    setSubmitting(true); onError("");
    try { await fn(); } catch (e) { onError(String(e)); }
    finally { setSubmitting(false); }
  };
  const use = (restore = false) => act(async () => {
    onUse();
    const req: ModelUseRequest = { id: model.id, ...(restore ? { restore: true } : {
      ...(model.locality === "local" ? { local } : {}),
      ...(model.backend === "byo_endpoint" ? { endpoint } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(requiresName ? { name: name.trim() } : {}),
      ...(createCustom ? { createCustom: true, backend } : {}),
    }) };
    await modelsUse(req);
  });
  const pathField = (key: "binary" | "model" | "tokens" | "mmproj", label: string) => <div className="settings-key-input-row" key={key}>
    <span className="settings-slider-label">{label}</span>
    <AppInput value={local[key] ?? ""} ariaLabel={label} mono spellCheck={false} disabled={busy}
      onValueChange={value => setLocal(prev => ({ ...prev, [key]: value }))} />
    <Button size="sm" disabled={busy} onClick={() => void act(async () => {
      const picked = await openFileDialog({ title: label });
      if (typeof picked === "string") setLocal(prev => ({ ...prev, [key]: picked }));
    })}>{t("settings.speech_browse")}</Button>
  </div>;
  const state = operation ? t(`models.${operation.phase}`)
    : model.locality === "local" && !model.installed ? t(model.custom ? "models.files_missing" : "models.not_downloaded")
    : model.verified && (model.backend !== "openai" || model.hasKey) ? t(model.active ? "models.current" : "models.ready")
    : t("models.not_verified");
  const size = model.missingBytes >= 1024 ** 3 ? `${(model.missingBytes / 1024 ** 3).toFixed(2)} GB` : `${(model.missingBytes / 1024 ** 2).toFixed(1)} MB`;
  return <div className="settings-model-card">
    <div className="settings-model-card-header">
      <strong>{displayName}</strong>
      <span className={`settings-badge ${model.active ? "settings-badge-on" : "settings-badge-off"}`}>{t(model.locality === "local" ? "models.local" : "models.online")}</span>
      {model.customized && <span className="settings-badge settings-badge-off">{t("models.customized")}</span>}
    </div>
    <p className="settings-model-state" role="status">{state}</p>
    {model.locality === "local" && !model.installed && model.supported && !model.custom && <p className="settings-toggle-hint">{t("models.download_size", { size })}</p>}
    {!model.supported && <p className="settings-toggle-hint">{t("models.unsupported")}</p>}
    {model.executionDevice === "cpu" && <p className="settings-toggle-hint">{t("models.cpu_state")}</p>}
    {model.locality === "online" && <>
      <div className="settings-key-input-row">
        <span className="settings-slider-label">API Key</span>
        <AppInput type="password" value={apiKey} autoComplete="off" spellCheck={false} ariaLabel="API Key" disabled={busy}
          placeholder={t(model.hasKey ? "settings.placeholder_set" : "settings.placeholder_unset")} onValueChange={setApiKey} />
      </div>
      <p className="settings-toggle-hint">{t("models.online_notice")}</p>
    </>}
    {operation?.progress !== undefined && <div className="progress-track" role="progressbar" aria-label={t("models.downloading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(operation.progress * 100)}>
      <div className="progress-fill" style={{ width: `${operation.progress * 100}%` }} />
    </div>}
    {operation?.error && <p className="settings-test-err" role="alert">{operation.error}</p>}
    <div className="settings-model-actions">
      {operation?.phase === "needs_components" ? <Button size="sm" disabled={submitting} onClick={() => void act(() => modelsInstallComponents(model.id))}>{t("models.install_components")}</Button>
        : !configured ? <Button size="sm" disabled={busy} onClick={() => setAdvanced(true)}>{t("models.configure")}</Button>
        : <Button size="sm" disabled={busy || !canUse || !model.supported && !customIdentity || model.active && !dirty && !operation && !!model.verified && model.installed}
          onClick={() => void use()}>{operation?.phase === "error" ? t("models.retry") : model.locality === "local" && !model.installed && !customIdentity ? t("models.download_use") : dirty || !model.verified ? t("models.verify_use") : t("models.use")}</Button>}
      {operation && operation.phase !== "error" && <Button size="sm" disabled={submitting || operation.phase === "installing_components"} onClick={() => void act(() => modelsCancel(model.id))}>{t("models.cancel")}</Button>}
      <Button variant="ghost" size="sm" aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}>
        {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{t("models.advanced")}
      </Button>
    </div>
    <div hidden={!advanced} className="settings-model-advanced">
      {(requiresName || model.backend === "byo_endpoint") && <div className="settings-key-input-row">
        <span className="settings-slider-label">{t("models.name")}</span>
        <AppInput value={name} ariaLabel={t("models.name")} disabled={busy} onValueChange={setName} />
      </div>}
      {model.locality === "local" ? <>
        {createCustom && <div className="settings-key-input-row"><span className="settings-slider-label">{t("models.runtime")}</span>
          <AppSelect value={backend} ariaLabel={t("models.runtime")} disabled={busy} onValueChange={v => setBackend(v as ModelBackend)}
            options={(model.family === "speech" ? ["whisper_cpp", "funasr"] : ["qwen3_vl", "minicpm_v"]).map(value => ({ value, label: value }))} /></div>}
        {pathField("binary", t("settings.speech_binary"))}
        {pathField("model", t("settings.speech_model"))}
        {(backend === "funasr") && pathField("tokens", t("settings.speech_tokens"))}
        {model.family === "vlm" && pathField("mmproj", t("settings.vlm_mmproj"))}
        <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.speech_device")}</span>
          <AppInput value={local.device ?? ""} ariaLabel={t("settings.speech_device")} placeholder={t("models.device_auto")} disabled={busy}
            onValueChange={device => setLocal(prev => { const next = { ...prev }; if (device.trim()) next.device = device; else delete next.device; return next; })} />
        </div>
        {model.family === "speech" && <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.speech_threads")}</span>
          <AppNumberField value={local.threads ?? null} min={1} max={256} ariaLabel={t("settings.speech_threads")} disabled={busy}
            onValueChange={threads => setLocal(prev => { const next = { ...prev }; if (threads != null) next.threads = threads; else delete next.threads; return next; })}
            onClear={() => setLocal(prev => { const next = { ...prev }; delete next.threads; return next; })} /></div>}
      </> : model.backend === "byo_endpoint" ? <>
        <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.vlm_endpoint_url")}</span>
          <AppInput value={endpoint.url} ariaLabel={t("settings.vlm_endpoint_url")} disabled={busy} placeholder="https://…/v1/chat/completions" onValueChange={url => setEndpoint(prev => ({ ...prev, url }))} /></div>
        <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.vlm_endpoint_model")}</span>
          <AppInput value={endpoint.model} ariaLabel={t("settings.vlm_endpoint_model")} disabled={busy} onValueChange={model => setEndpoint(prev => ({ ...prev, model }))} /></div>
      </> : null}
      {customIdentity && <p className="settings-toggle-hint">{t("models.custom_identity")}</p>}
      {advanced && advancedContent}
      <div className="settings-model-actions">
        {!model.custom && model.locality === "local" && <Button size="sm" disabled={busy || !model.customized && !dirty} onClick={() => void use(true)}>{t("models.restore")}</Button>}
        <Button size="sm" disabled={busy} onClick={() => { setCreateCustom(true); setName(model.custom ? `${model.name} (copy)` : ""); }}>{t("models.add_custom")}</Button>
        {model.custom && <Button size="sm" disabled={busy || model.active} onClick={() => {
          if (!confirmRemove) setConfirmRemove(true);
          else void act(async () => { await modelsRemoveCustom(model.id); onRemoved(); });
        }}>{t(confirmRemove ? "models.confirm_remove" : "models.remove")}</Button>}
      </div>
    </div>
  </div>;
}
