import { AppMenuPositioner, AppPopoverPositioner } from "../components/PopupPositioner";
import { useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  PAUSE_PRESET_NAME_LIMIT, pausePresetNameKey, samePauseValues, validPauseValues,
  type PausePreset, type PausePresetChange, type PauseValues,
} from "../../shared/pause-presets";
import { Button } from "../components/ui/button";
import { refusalText } from "../errors/tryMutate";
import { setAppSettings, useAppSettingsLoaded, useAppSettingsStore } from "../settings/appSettingsStore";
import { InspectorRow } from "./InspectorRow";

export const PAUSE_BUILTINS = [
  { id: "speech", thresholdDb: -34, minMs: 500 },
  { id: "noisy", thresholdDb: -28, minMs: 800 },
  { id: "music", thresholdDb: -45, minMs: 1500 },
] as const;
const EMPTY_PRESETS: PausePreset[] = [];

export interface PausePresetSource {
  id: string;
  builtin: boolean;
  values: PauseValues;
}

export function inferPausePreset(values: PauseValues, presets: PausePreset[]): PausePresetSource | null {
  const personal = presets.find(p => samePauseValues(p, values));
  if (personal) return { id: personal.id, builtin: false, values: { ...values } };
  const builtin = PAUSE_BUILTINS.find(p => p.thresholdDb === values.thresholdDb && p.minMs === values.minMs);
  return builtin ? { id: builtin.id, builtin: true, values: { ...values } } : null;
}

/** Owns library editing only. Applying a recipe copies values into the project. */
export function PausePresetControl({ values, source, onSourceChange, onApply, disabled }: {
  values: PauseValues;
  source: PausePresetSource | null;
  onSourceChange: (source: PausePresetSource | null) => void;
  onApply: (values: PauseValues) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const presets = useAppSettingsStore(s => s.settings.pause_presets ?? EMPTY_PRESETS);
  const loaded = useAppSettingsLoaded();
  const [editor, setEditor] = useState<"save" | "manage" | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const pending = useRef(false);
  const personal = source && !source.builtin ? presets.find(p => p.id === source.id) : undefined;
  const active = source?.builtin || personal ? source : null;
  const modified = active !== null && !samePauseValues(values, personal ?? active.values);
  const label = active ? (active.builtin ? t(`pauses.preset_${active.id}`) : personal!.name) : t("pauses.preset_custom");
  const caption = modified ? t("pauses.preset_modified", { name: label }) : label;
  const duplicate = presets.some(p => p.id !== renameId && pausePresetNameKey(p.name) === pausePresetNameKey(name));
  const canSave = name.trim().length > 0 && !duplicate && (renameId !== null || validPauseValues(values));

  async function write(change: PausePresetChange, after: () => void): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await setAppSettings({ pause_preset_change: change });
      after();
    } catch (err) {
      setError(t("pauses.preset_save_failed", { reason: refusalText(err) }));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  function beginEditor(mode: "save" | "manage") {
    setError("");
    setNotice("");
    setRenameId(null);
    setName("");
    setEditor(mode);
  }

  function saveName() {
    if (!canSave) return;
    if (renameId !== null) {
      void write({ kind: "rename", id: renameId, name }, () => {
        setRenameId(null);
        setNotice(t("pauses.preset_saved"));
      });
    } else {
      const preset: PausePreset = { ...values, id: crypto.randomUUID(), name: name.trim() };
      void write({ kind: "create", preset }, () => {
        onSourceChange({ id: preset.id, builtin: false, values: { ...values } });
        setEditor(null);
        setNotice(t("pauses.preset_saved"));
      });
    }
  }

  return <>
    <InspectorRow label={t("pauses.preset")} reserveStopwatch>
      <Menu.Root>
        <Menu.Trigger ref={trigger} className="app-select pauses-preset-trigger" aria-label={t("pauses.preset")}
          title={caption} disabled={disabled || saving}>
          <span>{caption}</span><ChevronDown size={11} aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <AppMenuPositioner align="start" sideOffset={4} className="app-popup-positioner">
            <Menu.Popup className="app-menu-list pauses-preset-menu" finalFocus={editor === null}>
              <Menu.Group>
                <Menu.GroupLabel className="menu-heading">{t("pauses.presets_builtin")}</Menu.GroupLabel>
                {PAUSE_BUILTINS.map(p => <Menu.Item key={p.id} className="app-menu-item" onClick={() => {
                  const next = { thresholdDb: p.thresholdDb, minMs: p.minMs,
                    padMs: Math.min(values.padMs, Math.floor((p.minMs - 50) / 100) * 50) };
                  onSourceChange({ id: p.id, builtin: true, values: next });
                  onApply(next);
                }}>
                  <span className="app-menu-item-check">{active?.builtin && active.id === p.id && !modified && <Check size={12} aria-hidden />}</span>
                  <span className="app-menu-item-label">{t(`pauses.preset_${p.id}`)}</span>
                </Menu.Item>)}
              </Menu.Group>
              <Menu.Group>
                <Menu.GroupLabel className="menu-heading">{t("pauses.presets_personal")}</Menu.GroupLabel>
                {presets.map(p => <Menu.Item key={p.id} className="app-menu-item" onClick={() => {
                  const next = { thresholdDb: p.thresholdDb, minMs: p.minMs, padMs: p.padMs };
                  onSourceChange({ id: p.id, builtin: false, values: next });
                  onApply(next);
                }}>
                  <span className="app-menu-item-check">{personal?.id === p.id && !modified && <Check size={12} aria-hidden />}</span>
                  <span className="app-menu-item-label">{p.name}</span>
                </Menu.Item>)}
                {presets.length === 0 && <div className="pauses-preset-empty">{t(loaded ? "pauses.presets_empty" : "pauses.presets_loading")}</div>}
              </Menu.Group>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="app-menu-item" disabled={!loaded || !validPauseValues(values)} onClick={() => beginEditor("save")}>{t("pauses.preset_save_as")}</Menu.Item>
              {personal && modified && <Menu.Item className="app-menu-item" onClick={() => {
                void write({ kind: "update", id: personal.id, values }, () => {
                  onSourceChange({ id: personal.id, builtin: false, values: { ...values } });
                  setNotice(t("pauses.preset_saved"));
                });
              }}>{t("pauses.preset_update", { name: personal.name })}</Menu.Item>}
              <Menu.Item className="app-menu-item" disabled={!loaded} onClick={() => beginEditor("manage")}>{t("pauses.presets_manage")}</Menu.Item>
            </Menu.Popup>
          </AppMenuPositioner>
        </Menu.Portal>
      </Menu.Root>
    </InspectorRow>
    {editor === null && (error || notice) && <p className={error ? "settings-error" : "sr-only"} role={error ? "alert" : "status"}>{error || notice}</p>}
    <Popover.Root open={editor !== null} onOpenChange={open => { if (!open && !saving) setEditor(null); }}>
      <Popover.Portal>
        <AppPopoverPositioner anchor={trigger} align="start" sideOffset={4} className="app-popup-positioner">
          <Popover.Popup className="app-menu-list pauses-preset-editor" initialFocus={editor === "save" ? nameInput : undefined} finalFocus={trigger}>
            <Popover.Title className="pauses-editor-title">{t(editor === "save" ? "pauses.preset_save_as" : "pauses.presets_manage")}</Popover.Title>
            <Popover.Description className="pauses-editor-hint">{t("pauses.presets_scope")}</Popover.Description>
            {editor === "manage" && <div className="pauses-preset-list">
              {presets.length === 0 && <p className="pauses-editor-hint">{t("pauses.presets_empty")}</p>}
              {presets.map(p => <div className="pauses-preset-entry" key={p.id}>
                <span title={p.name}>{p.name}</span>
                <Button size="xs" variant="ghost" disabled={saving} aria-label={t("pauses.preset_rename_named", { name: p.name })}
                  onClick={() => { setRenameId(p.id); setName(p.name); setError(""); }}>{t("pauses.preset_rename")}</Button>
                <Button size="xs" variant="ghost" disabled={saving} aria-label={t("pauses.preset_delete_named", { name: p.name })}
                  onClick={() => void write({ kind: "delete", id: p.id }, () => {
                    if (active?.id === p.id && !active.builtin) onSourceChange(null);
                    if (renameId === p.id) setRenameId(null);
                    setNotice(t("pauses.preset_deleted", { name: p.name }));
                  })}>{t("pauses.preset_delete")}</Button>
              </div>)}
            </div>}
            {(editor === "save" || renameId !== null) && <form className="pauses-preset-form" onSubmit={event => { event.preventDefault(); saveName(); }}>
              <label><span>{t("pauses.preset_name")}</span>
                <input ref={nameInput} autoFocus={renameId !== null} className="app-input" maxLength={PAUSE_PRESET_NAME_LIMIT}
                  value={name} disabled={saving} onChange={event => setName(event.target.value)} aria-invalid={duplicate}
                  aria-describedby={duplicate ? "pause-preset-name-error" : undefined} />
              </label>
              {duplicate && <p id="pause-preset-name-error" className="settings-error">{t("pauses.preset_duplicate")}</p>}
              {editor === "save" && <p className="pauses-editor-hint">{t("pauses.preset_values", { ...values })}</p>}
              <div className="pauses-editor-actions">
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => { if (renameId !== null) setRenameId(null); else setEditor(null); }}>{t("pauses.preset_cancel")}</Button>
                <Button size="sm" type="submit" disabled={saving || !canSave}>{saving && <LoaderCircle size={12} className="pauses-spinner" aria-hidden />}{t("pauses.preset_save")}</Button>
              </div>
            </form>}
            {error && <p className="settings-error" role="alert">{error}</p>}
            {notice && <p className="pauses-editor-hint" role="status">{notice}</p>}
            {editor === "manage" && renameId === null && <div className="pauses-editor-actions"><Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditor(null)}>{t("pauses.preset_done")}</Button></div>}
          </Popover.Popup>
        </AppPopoverPositioner>
      </Popover.Portal>
    </Popover.Root>
  </>;
}
