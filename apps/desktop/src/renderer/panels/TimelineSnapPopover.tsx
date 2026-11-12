import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  TAIL_SNAP_STRENGTH_MAX_PX,
  TAIL_SNAP_STRENGTH_MIN_PX,
} from "../../shared/app-settings";
import { AppIcon } from "../components/AppIcon";
import { AppNumberField } from "../components/AppNumberField";
import { AppSwitch } from "../components/AppSwitch";
import { AppPopoverPositioner } from "../components/PopupPositioner";
import {
  setAppSettings,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "../settings/appSettingsStore";
import type { StripOrientation } from "./QuickActionsPanel";

/** Split magnet: the magnet itself stays a one-click toggle; its adjacent
 * chevron reveals the existing timeline snap preferences, not canvas settings. */
export function TimelineSnapPopover({
  orientation, tabbable, onFocus,
}: {
  orientation: StripOrientation;
  tabbable: boolean;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const enabled = useTailSnapEnabled();
  const strength = useTailSnapStrengthPx();
  const [draft, setDraft] = useState(strength);
  const [error, setError] = useState("");
  useEffect(() => setDraft(strength), [strength]);

  const save = async (patch: { tail_snap_enabled?: boolean; tail_snap_strength_px?: number }) => {
    setError("");
    try {
      await setAppSettings(patch);
    } catch (cause) {
      setError(String(cause));
      setDraft(strength);
    }
  };

  const label = t("quick_actions.timeline_snap_options");
  return (
    <Popover.Root onOpenChange={() => setError("")}>
      <Popover.Trigger
        className="weft-quick-action timeline-snap-options-trigger"
        data-quick-action="timelineSnapOptions"
        aria-label={label}
        title={label}
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
      >
        <AppIcon icon={ChevronDown} size="body" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <AppPopoverPositioner
          className="app-popup-positioner"
          side={orientation === "vertical" ? "right" : "top"}
          align="start"
          sideOffset={4}
        >
          <Popover.Popup className="app-menu-list timeline-snap-popup">
            <Popover.Title className="timeline-snap-popup-title">{label}</Popover.Title>
            <label className="settings-toggle-row">
              <AppSwitch
                checked={enabled}
                ariaLabel={t("settings.tail_snap_enabled")}
                onCheckedChange={(next) => void save({ tail_snap_enabled: next })}
              />
              <span className="settings-toggle-label">{t("settings.tail_snap_enabled")}</span>
            </label>
            <div className="settings-slider-row">
              <span className="settings-slider-label">{t("settings.tail_snap_strength")}</span>
              <AppNumberField
                value={draft}
                min={TAIL_SNAP_STRENGTH_MIN_PX}
                max={TAIL_SNAP_STRENGTH_MAX_PX}
                disabled={!enabled}
                onValueChange={setDraft}
                onCommit={(value) => void save({ tail_snap_strength_px: Math.round(value) })}
                ariaLabel={t("settings.tail_snap_strength")}
                className="settings-input-narrow"
              />
              <span className="settings-slider-unit">px</span>
            </div>
            <p className="settings-toggle-hint">{t("quick_actions.timeline_snap_ctrl_hint")}</p>
            {error && <p className="settings-error" role="alert">{error}</p>}
          </Popover.Popup>
        </AppPopoverPositioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
