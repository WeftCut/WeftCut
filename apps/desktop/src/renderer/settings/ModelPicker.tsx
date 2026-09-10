import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ModelView } from "../../shared/inference-models";

/** Local files can be checked immediately. A service's first use needs its
 * configuration and test-request notice before any network request is sent. */
export function canSwitchModel(model: ModelView): boolean {
  if (model.locality === "local") return model.installed && model.supported;
  return !!model.verified && (model.backend === "openai" ? model.hasKey : !!model.endpoint?.url && !!model.endpoint.model);
}

export function ModelPicker({ models, activeId, disabled, preparing, onChoose, onAdd }: {
  models: ModelView[];
  activeId: string | null;
  disabled: boolean;
  preparing: boolean;
  onChoose(id: string): void;
  onAdd(): void;
}) {
  const { t } = useTranslation();
  const name = (m: ModelView) => m.id === "vlm-online" ? t("models.online_model") : m.name;
  const host = (m: ModelView) => { try { return m.endpoint ? ` · ${new URL(m.endpoint.url).host}` : ""; } catch { return ""; } };
  const active = models.find(m => m.id === activeId);
  const status = (m: ModelView) => m.id === activeId ? t("models.current")
    : canSwitchModel(m) ? t("models.ready")
    : m.locality === "local" && !m.custom && m.missingBytes > 0 && m.supported ? t("models.needs_download")
    : t("models.needs_configuration");
  return <Menu.Root>
    <Menu.Trigger className="app-select settings-model-trigger" disabled={disabled} aria-label={t("models.current_label")}>
      <span>{active ? name(active) : t("models.none_selected")}</span>
      <ChevronDown size={11} aria-hidden="true" />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner align="start" sideOffset={4} className="app-popup-positioner">
        <Menu.Popup className="app-menu-list settings-model-menu">
          <div className="settings-model-menu-options">
            <Menu.RadioGroup value={activeId ?? ""}>
              <Menu.RadioItem value="" label={t("models.none_selected")} closeOnClick className="app-menu-item settings-model-option" onClick={() => onChoose("")}>
                <span className="app-menu-item-check" aria-hidden="true"><Menu.RadioItemIndicator><Check size={12} /></Menu.RadioItemIndicator></span>
                <span>{t("models.none_selected")}</span>
              </Menu.RadioItem>
              {models.map(m => <Menu.RadioItem key={m.id} value={m.id} label={name(m)} closeOnClick
                className="app-menu-item settings-model-option" onClick={() => onChoose(m.id)}>
                <span className="app-menu-item-check" aria-hidden="true"><Menu.RadioItemIndicator><Check size={12} /></Menu.RadioItemIndicator></span>
                <span className="settings-model-option-text"><span>{name(m)}</span>
                  <span className="settings-model-option-detail">{m.custom && `${t("models.custom")} · `}{t(m.locality === "local" ? "models.local" : "models.online")}{host(m)}</span>
                </span>
                <span className="settings-model-option-state">{status(m)}</span>
              </Menu.RadioItem>)}
            </Menu.RadioGroup>
          </div>
          <Menu.Separator className="menu-separator" />
          <Menu.Item className="app-menu-item" disabled={preparing} onClick={onAdd}><Plus size={12} />{t("models.add_model")}</Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
