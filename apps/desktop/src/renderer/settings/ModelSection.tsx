import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MODEL_EVENTS, type ModelBackend, type ModelFamily, type ModelOperation, type ModelsView, type ModelUseRequest, type ModelView } from "../../shared/inference-models";
import { modelsList, modelsUse, modelsCancel, modelsUnselect, modelsClearDownloads, modelsRemoveCustom } from "../ipc";
import { listen, type UnlistenFn } from "@/bridge/events";
import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { AppDialog } from "../components/AppDialog";
import { canSwitchModel, ModelPicker } from "./ModelPicker";
import { ModelEditor } from "./ModelEditor";

type Panel = { kind: "add" } | { kind: "editor"; id: string; mode: "prepare" | "edit" | "new"; backend?: ModelBackend };
export function modelSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
const adapters: Record<ModelFamily, { id: string; backend: ModelBackend; label: string }[]> = {
  speech: [
    { id: "whisper-base", backend: "whisper_cpp", label: "Whisper · whisper.cpp" },
    { id: "paraformer-zh", backend: "funasr", label: "FunASR · sherpa-onnx" },
    { id: "openai-whisper", backend: "openai", label: "OpenAI Whisper · whisper-1" },
  ],
  vlm: [
    { id: "qwen3-vl-4b", backend: "qwen3_vl", label: "Qwen3-VL · llama-mtmd" },
    { id: "qwen3-vl-4b", backend: "minicpm_v", label: "MiniCPM-V · llama-mtmd" },
    { id: "vlm-online", backend: "byo_endpoint", label: "OpenAI-compatible" },
  ],
};
export function ModelSection({ family, onError }: { family: ModelFamily; onError(msg: string): void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelsView | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ModelOperation | null>(null);
  const [confirmation, setConfirmation] = useState<{ id: string; action: "remove" | "clear" } | null>(null);
  const [dialogError, setDialogError] = useState("");
  const wanted = useRef<ModelUseRequest | null>(null);
  const acknowledged = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let generation = 0;
    const refresh = async () => {
      const version = ++generation;
      try {
        const next = await modelsList();
        if (disposed || version !== generation) return;
        if (wanted.current && acknowledged.current && !next.operations.some(o => o.family === family)) {
          wanted.current = null;
          acknowledged.current = false;
          setPanel(null);
        }
        setView(next);
      } catch (e) { if (!disposed) onError(String(e)); }
    };
    refreshRef.current = refresh;
    void (async () => {
      unlisten = await listen(MODEL_EVENTS.changed, () => { void refresh(); });
      if (disposed) { unlisten(); return; }
      await refresh();
    })().catch(e => { if (!disposed) onError(String(e)); });
    return () => { disposed = true; unlisten?.(); refreshRef.current = async () => {}; };
  }, [family]);
  if (!view) return <section className="settings-section"><p className="settings-status">…</p></section>;
  const models = view.models.filter(m => m.family === family);
  const active = models.find(m => m.id === view.active[family]);
  const operation = failure ?? view.operations.find(o => o.family === family);
  const preparing = submitting || !!operation && operation.phase !== "error";
  const name = (m: ModelView) => m.id === "vlm-online" ? t("models.online_model") : m.name;
  const state = (m: ModelView) => t(m.locality === "local" && !m.installed ? m.custom ? "models.files_missing" : "models.not_downloaded" : m.active ? "models.current" : canSwitchModel(m) ? "models.ready" : "models.not_verified");
  const act = async (fn: () => Promise<void>) => {
    setSubmitting(true); setDialogError("");
    try { await fn(); await refreshRef.current(); }
    catch (e) { setDialogError(String(e)); }
    finally { setSubmitting(false); }
  };
  const useModel = async (request: ModelUseRequest) => {
    wanted.current = request;
    acknowledged.current = false;
    setSubmitting(true); setFailure(null); setDialogError("");
    try { await modelsUse(request); acknowledged.current = true; await refreshRef.current(); }
    catch (e) { setFailure({ id: request.id, family, phase: "error", error: String(e) }); }
    finally { setSubmitting(false); }
  };
  const cancel = async () => {
    wanted.current = null;
    acknowledged.current = false;
    if (operation) await modelsCancel(operation.id);
    setFailure(null);
  };
  const choose = (id: string) => void act(async () => {
    setPanel(null); setConfirmation(null);
    if (!id) { await cancel(); await modelsUnselect(family); return; }
    if (id === active?.id) { await cancel(); return; }
    const candidate = models.find(m => m.id === id);
    if (!candidate) return;
    await cancel();
    if (canSwitchModel(candidate)) await useModel({ id });
    else setPanel({ kind: "editor", id, mode: "prepare" });
  });
  const editor = panel?.kind === "editor" ? models.find(m => m.id === panel.id) : undefined;
  const confirmModel = models.find(m => m.id === confirmation?.id);
  const adding = panel?.kind === "add" || panel?.kind === "editor" && panel.mode === "new";
  const inlineEditor = editor && panel?.kind === "editor" && panel.mode !== "new";
  const renderEditor = () => editor && panel?.kind === "editor" && <ModelEditor key={[editor.id, panel.mode, panel.backend ?? editor.backend].join("-")} model={editor} name={name(editor)}
    operation={operation?.id === editor.id ? operation : undefined} submittingRequest={submitting}
    mode={panel.mode} backendOverride={panel.backend} onUse={useModel} onError={setDialogError}
    draft={operation?.id === editor.id ? wanted.current ?? undefined : undefined} onCancel={() => void act(cancel)} />;
  const actions = (m: ModelView) => <div className="settings-model-actions">
    <Button size="sm" variant="outline" aria-expanded={!!inlineEditor && editor.id === m.id} disabled={preparing}
      onClick={() => { setConfirmation(null); setPanel(inlineEditor && editor.id === m.id ? null : { kind: "editor", id: m.id, mode: m.active ? "edit" : "prepare" }); }}>{t("models.edit")}</Button>
    {(m.downloadedBytes ?? 0) > 0 && <Button size="sm" variant="ghost" disabled={submitting} onClick={() => setConfirmation({ id: m.id, action: "clear" })}>{t("models.clear_downloads")}</Button>}
    {m.custom && <Button size="sm" variant="ghost" disabled={submitting} onClick={() => setConfirmation({ id: m.id, action: "remove" })}>{t("models.remove")}</Button>}
  </div>;
  const confirm = (id: string) => confirmation?.id === id && confirmModel && <div className="settings-model-confirm" role="alert">
    <strong>{name(confirmModel)} · {t(confirmation.action === "clear" ? "models.clear_downloads" : "models.remove")}</strong>
    <p>{t(confirmation.action === "clear" ? "models.clear_hint" : "models.remove_hint")}</p>
    {confirmModel.active && <p>{t("models.active_remove_hint")}</p>}
    <div className="settings-model-actions"><Button size="sm" disabled={submitting} onClick={() => void act(async () => {
      await cancel();
      if (confirmation.action === "clear") await modelsClearDownloads(id); else await modelsRemoveCustom(id);
      setPanel(null); setConfirmation(null);
    })}>{t("models.confirm_remove")}</Button><Button size="sm" variant="ghost" onClick={() => setConfirmation(null)}>{t("models.cancel")}</Button></div>
  </div>;
  return <section className="settings-section settings-model-section">
    <p className="settings-blurb">{t(family === "speech" ? "settings.speech_blurb" : "settings.vlm_blurb")}</p>
    <div className="settings-model-selector">
      <span className="settings-slider-label">{t("models.current_label")}</span>
      <ModelPicker models={models} activeId={view.active[family]} disabled={submitting} preparing={preparing} onChoose={choose}
        onAdd={() => { setDialogError(""); setConfirmation(null); setPanel({ kind: "add" }); }} />
    </div>
    <p className="settings-toggle-hint">{t("models.switch_hint")}</p>
    <div className="settings-model-card settings-model-summary" data-testid="current-model-summary">
      {active ? <>
        <div className="settings-model-card-header"><strong>{name(active)}</strong><span className="settings-badge settings-badge-on">{t(active.locality === "local" ? "models.local" : "models.online")}</span></div>
        <p className="settings-model-state">{state(active)}{active.executionDevice === "cpu" ? ` · ${t("models.cpu_state")}` : ""}</p>
        {active.endpoint && <p className="settings-model-address">{active.endpoint.model} · {active.endpoint.url}</p>}
        {(active.downloadedBytes ?? 0) > 0 && <p className="settings-model-state">{modelSize(active.downloadedBytes!)}</p>}
        {actions(active)}
        {inlineEditor && editor.id === active.id && <div className="settings-model-inline-editor">{renderEditor()}</div>}
        {confirm(active.id)}
      </> : <><strong>{t("models.none_active")}</strong><p className="settings-toggle-hint">{t("models.empty_hint")}</p></>}
    </div>
    {inlineEditor && editor.id !== active?.id && <div className="settings-model-card settings-model-candidate">
      <strong>{t("models.setup_model", { name: name(editor) })}</strong>
      {actions(editor)}
      {renderEditor()}
      {confirm(editor.id)}
    </div>}
    {operation && !panel && <div className="settings-model-card" role="status">
      <p className="settings-model-state">{models.find(m => m.id === operation.id)?.name} · {t(`models.${operation.phase}`)}</p>
      {operation.error && <p className="settings-test-err" role="alert">{operation.error}</p>}
      <div className="settings-model-actions"><Button size="sm" onClick={() => setPanel({ kind: "editor", id: operation.id, mode: wanted.current?.createCustom ? "new" : wanted.current?.saveOnly ? "edit" : "prepare", ...(wanted.current?.backend ? { backend: wanted.current.backend } : {}) })}>{t("models.details")}</Button><Button size="sm" variant="ghost" onClick={() => void act(cancel)}>{t("models.cancel")}</Button></div>
    </div>}
    {!adding && dialogError && <p role="alert" className="settings-test-err">{dialogError}</p>}
    {adding && <AppDialog title={t("models.add_model")} panelClassName="settings-panel settings-model-dialog" dismissOnPointerOutside={false} onClose={() => { setPanel(null); setDialogError(""); }}>
      <div className="settings-model-dialog-body">
        <DialogDescription className="settings-toggle-hint">{t(panel?.kind === "add" ? "models.custom_type_hint" : "models.editor_hint")}</DialogDescription>
        {panel?.kind === "add" && <div className="settings-model-adapters">{adapters[family].map(a => <Button key={a.backend} variant="outline" onClick={() => setPanel({ kind: "editor", id: a.id, backend: a.backend, mode: "new" })}>{a.label}<span>{t(a.backend === "openai" || a.backend === "byo_endpoint" ? "models.online" : "models.local")}</span></Button>)}</div>}
        {renderEditor()}
        {dialogError && <p role="alert" className="settings-test-err">{dialogError}</p>}
      </div>
    </AppDialog>}
  </section>;
}
